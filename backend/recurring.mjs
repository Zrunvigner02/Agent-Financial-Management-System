/**
 * 固定支出（周期性凭证）
 * - 模板：工资 / 房租 / 社保 / 水电等每月重复的分录，一次建好，长期使用
 * - 生成：当月第一次被触发时，按模板生成草稿凭证（幂等，一个模板一个月只生成一张）
 * - 单月覆盖：某个月金额变了，只改这个月，不动模板
 * - 提醒：每月第一次交互时给一句话摘要，问要不要调整
 *
 * 只写 vouchers / voucher_entries 的草稿，不做审核、不做记账；不碰历史凭证。
 */
import { db, get, all, run, now } from './store.mjs';
import * as tags from './tags.mjs';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ok = (data, message = '') => ({ code: 0, message, data });
const fail = (message) => ({ code: 1, message, data: null });

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const isMoney = (v) => Number.isFinite(Number(v)) && Number(v) >= 0
  && Math.abs(Number(v) * 100 - Math.round(Number(v) * 100)) < 1e-6;

const monthDays = (period) => new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate();

const CATEGORY_DEFAULT = {
  工资: { summary: '计提/发放工资', lines: [['6602', '借'], ['2211', '贷']] },
  社保: { summary: '缴纳社保', lines: [['6602', '借'], ['1002', '贷']] },
  公积金: { summary: '缴纳公积金', lines: [['6602', '借'], ['1002', '贷']] },
  房租: { summary: '支付房租', lines: [['6602', '借'], ['1002', '贷']] },
  水电: { summary: '支付水电费', lines: [['6602', '借'], ['1002', '贷']] },
  物业: { summary: '支付物业费', lines: [['6602', '借'], ['1002', '贷']] },
};

function subjectExists(setId, code) {
  return Boolean(get('SELECT 1 FROM subjects WHERE set_id = ? AND code = ?', setId, String(code || '')));
}
function subjectName(setId, code) {
  return get('SELECT name FROM subjects WHERE set_id = ? AND code = ?', setId, String(code || ''))?.name || '';
}

/** 校验并规范化分录：至少两条、科目存在、金额合法、借贷平衡 */
export function normalizeEntries(setId, entries) {
  const list = (Array.isArray(entries) ? entries : []).map((e) => ({
    summary: String(e.summary || '').slice(0, 60),
    subject_code: String(e.subject_code || e.code || '').trim(),
    debit: money(e.debit || 0),
    credit: money(e.credit || 0),
  }));
  if (list.length < 2) return { ok: false, message: '固定支出至少要有两条分录（一借一贷）' };
  for (const [i, e] of list.entries()) {
    if (!e.subject_code) return { ok: false, message: `第 ${i + 1} 行缺少科目编码` };
    if (!subjectExists(setId, e.subject_code)) return { ok: false, message: `第 ${i + 1} 行科目不存在：${e.subject_code}` };
    if (!isMoney(e.debit) || !isMoney(e.credit)) return { ok: false, message: `第 ${i + 1} 行金额非法（非负、最多两位小数）` };
    if (e.debit > 0 && e.credit > 0) return { ok: false, message: `第 ${i + 1} 行不能同时填借方和贷方` };
  }
  const d = money(list.reduce((s, e) => s + e.debit, 0));
  const c = money(list.reduce((s, e) => s + e.credit, 0));
  if (d <= 0) return { ok: false, message: '金额必须大于 0' };
  if (Math.abs(d - c) > 0.005) return { ok: false, message: `借贷不平衡：借 ${d}，贷 ${c}` };
  return { ok: true, entries: list, amount: d };
}

const parseEntries = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};

const amountOf = (entries) => money(entries.reduce((s, e) => s + Number(e.debit || 0), 0));

/* ---------------- 模板 ---------------- */

export function listTemplates(setId, { activeOnly = false } = {}) {
  const rows = activeOnly
    ? all('SELECT * FROM recurring_templates WHERE set_id = ? AND active = 1 ORDER BY id', setId)
    : all('SELECT * FROM recurring_templates WHERE set_id = ? ORDER BY active DESC, id', setId);
  const tagMap = tags.tagMap(setId, 'recurring');
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    person: r.person || '',
    category: r.category || '',
    tags: tagMap.get(r.id) || {},
    resigned_from: (tagMap.get(r.id) || {})['离职'] || '',
    entries: parseEntries(r.entries),
    amount: amountOf(parseEntries(r.entries)),
    day: Number(r.day || 1),
    start_period: r.start_period || '',
    end_period: r.end_period || '',
    active: Number(r.active) === 1,
    note: r.note || '',
    updated_at: r.updated_at,
  }));
}

