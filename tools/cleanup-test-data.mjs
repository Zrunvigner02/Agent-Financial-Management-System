/**
 * 清理测试数据（严谨版）
 *
 * 默认 dry-run 只列清单；--apply 才真正删除。
 * 流程：备份 DB -> 记录前快照 -> 事务内分项删除 -> 记录后快照 ->
 *       独立重算校验 -> 输出可回滚路径。
 * 绝不删除：users / roles / subjects / sets / open_tokens / sessions(登录态) /
 *           agent_config / agent_rules / agent_clarify_prefs 的全局偏好。
 *
 *   node tools/cleanup-test-data.mjs                 # 预览
 *   node tools/cleanup-test-data.mjs --apply        # 执行
 *   node tools/cleanup-test-data.mjs --restore <备份文件>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, runAudit } from '../backend/data-audit.mjs';

const DB = path.join(ROOT, 'backend', 'data', 'jinli.db');
const DATA_DIR = path.dirname(DB);
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ri = argv.indexOf('--restore');

if (!fs.existsSync(DB)) { console.error('数据库不存在:', DB); process.exit(2); }

if (ri >= 0) {
  const src = path.resolve(argv[ri + 1] || '');
  if (!fs.existsSync(src)) { console.error('备份不存在:', src); process.exit(2); }
  fs.copyFileSync(src, DB);
  console.log(`已从备份恢复：${src} -> ${DB}`);
  process.exit(0);
}

const db = new DatabaseSync(DB);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
const count = (t) => (tables.includes(t) ? db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 0);
const before = runAudit(db, { setId: 85, expectClean: false });

const plan = [
  { table: 'voucher_entries', label: '凭证分录（测试凭证的分录）' },
  { table: 'vouchers', label: '凭证（用户未导入任何业务数据）' },
  { table: 'closings', label: '结账记录' },
  { table: 'agent_messages', label: '智能体测试消息' },
  { table: 'agent_sessions', label: '智能体测试会话' },
  { table: 'agent_attachments', label: '附件解析测试记录（原件文件保留）' },
  { table: 'agent_clarify', label: '意图追问测试状态' },
];
const keep = ['users', 'roles', 'subjects', 'sets', 'open_tokens', 'sessions',
  'agent_config', 'agent_rules', 'agent_prompt_skills', 'agent_memories'];
// 保留项基线单独取全量计数：runAudit 的 snapshot.counts 只涵盖业务/测试相关表，
// 用它的 ?? 0 兜底会把 roles / agent_config 等误判为「被新增」。
const keepBefore = Object.fromEntries(keep.map((t) => [t, count(t)]));

console.log(`数据库: ${DB}`);
console.log(`清理前快照 hash=${before.snapshotHash}`);
console.log('\n=== 将删除 ===');
for (const p of plan) console.log(`  ${p.table.padEnd(22)} ${String(count(p.table)).padStart(4)} 行  ${p.label}`);
console.log('\n=== 保留（不得变动）===');
for (const t of keep) console.log(`  ${t.padEnd(22)} ${String(count(t)).padStart(4)} 行`);
const prefs = tables.includes('agent_clarify_prefs')
  ? db.prepare('SELECT * FROM agent_clarify_prefs').all() : [];
console.log(`  agent_clarify_prefs      ${String(prefs.length).padStart(4)} 行  （仅删会话级残留，保留全局偏好）`);

if (!APPLY) {
  console.log('\n[dry-run] 未改动任何数据。确认后加 --apply 执行（自动备份 + 前后核验）。');
  db.close();
  process.exit(0);
}

// --- 备份 ---
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = path.join(DATA_DIR, `jinli.db.bak-clean-${stamp}`);
db.close();
fs.copyFileSync(DB, backup);
console.log(`\n已备份 -> ${backup} (${fs.statSync(backup).size} bytes)`);
console.log(`如需回滚：node tools/cleanup-test-data.mjs --restore "${backup}"`);

// --- 事务删除 ---
const w = new DatabaseSync(DB);
const deleted = {};
w.exec('BEGIN IMMEDIATE');
try {
  for (const p of plan) {
    if (!tables.includes(p.table)) continue;
    deleted[p.table] = w.prepare(`DELETE FROM ${p.table}`).run().changes;
  }
  // 会话级偏好（scope 形如 session:xxx）删掉，全局偏好 scope='global' 保留
  if (tables.includes('agent_clarify_prefs')) {
    deleted.agent_clarify_prefs = w.prepare(
      "DELETE FROM agent_clarify_prefs WHERE scope LIKE 'session:%'",
    ).run().changes;
  }
  w.exec("DELETE FROM sqlite_sequence WHERE name IN ('vouchers','voucher_entries','agent_attachments')");
  w.exec('COMMIT');
} catch (e) {
  w.exec('ROLLBACK');
  w.close();
  console.error('清理失败，已回滚：', e.message);
  process.exit(1);
}
console.log('\n=== 实际删除行数 ===');
console.log(JSON.stringify(deleted, null, 2));

// --- 清理后立即独立核验 ---
const after = runAudit(w, { setId: 85, expectClean: true });
w.close();
console.log('\n=== 清理后核验 ===');
for (const c of after.checks) console.log(`${c.ok ? 'PASS' : (c.level === 'warn' ? 'WARN' : 'FAIL')} ${c.name} — ${c.detail}`);
console.log(`快照 hash=${after.snapshotHash}；${after.passed}/${after.total} PASS, ${after.error_count} FAIL`);

// --- 保留项逐项对比，确认没有误伤 ---
const v = new DatabaseSync(DB);
const vtables = new Set(v.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
console.log('\n=== 保留项复核 ===');
let keepOk = true;
for (const t of keep) {
  const n = vtables.has(t) ? v.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 0;
  const b = keepBefore[t] ?? 0;
  const ok = n === b;
  if (!ok) keepOk = false;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${t}: ${b} -> ${n}`);
}
v.close();

const ok = after.ok && keepOk;
console.log(`\nCLEANUP ${ok ? 'OK' : 'FAILED'}`);
if (!ok) {
  console.error(`核验未通过，建议回滚：node tools/cleanup-test-data.mjs --restore "${backup}"`);
  process.exit(1);
}
console.log(`备份保留在：${backup}`);
