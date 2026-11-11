/**
 * 数据核验 CLI（只读，绝不修改任何数据）
 *
 *   node tools/data-audit.mjs                         # 单轮核验生产库
 *   node tools/data-audit.mjs --rounds 3             # 连续三轮，要求结果完全一致
 *   node tools/data-audit.mjs --expect-clean         # 额外要求「无业务数据、看板全零」
 *   node tools/data-audit.mjs --base http://127.0.0.1:8000   # 与看板接口交叉核验
 *   node tools/data-audit.mjs --snapshot before.json # 保存快照
 *   node tools/data-audit.mjs --compare before.json  # 与快照比对（变动前后）
 *   node tools/data-audit.mjs --db <path> --out report.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, runAudit } from '../backend/data-audit.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const DB = path.resolve(arg('--db', path.join(ROOT, 'backend', 'data', 'jinli.db')));
const BASE = arg('--base', '');
const ROUNDS = Math.max(1, Math.min(10, Number(arg('--rounds', '1')) || 1));
const OUT = arg('--out', path.join(ROOT, 'analysis', 'data-audit.json'));
const SNAP = arg('--snapshot', '');
const COMPARE = arg('--compare', '');
const PERIOD = arg('--period', new Date().toISOString().slice(0, 7));
const EXPECT_CLEAN = has('--expect-clean');

if (!fs.existsSync(DB)) {
  console.error(`数据库不存在：${DB}`);
  process.exit(2);
}

async function fetchOverview() {
  if (!BASE) return null;
  let token = '';
  try { token = JSON.parse(fs.readFileSync(path.join(ROOT, '.local', 'local-session.json'), 'utf8')).token; } catch { /* 无凭据 */ }
  try {
    const r = await fetch(`${BASE}/api/dashboard/overview?period=${PERIOD}`, {
      headers: { authorization: `Bearer ${token}`, 'x-set-id': '85' },
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    return j.code === 0 ? j.data : null;
  } catch { return null; }
}

function openReadonly() {
  // 每轮重新打开，确保没有跨轮缓存/事务影响
  const d = new DatabaseSync(DB);
  d.exec('PRAGMA query_only = ON');
  return d;
}

function print(result, label) {
  for (const c of result.checks) {
    const tag = c.ok ? 'PASS' : (c.level === 'warn' ? 'WARN' : 'FAIL');
    console.log(`${tag} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`--- ${label}: ${result.passed}/${result.total} PASS, ${result.error_count} FAIL, ${result.warn_count} WARN, hash=${result.snapshotHash}`);
}

const apiOverview = await fetchOverview();
const rounds = [];
for (let i = 1; i <= ROUNDS; i++) {
  const db = openReadonly();
  let r;
  try { r = runAudit(db, { setId: 85, period: PERIOD, expectClean: EXPECT_CLEAN, apiOverview: apiOverview || undefined }); }
  finally { db.close(); }
  rounds.push(r);
  if (ROUNDS > 1) print(r, `第 ${i}/${ROUNDS} 轮`);
}
const final = rounds[rounds.length - 1];
if (ROUNDS === 1) print(final, '核验结果');

// 多轮一致性：快照哈希 + 每项结论都必须逐字一致
let stable = true;
let stableDetail = '';
if (ROUNDS > 1) {
  const sig = (r) => JSON.stringify({ h: r.snapshotHash, c: r.checks.map((c) => [c.name, c.ok, c.level, c.detail]) });
  stable = rounds.every((r) => sig(r) === sig(rounds[0]));
  stableDetail = stable ? `${ROUNDS} 轮结果完全一致` : '多轮结果不一致，可能存在并发写入或非确定性计算';
  console.log(`${stable ? 'PASS' : 'FAIL'} 多轮一致性 — ${stableDetail}`);
}

// 变动前后对比
let compareOk = true;
let compareDetail = '未指定 --compare';
if (COMPARE) {
  try {
    const before = JSON.parse(fs.readFileSync(path.resolve(COMPARE), 'utf8'));
    const b = before.snapshot || before;
    const a = final.snapshot;
    const changed = [];
    for (const t of Object.keys(b.counts || {})) {
      if ((a.counts?.[t] ?? -1) !== b.counts[t]) changed.push(`${t}: ${b.counts[t]} -> ${a.counts?.[t]}`);
    }
    for (const k of Object.keys(b.metrics || {})) {
      if (Math.abs((a.metrics?.[k] ?? 0) - b.metrics[k]) > 0.005) changed.push(`${k}: ${b.metrics[k]} -> ${a.metrics?.[k]}`);
    }
    compareOk = changed.length === 0;
    compareDetail = changed.length ? `发生变动：${changed.join('; ')}` : '与快照完全一致（无意外变动）';
  } catch (e) { compareOk = false; compareDetail = `读取快照失败：${e.message}`; }
  console.log(`${compareOk ? 'PASS' : 'FAIL'} 变动前后对比 — ${compareDetail}`);
}

const report = {
  at: new Date().toISOString(), db: DB, base: BASE || '(未交叉核验接口)',
  period: PERIOD, rounds: ROUNDS, consistent: stable, consistentDetail: stableDetail,
  compareOk, compareDetail, result: final, history: rounds.map((r) => r.snapshotHash),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
if (SNAP) {
  fs.writeFileSync(path.resolve(SNAP), JSON.stringify(final, null, 2));
  console.log(`快照已保存 -> ${path.resolve(SNAP)}`);
}
console.log(`报告 -> ${OUT}`);
console.log(`DATA_AUDIT ${final.ok && stable && compareOk ? 'OK' : 'FAILED'}`);
process.exit(final.ok && stable && compareOk ? 0 : 1);
