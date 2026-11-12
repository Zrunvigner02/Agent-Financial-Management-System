#!/usr/bin/env node
/**
 * change-gate —— 妆点项目的「修改安全锁」
 *
 * 规则（用户 2026-11-12 明确要求）：
 *   任何涉及本项目（C:\Users\Administrator\WorkBuddy\工作区3\jinli-finance）的改动，
 *   必须先列出任务条例 → 等用户确认 → 下一轮对话才动手。
 *   本工具负责把这个流程落成可查的记录，防止「先说后改」变成「边说边改」。
 *
 * 用法：
 *   node tools/change-gate.mjs propose --title "标题" --steps "第一步|第二步" [--files "a.mjs,b.mjs"]
 *   node tools/change-gate.mjs list                 # 列出全部提案
 *   node tools/change-gate.mjs approve <id>         # 用户确认后才执行
 *   node tools/change-gate.mjs reject  <id> [原因]
 *   node tools/change-gate.mjs check                # 有未批准提案则退出码 1
 *
 * 数据只写 .local/change-gate.json，不碰账套库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = path.join(ROOT, '.local', 'change-gate.json');

const read = () => (fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : []);
const write = (rows) => {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(rows, null, 2));
};
const opt = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? String(process.argv[i + 1] || '') : fallback;
};
const nowStamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const out = (o, code = 0) => { console.log(JSON.stringify(o, null, 2)); process.exit(code); };

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'propose') {
  const rows = read();
  const title = opt('title').trim();
  if (!title) out({ ok: false, error: '缺少 --title' }, 1);
  const steps = opt('steps').split('|').map((s) => s.trim()).filter(Boolean);
  if (!steps.length) out({ ok: false, error: '缺少 --steps（用 | 分隔多条）' }, 1);
  const files = opt('files').split(',').map((s) => s.trim()).filter(Boolean);
  const id = String(Math.max(0, ...rows.map((r) => Number(r.id) || 0)) + 1);
  const row = {
    id, title, steps, files,
    status: 'pending',
    created_at: nowStamp(),
    approved_at: '', rejected_reason: '',
  };
  rows.push(row);
  write(rows);
  out({ ok: true, proposal: row, hint: '等用户确认后再执行 approve，然后才开始改文件' });
}

if (cmd === 'list') {
  const rows = read();
  out({ ok: true, count: rows.length, pending: rows.filter((r) => r.status === 'pending').length, proposals: rows });
}

if (cmd === 'approve') {
  const rows = read();
  const row = rows.find((r) => String(r.id) === String(arg));
  if (!row) out({ ok: false, error: `没有编号 ${arg} 的提案` }, 1);
  row.status = 'approved';
  row.approved_at = nowStamp();
  write(rows);
  out({ ok: true, proposal: row, hint: '已批准，可以开始改；改完记得回报哪些条完成' });
}

if (cmd === 'reject') {
  const rows = read();
  const row = rows.find((r) => String(r.id) === String(arg));
  if (!row) out({ ok: false, error: `没有编号 ${arg} 的提案` }, 1);
  row.status = 'rejected';
  row.rejected_reason = process.argv.slice(4).join(' ') || '用户未认可';
  write(rows);
  out({ ok: true, proposal: row });
}

if (cmd === 'check') {
  const pending = read().filter((r) => r.status === 'pending');
  out({ ok: pending.length === 0, pending: pending.length, proposals: pending }, pending.length ? 1 : 0);
}

out({ ok: false, error: '用法：propose | list | approve <id> | reject <id> | check' }, 1);
