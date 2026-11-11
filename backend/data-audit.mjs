/**
 * 数据严谨性核验（只读）
 *
 * 设计原则：
 *  1) 不复用业务函数：所有金额用独立 SQL 重新算一遍，避免「同一个 bug 既产生又校验」。
 *  2) 关键指标双重重算：两套不同写法的 SQL 必须得出同一结果。
 *  3) 每项检查都有明确级别（error / warn）与可复核的明细。
 *  4) 输出稳定快照哈希，可做多轮一致性比对与变动前后对比。
 *
 * 用法（CLI）：node tools/data-audit.mjs [--db <path>] [--base <url>] [--rounds 3]
 *             [--expect-clean] [--out <json>] [--compare <snapshot.json>]
 * 用法（代码）：import { runAudit } from './backend/data-audit.mjs'
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_TABLES = [
  'users', 'sessions', 'sets', 'subjects', 'vouchers', 'voucher_entries',
  'closings', 'open_tokens', 'roles',
];
const VALID_STATUS = ['draft', 'reviewed', 'posted', 'void', 'reversed'];
const MONEY_EPS = 0.005; // 元，允许的分级误差（以分为最小单位）

function item(name, ok, detail, level = 'error') {
  return { name, ok: Boolean(ok), level: ok ? 'pass' : level, detail: String(detail ?? '') };
}
function isMoney(n) {
  return Number.isFinite(n) && n >= 0 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function periodOf(date) { return String(date || '').slice(0, 7); }

/** 独立算法 A：按业务口径逐科目判类汇总（与 biz.dashboardMetrics 同口径，但独立实现） */
export function recomputeMetrics(db, setId, period) {
  const rows = db.prepare(`
    SELECT e.subject_code AS code, SUM(e.debit) AS debit, SUM(e.credit) AS credit
    FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
    WHERE v.set_id = ? AND v.period = ? AND v.status != 'void'
    GROUP BY e.subject_code`).all(setId, period);
  const m = { revenue: 0, cost: 0, expense: 0, profit: 0, capital: 0, ar: 0, ap: 0, tax: 0 };
  for (const r of rows) {
    const code = String(r.code || '');
    const net = (r.debit || 0) - (r.credit || 0);
    if (/^(6001|6041|6051|6101|6111|6115|6117|6301)/.test(code)) m.revenue += (r.credit || 0) - (r.debit || 0);
    else if (/^64/.test(code)) m.cost += net;
    else if (/^(66|68)/.test(code)) m.expense += net;
    if (/^(1001|1002|1012)/.test(code)) m.capital += net;
    if (/^(1121|1122)/.test(code)) m.ar += net;
    if (/^2202/.test(code)) m.ap += -net;
    if (/^2221/.test(code)) m.tax += -net;
  }
  m.profit = m.revenue - m.cost - m.expense;
  for (const k of Object.keys(m)) m[k] = round2(m[k]);
  return m;
}