export function saveTemplate(setId, data = {}, user = '') {
  const name = String(data.name || '').trim();
  if (!name) return fail('固定支出要给个名字，比如「工资」「房租」');
  let entries = data.entries;
  if (!entries && data.category && CATEGORY_DEFAULT[data.category]) {
    const d = CATEGORY_DEFAULT[data.category];
    const amt = money(data.amount || 0);
    if (amt <= 0) return fail('请给出金额');
    entries = d.lines.map(([code, side]) => ({
      summary: d.summary, subject_code: code,
      debit: side === '借' ? amt : 0, credit: side === '贷' ? amt : 0,
    }));
  }
  const norm = normalizeEntries(setId, entries);
  if (!norm.ok) return fail(norm.message);

  const day = Math.min(31, Math.max(1, Number(data.day || 1)));
  const start = data.start_period && PERIOD_RE.test(data.start_period) ? data.start_period : '';
  const end = data.end_period && PERIOD_RE.test(data.end_period) ? data.end_period : '';
  if (start && end && end < start) return fail('结束月份不能早于开始月份');

  if (data.id) {
    const row = get('SELECT * FROM recurring_templates WHERE id = ? AND set_id = ?', Number(data.id), setId);
    if (!row) return fail('固定支出不存在');
    run(`UPDATE recurring_templates SET name=?, category=?, person=?, entries=?, day=?, start_period=?, end_period=?, note=?, updated_at=?
         WHERE id=? AND set_id=?`,
      name, String(data.category || row.category || ''), String(data.person ?? row.person ?? ''),
      JSON.stringify(norm.entries), day,
      start || row.start_period || '', end, String(data.note || row.note || ''), now(), Number(data.id), setId);
    return ok({ id: Number(data.id), amount: norm.amount }, `已更新「${name}」`);
  }

  const info = run(`INSERT INTO recurring_templates
    (set_id, name, category, person, entries, day, start_period, end_period, active, note, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    setId, name, String(data.category || ''), String(data.person || ''), JSON.stringify(norm.entries), day,
    start, end, String(data.note || ''), String(user || ''), now(), now());
  return ok({ id: Number(info.lastInsertRowid), amount: norm.amount }, `已建立固定支出「${name}」，每月 ${amountOf(norm.entries)} 元`);
}

export function setTemplateActive(setId, id, active) {
  const row = get('SELECT * FROM recurring_templates WHERE id = ? AND set_id = ?', Number(id), setId);
  if (!row) return fail('固定支出不存在');
  run('UPDATE recurring_templates SET active = ?, updated_at = ? WHERE id = ?', active ? 1 : 0, now(), Number(id));
  return ok({ id: Number(id), active: Boolean(active) }, active ? '已启用' : '已停用（历史凭证保留）');
}

export function removeTemplate(setId, id) {
  const row = get('SELECT * FROM recurring_templates WHERE id = ? AND set_id = ?', Number(id), setId);
  if (!row) return fail('固定支出不存在');
  const used = get('SELECT COUNT(*) AS n FROM recurring_runs WHERE template_id = ?', Number(id));
  if (Number(used?.n || 0) > 0) {
    // 已经生成过凭证 → 只停用，保留可追溯
    run('UPDATE recurring_templates SET active = 0, updated_at = ? WHERE id = ?', now(), Number(id));
    return ok({ id: Number(id), active: false }, '该固定支出已生成过凭证，改为停用，历史记录保留');
  }
  run('DELETE FROM recurring_overrides WHERE template_id = ?', Number(id));
  run('DELETE FROM recurring_templates WHERE id = ?', Number(id));
  return ok({ id: Number(id) }, '已删除');
}

/* ---------------- 单月覆盖 ---------------- */

export function setOverride(setId, id, period, entries, reason = '') {
  if (!PERIOD_RE.test(period || '')) return fail('月份格式应为 YYYY-MM');
  const tpl = get('SELECT * FROM recurring_templates WHERE id = ? AND set_id = ?', Number(id), setId);
  if (!tpl) return fail('固定支出不存在');
  const norm = normalizeEntries(setId, entries);
  if (!norm.ok) return fail(norm.message);
  run(`INSERT INTO recurring_overrides (template_id, period, entries, reason, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(template_id, period) DO UPDATE SET entries = excluded.entries, reason = excluded.reason, created_at = excluded.created_at`,
    Number(id), period, JSON.stringify(norm.entries), String(reason || ''), now());
  return ok({ id: Number(id), period, amount: norm.amount }, `${period} 的「${tpl.name}」已改为 ${norm.amount} 元`);
}

export function dropOverride(id, period) {
  run('DELETE FROM recurring_overrides WHERE template_id = ? AND period = ?', Number(id), String(period || ''));
  return ok(null, '已恢复按模板金额');
}

const overrideOf = (id, period) => {
  const row = get('SELECT * FROM recurring_overrides WHERE template_id = ? AND period = ?', id, period);
  return row ? parseEntries(row.entries) : null;
};

/* ---------------- 生成凭证 ---------------- */

function createDraftVoucher(setId, period, date, entries, user, tag) {
  const word = '记';
  const next = get('SELECT COALESCE(MAX(no), 0) AS m FROM vouchers WHERE set_id = ? AND period = ? AND word = ?', setId, period, word).m + 1;
  const head = entries[0] || {};
  const info = run(`INSERT INTO vouchers (set_id, period, date, word, no, status, creator, created_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`, setId, period, date, word, next, user || 'auto', now());
  const vid = Number(info.lastInsertRowid);
  const stmt = db.prepare(`INSERT INTO voucher_entries (voucher_id, line, summary, subject_code, subject_name, debit, credit, aux)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  entries.forEach((e, i) => {
    stmt.run(vid, i + 1, e.summary || head.summary || tag || '固定支出',
      String(e.subject_code), subjectName(setId, e.subject_code),
      money(e.debit), money(e.credit), '{}');
  });
  return vid;
}

function deleteDraft(setId, voucherId) {
  const v = get('SELECT * FROM vouchers WHERE id = ? AND set_id = ?', voucherId, setId);
  if (!v || v.status !== 'draft') return false;
  run('DELETE FROM voucher_entries WHERE voucher_id = ?', voucherId);
  run('DELETE FROM vouchers WHERE id = ?', voucherId);
  return true;
}

function inRange(tpl, period) {
  if (!tpl.active) return false;
  // 离职：自离职月份起不再生成（历史月份仍可在凭证里查到）
  if (tpl.resigned_from && period >= tpl.resigned_from) return false;
  if (tpl.start_period && period < tpl.start_period) return false;
  if (tpl.end_period && period > tpl.end_period) return false;
  return true;
}

/** 生成当月缺失的固定支出凭证（幂等） */
export function generateForPeriod(setId, period, user = 'auto') {
  if (!PERIOD_RE.test(period || '')) return fail('月份格式应为 YYYY-MM');
  const created = [];
  const skipped = [];
  for (const tpl of listTemplates(setId)) {
    if (!inRange(tpl, period)) continue;
    const ran = get('SELECT * FROM recurring_runs WHERE template_id = ? AND period = ?', tpl.id, period);
    if (ran) { skipped.push({ id: tpl.id, name: tpl.name, reason: '本月已生成' }); continue; }
    const entries = overrideOf(tpl.id, period) || tpl.entries;
    const norm = normalizeEntries(setId, entries);
    if (!norm.ok) { skipped.push({ id: tpl.id, name: tpl.name, reason: norm.message }); continue; }
    const day = Math.min(tpl.day, monthDays(period));
    const date = `${period}-${String(day).padStart(2, '0')}`;
    const vid = createDraftVoucher(setId, period, date, norm.entries, user, tpl.name);
    run(`INSERT INTO recurring_runs (template_id, set_id, period, voucher_id, amount, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'auto', ?)`, tpl.id, setId, period, vid, norm.amount, now());
    created.push({ id: tpl.id, name: tpl.name, voucher_id: vid, amount: norm.amount });
  }
  return ok({ period, created, skipped }, created.length ? `已生成 ${created.length} 张固定支出凭证（草稿）` : '本月无需生成');
}

/* ---------------- 本月变动：直接改当月 ---------------- */

export function adjustThisMonth(setId, period, id, entries, user = 'auto') {
  if (!PERIOD_RE.test(period || '')) return fail('月份格式应为 YYYY-MM');
  const tpl = get('SELECT * FROM recurring_templates WHERE id = ? AND set_id = ?', Number(id), setId);
  if (!tpl) return fail('固定支出不存在');
  const norm = normalizeEntries(setId, entries);
  if (!norm.ok) return fail(norm.message);

  const ran = get('SELECT * FROM recurring_runs WHERE template_id = ? AND period = ?', Number(id), period);
  if (ran?.voucher_id) {
    const v = get('SELECT * FROM vouchers WHERE id = ?', ran.voucher_id);
    if (!v) { /* 凭证已被删除，走重新生成 */ }
    else if (v.status !== 'draft') {
      return fail(`本月「${tpl.name}」凭证已${v.status === 'posted' ? '记账' : '审核'}，不能再改；如需调整请先反记账或红冲`);
    } else {
      deleteDraft(setId, ran.voucher_id);
    }
  }
  const day = Math.min(Number(tpl.day || 1), monthDays(period));
  const vid = createDraftVoucher(setId, period, `${period}-${String(day).padStart(2, '0')}`, norm.entries, user, tpl.name);
  if (ran) {
    run('UPDATE recurring_runs SET voucher_id = ?, amount = ?, source = ?, created_at = ? WHERE template_id = ? AND period = ?',
      vid, norm.amount, 'manual', now(), Number(id), period);
  } else {
    run(`INSERT INTO recurring_runs (template_id, set_id, period, voucher_id, amount, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?)`, Number(id), setId, period, vid, norm.amount, now());
  }
  // 本月变动同时留覆盖，避免同日再次生成回退成原金额
  setOverride(setId, id, period, norm.entries, '本月调整');
  return ok({ id: Number(id), period, voucher_id: vid, amount: norm.amount }, `本月「${tpl.name}」已改为 ${norm.amount} 元（凭证已更新，仍是草稿）`);
}

/* ---------------- 汇总 / 提醒 ---------------- */

export function plan(setId, period) {
  if (!PERIOD_RE.test(period || '')) return fail('月份格式应为 YYYY-MM');
  const templates = listTemplates(setId).filter((t) => inRange(t, period)).map((t) => {
    const ov = overrideOf(t.id, period);
    const entries = ov || t.entries;
    const ran = get('SELECT * FROM recurring_runs WHERE template_id = ? AND period = ?', t.id, period);
    const voucher = ran?.voucher_id ? get('SELECT id, status, no FROM vouchers WHERE id = ?', ran.voucher_id) : null;
    return {
      id: t.id, name: t.name, person: t.person, category: t.category,
      tags: t.tags, resigned_from: t.resigned_from,
      amount: amountOf(entries), base_amount: t.amount,
      overridden: Boolean(ov),
      generated: Boolean(ran),
      voucher_id: voucher?.id || null,
      voucher_status: voucher?.status || '',
      voucher_no: voucher?.no || null,
    };
  });
  const total = money(templates.reduce((s, t) => s + t.amount, 0));
  const generatedTotal = money(templates.filter((t) => t.generated).reduce((s, t) => s + t.amount, 0));
  return ok({
    period, templates, total,
    count: templates.length,
    generated: templates.filter((t) => t.generated).length,
    pending: templates.filter((t) => !t.generated).length,
    generated_total: generatedTotal,
  });
}

const stateKey = (setId, period) => `recurring_notice:${setId}:${period}`;
const stateGet = (k) => get('SELECT v FROM app_state WHERE k = ?', k)?.v || '';
const stateSet = (k, v) => run(`INSERT INTO app_state (k, v, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`, k, v, now());

/** 提醒文案：首次交互调用时生成当月凭证并给出摘要 */
export function reminder(setId, period, { mark = false, auto = true } = {}) {
  if (!PERIOD_RE.test(period || '')) return fail('月份格式应为 YYYY-MM');
  if (auto) generateForPeriod(setId, period, 'auto');
  const p = plan(setId, period).data;
  const key = stateKey(setId, period);
  const already = Boolean(stateGet(key));

  let text;
  if (!p.count) {
    text = `本月还没有设置固定支出（工资、房租、社保、水电等）。要现在建吗？（1 建，2 以后再说）`;
  } else {
    const detail = p.templates.map((t) => `${t.name} ${t.amount.toFixed(2)}${t.overridden ? '（本月已调）' : ''}`).join('、');
    text = `本月固定支出 ${p.count} 项，合计 ${p.total.toFixed(2)} 元：${detail}。`
      + `已按上月生成 ${p.generated} 张草稿凭证。要调整吗？（1 不变，2 改本月，3 改下月，4 停用某项）`;
  }
  if (mark) stateSet(key, now());
  return ok({ period, shouldNotify: !already, already_notified: already, summary: p, text });
}

/** 月初是否需要提醒（不生成、不标记，供页面/桌面端轮询） */
export function noticePending(setId, period) {
  return !stateGet(stateKey(setId, period));
}

export function markNotified(setId, period) {
  stateSet(stateKey(setId, period), now());
  return ok({ period });
}
