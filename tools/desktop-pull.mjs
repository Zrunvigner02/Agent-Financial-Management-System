#!/usr/bin/env node
/**
 * desktop-pull —— 把「智能体桌面端」的对话拉到手机助理这边
 *
 * 背景：手机端（微信/企微本地助理）与桌面端（智能体 AgentWorkspace）是两个入口，
 * 桌面端里聊的内容手机端看不到。这里做单向补看：按消息 id 游标取桌面端新增消息，
 * 助理在回复里转述，用户就能在手机上接着跟。
 *
 * 用法：
 *   node tools/desktop-pull.mjs           # 取上次之后的新消息，并推进游标
 *   node tools/desktop-pull.mjs --peek    # 只看不推进游标
 *   node tools/desktop-pull.mjs --all     # 忽略游标，取最近 20 条
 * 输出恒为 JSON：{ ok, new_count, last_id, items:[{time,session,role,text}] }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.ZD_DB_PATH ? path.resolve(process.env.ZD_DB_PATH) : path.join(ROOT, 'backend', 'data', 'jinli.db');
const CURSOR = path.join(ROOT, '.local', 'desktop-pull-cursor.json');
const argv = new Set(process.argv.slice(2));
const PEEK = argv.has('--peek');
const ALL = argv.has('--all');

function out(o) {
  process.stdout.write(JSON.stringify(o, null, 2) + '\n');
}

if (!fs.existsSync(DB_PATH)) {
  out({ ok: false, error: `找不到账套数据库：${DB_PATH}` });
  process.exit(1);
}

let cursor = 0;
if (!ALL && fs.existsSync(CURSOR)) {
  try { cursor = Number(JSON.parse(fs.readFileSync(CURSOR, 'utf8')).last_id) || 0; } catch { cursor = 0; }
}

// 只读打开：绝不写业务数据；游标单独存 .local
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db.prepare(`
  SELECT m.id, m.session_id, COALESCE(s.title,'') AS title, m.role, m.content, m.created_at
  FROM agent_messages m LEFT JOIN agent_sessions s ON s.id = m.session_id
  WHERE m.session_id NOT LIKE 'claw-%' AND m.id > ?
  ORDER BY m.id ASC LIMIT 30
`).all(ALL ? 0 : cursor);
db.close();

const items = rows.map((r) => ({
  id: r.id,
  time: r.created_at,
  session: r.title || r.session_id,
  role: r.role === 'user' ? '用户(桌面端)' : '智能体',
  text: String(r.content || '').slice(0, 500),
}));
const lastId = rows.length ? rows[rows.length - 1].id : cursor;

if (!PEEK && !ALL) {
  fs.mkdirSync(path.dirname(CURSOR), { recursive: true });
  fs.writeFileSync(CURSOR, JSON.stringify({ last_id: lastId, updated_at: new Date().toISOString() }, null, 2));
}

out({ ok: true, new_count: items.length, last_id: lastId, items });