/** 独立算法 B：用 CASE WHEN 一次性聚合，写法不同，用于交叉验证算法 A */
function recomputeMetricsAlt(db, setId, period) {
  const r = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN e.subject_code LIKE '6001%' OR e.subject_code LIKE '6041%'
        OR e.subject_code LIKE '6051%' OR e.subject_code LIKE '61%' OR e.subject_code LIKE '6301%'
        THEN e.credit - e.debit ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN e.subject_code LIKE '64%' THEN e.debit - e.credit ELSE 0 END), 0) AS cost,
      COALESCE(SUM(CASE WHEN e.subject_code LIKE '66%' OR e.subject_code LIKE '68%'
        THEN e.debit - e.credit ELSE 0 END), 0) AS expense,
      COALESCE(SUM(CASE WHEN e.subject_code IN ('1001','1002','1012') OR e.subject_code LIKE '1002%'
        THEN e.debit - e.credit ELSE 0 END), 0) AS capital,
      COALESCE(SUM(CASE WHEN e.subject_code LIKE '1121%' OR e.subject_code LIKE '1122%'
        THEN e.debit - e.credit ELSE 0 END), 0) AS ar,
      COALESCE(SUM(CASE WHEN e.subject_code LIKE '2202%' THEN e.credit - e.debit ELSE 0 END), 0) AS ap,
      COALESCE(SUM(CASE WHEN e.subject_code LIKE '2221%' THEN e.credit - e.debit ELSE 0 END), 0) AS tax
    FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
    WHERE v.set_id = ? AND v.period = ? AND v.status != 'void'`).get(setId, period);
  const out = {};
  for (const k of ['revenue', 'cost', 'expense', 'capital', 'ar', 'ap', 'tax']) out[k] = round2(r[k]);
  out.profit = round2(out.revenue - out.cost - out.expense);
  return out;
}

/** 前端金额单位静态检查：本地后端统一返回「元」，前端不得再按「分」多除 100 */
function checkFrontendUnits() {
  const dir = path.join(ROOT, 'upstream', 'assets');
  if (!fs.existsSync(dir)) return item('前端金额单位换算', true, '跳过（无前端目录）', 'warn');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    // Math.trunc(x/1e4)/100 是「分 → 万」的旧云端契约；本地返回「元」会缩小 100 倍
    if (/Math\.trunc\([^;]{0,80}?\/1e4\)\/100/.test(s)) bad.push(f);
  }
  return item('前端金额单位换算（元，无多除 100）', bad.length === 0,
    bad.length ? `仍按「分」换算的文件：${bad.join(', ')}` : '全部 chunk 已按「元」换算');
}

/**
 * 执行一轮完整核验。
 * @param {DatabaseSync} db 只读打开的库
 * @param {object} opts { setId, period, expectClean, apiOverview }
 */
export function runAudit(db, opts = {}) {
  const setId = Number(opts.setId || 85);
  const period = String(opts.period || new Date().toISOString().slice(0, 7));
  const checks = [];
  const q = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  // --- A 结构 ---
  const tables = q("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
  checks.push(item('必需数据表齐全', missing.length === 0,
    missing.length ? `缺失：${missing.join(', ')}` : `${REQUIRED_TABLES.length} 张核心表存在`));

  const counts = {};
  for (const t of ['sets', 'users', 'subjects', 'vouchers', 'voucher_entries', 'closings',
    'sessions', 'agent_sessions', 'agent_messages', 'agent_attachments',
    'agent_clarify', 'agent_clarify_prefs', 'open_tokens']) {
    counts[t] = tables.includes(t) ? one(`SELECT COUNT(*) AS n FROM ${t}`).n : -1;
  }

  // --- B 凭证与分录完整性 ---
  const vouchers = q('SELECT * FROM vouchers ORDER BY id');
  const entries = q('SELECT * FROM voucher_entries ORDER BY voucher_id, line');

  const unbalanced = q(`
    SELECT v.id, v.no, COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c
    FROM vouchers v LEFT JOIN voucher_entries e ON e.voucher_id = v.id
    GROUP BY v.id HAVING ABS(d - c) > ${MONEY_EPS} OR d <= 0`);
  checks.push(item('逐张凭证借贷平衡且金额大于 0', unbalanced.length === 0,
    unbalanced.length ? `异常凭证：${unbalanced.map((v) => `#${v.id}(借${v.d}/贷${v.c})`).join(' ')}`
      : `${vouchers.length} 张凭证全部平衡`));

  const bothSides = entries.filter((e) => (e.debit || 0) > 0 && (e.credit || 0) > 0);
  checks.push(item('单行分录不同时记借贷', bothSides.length === 0,
    bothSides.length ? `异常 ${bothSides.length} 行：${bothSides.slice(0, 3).map((e) => `v${e.voucher_id}/l${e.line}`).join(' ')}` : `${entries.length} 行分录合规`));

  const badMoney = entries.filter((e) => !isMoney(e.debit) || !isMoney(e.credit));
  checks.push(item('金额精度（非负、最多两位小数）', badMoney.length === 0,
    badMoney.length ? `异常 ${badMoney.length} 行` : '全部金额以分为最小单位且非负'));

  const orphan = q('SELECT e.id, e.voucher_id FROM voucher_entries e LEFT JOIN vouchers v ON v.id = e.voucher_id WHERE v.id IS NULL');
  checks.push(item('无孤儿分录', orphan.length === 0, orphan.length ? `孤儿 ${orphan.length} 行` : '分录均关联到有效凭证'));

  const empty = q('SELECT v.id FROM vouchers v LEFT JOIN voucher_entries e ON e.voucher_id = v.id GROUP BY v.id HAVING COUNT(e.id) = 0');
  checks.push(item('无空凭证', empty.length === 0, empty.length ? `空凭证：${empty.map((v) => `#${v.id}`).join(' ')}` : '每张凭证至少 2 行'));
  const tooFew = q('SELECT voucher_id, COUNT(*) AS n FROM voucher_entries GROUP BY voucher_id HAVING n < 2');
  checks.push(item('每张凭证至少两条分录', tooFew.length === 0,
    tooFew.length ? `不足：${tooFew.map((x) => `v${x.voucher_id}(${x.n}行)`).join(' ')}` : '分录条数合规'));

  const dupNo = q(`SELECT set_id, period, word, no, COUNT(*) AS n FROM vouchers
    GROUP BY set_id, period, word, no HAVING n > 1`);
  checks.push(item('凭证号在账套+期间+字内唯一', dupNo.length === 0,
    dupNo.length ? `重复：${dupNo.map((x) => `${x.period}/${x.word}-${x.no}×${x.n}`).join(' ')}` : '无重复凭证号'));

  const badPeriod = vouchers.filter((v) => periodOf(v.date) !== v.period);
  checks.push(item('凭证日期与会计期间一致', badPeriod.length === 0,
    badPeriod.length ? `不一致：${badPeriod.map((v) => `#${v.id} ${v.date}/${v.period}`).join(' ')}` : '期间与日期一致'));

  const badStatus = vouchers.filter((v) => !VALID_STATUS.includes(v.status));
  checks.push(item('凭证状态合法', badStatus.length === 0,
    badStatus.length ? `未知状态：${[...new Set(badStatus.map((v) => v.status))].join(', ')}` : '状态取值合法'));

  const subjectCodes = new Set(q('SELECT code FROM subjects').map((r) => String(r.code)));
  const badSubject = entries.filter((e) => !subjectCodes.has(String(e.subject_code)));
  checks.push(item('分录科目代码存在于科目表', badSubject.length === 0,
    badSubject.length ? `未知科目：${[...new Set(badSubject.map((e) => e.subject_code))].slice(0, 8).join(', ')}` : `科目表 ${subjectCodes.size} 个代码，分录全部命中`));

  // --- C 双重独立重算 ---
  const m1 = recomputeMetrics(db, setId, period);
  const m2 = recomputeMetricsAlt(db, setId, period);
  const diff = Object.keys(m1).filter((k) => Math.abs(m1[k] - m2[k]) > MONEY_EPS);
  checks.push(item('两套独立 SQL 重算指标一致', diff.length === 0,
    diff.length ? `不一致字段：${diff.map((k) => `${k} ${m1[k]} vs ${m2[k]}`).join('; ')}` : JSON.stringify(m1)));

  const rawTotals = one(`SELECT COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE v.set_id=? AND v.period=? AND v.status!='void'`, setId, period);
  checks.push(item('全期借方合计 = 贷方合计', Math.abs(rawTotals.d - rawTotals.c) <= MONEY_EPS,
    `借 ${round2(rawTotals.d)} / 贷 ${round2(rawTotals.c)} 元`));

  // 与 HTTP 接口交叉核验（可选）
  if (opts.apiOverview) {
    const api = opts.apiOverview;
    const cur = (api.months || []).find((x) => x.period === period) || {};
    // 只比对接口确实返回的字段；overview 不含 capital/tax，那两项由分项接口负责。
    const comparable = Object.keys(m1).filter((k) => k in cur);
    const mismatch = comparable.filter((k) => Math.abs((cur[k] ?? 0) - m1[k]) > MONEY_EPS);
    checks.push(item('看板接口数值 = 数据库独立重算', mismatch.length === 0,
      mismatch.length ? `不一致：${mismatch.map((k) => `${k} api=${cur[k]} db=${m1[k]}`).join('; ')}` : '接口与库内明细一致'));
  }

  // --- D 单位与代码契约 ---
  checks.push(checkFrontendUnits());

  // --- E 测试痕迹 ---
  const testLike = vouchers.filter((v) => /smoke|test|测试|demo|回归|验证/i.test(`${v.creator} ${v.summary || ''}`));
  checks.push(item('无测试痕迹凭证', testLike.length === 0,
    testLike.length ? `疑似 ${testLike.length} 张：${testLike.map((v) => `#${v.id}(${v.creator})`).join(' ')}` : '未发现测试特征凭证', 'warn'));

  if (opts.expectClean) {
    const clean = counts.vouchers === 0 && counts.voucher_entries === 0
      && Object.values(m1).every((v) => Math.abs(v) < MONEY_EPS);
    checks.push(item('干净基线：无业务凭证且看板全零', clean,
      `凭证 ${counts.vouchers} 张 / 分录 ${counts.voucher_entries} 行 / 指标 ${JSON.stringify(m1)}`));
  }

  // --- 稳定快照（用于多轮一致性与变动前后对比） ---
  const snapshot = {
    counts,
    metrics: m1,
    totals: { debit: round2(rawTotals.d), credit: round2(rawTotals.c) },
    setNames: q('SELECT id, name FROM sets ORDER BY id'),
    subjectCount: subjectCodes.size,
  };
  const snapshotHash = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16);
  const errors = checks.filter((c) => !c.ok && c.level === 'error');
  const warns = checks.filter((c) => !c.ok && c.level === 'warn');

  return {
    at: new Date().toISOString(), period, setId,
    passed: checks.filter((c) => c.ok).length, total: checks.length,
    error_count: errors.length, warn_count: warns.length,
    ok: errors.length === 0, checks, snapshot, snapshotHash,
  };
}

/** 多轮核验：连续 N 轮结果必须逐字一致，任何并发写入/非确定性都会被抓出来 */
export function runAuditMulti(db, opts = {}, rounds = 3) {
  const n = Math.max(1, Math.min(10, Number(rounds) || 1));
  const list = [];
  for (let i = 0; i < n; i++) list.push(runAudit(db, opts));
  const sig = (r) => JSON.stringify({ h: r.snapshotHash, c: r.checks.map((c) => [c.name, c.ok, c.level, c.detail]) });
  const consistent = list.every((r) => sig(r) === sig(list[0]));
  const final = list[list.length - 1];
  return {
    ...final, rounds: n, consistent,
    history: list.map((r) => r.snapshotHash),
    ok: final.ok && consistent,
  };
}
