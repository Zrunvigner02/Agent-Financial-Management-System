#!/usr/bin/env node
/**
 * claw-sync —— WorkBuddy 本地助理（Claw）会话 → 妆点智能体会话历史
 *
 * 规则（2026-11-12 由用户确认）：
 * 1. 每一天的本地助理对话，合并成「一条」妆点智能体会话：
 *      session_id = claw-YYYYMMDD，title = 「本地助理 · MM-DD」
 * 2. 每条消息都带时间戳：created_at 存本地时间，正文前缀 [HH:MM] 便于界面直接看到
 * 3. 幂等：按「事件 id + 角色」去重，重复跑不会产生重复消息
 * 4. auto：支持 --watch 常驻监听，文件变化后 1.5 秒内增量同步
 *
 * 用法：
 *   node tools/claw-sync.mjs            # 同步一次
 *   node tools/claw-sync.mjs --watch    # 常驻监听（供开机自启使用）
 *   node tools/claw-sync.mjs --dry      # 只打印将要写入的内容
 *   node tools/claw-sync.mjs --verbose  # 打印每条消息
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();

const CLAW_PROJECT = process.env.ZD_CLAW_PROJECT
  || path.join(HOME, 'WorkBuddy', 'Claw', '.workbuddy-projects'); // 占位，下面按实际目录兜底
const PROJECT_CANDIDATES = [
  path.join(HOME, '.workbuddy', 'projects', 'c-Users-Administrator-WorkBuddy-Claw'),
  path.join(HOME, '.workbuddy', 'projects', 'c-Users-Administrator-WorkBuddy-Claw-1'),
];

const DB_PATH = process.env.ZD_DB_PATH
  ? path.resolve(process.env.ZD_DB_PATH)
  : path.join(ROOT, 'backend', 'data', 'jinli.db');
const SET_ID = Number(process.env.ZD_SET_ID || 85);

const args = new Set(process.argv.slice(2));
const VERBOSE = args.has('--verbose');
const DRY = args.has('--dry');
const WATCH = args.has('--watch');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dayKey = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const dayTitle = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function projectDir() {
  for (const p of PROJECT_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return CLAW_PROJECT;
}

/** 去掉系统注入的上下文块，只保留用户真正说的话 */
function cleanUserText(raw) {
  let text = String(raw || '');
  const q = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (q) return q[1].trim();
  text = text
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<identity_context[\s\S]*?<\/identity_context>/g, '')
    .replace(/<product_identity[\s\S]*?<\/product_identity>/g, '')
    .replace(/<project_context[\s\S]*?<\/project_context>/g, '')
    .replace(/<connector-status[\s\S]*?<\/connector-status>/g, '');
  return text.trim();
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text'))
    .map((p) => String(p.text || ''))
    .join('\n')
    .trim();
}

/** 读取单个转录文件，返回按时间排序的消息事件 */
function parseFile(file) {
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  const base = path.basename(file, '.jsonl');
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type !== 'message') continue;
    const role = o.role === 'user' ? 'user' : o.role === 'assistant' ? 'assistant' : '';
    if (!role) continue;
    const text = role === 'user' ? cleanUserText(textOf(o.content)) : textOf(o.content);
    if (!text) continue;
    const ts = Number(o.timestamp) || Date.now();
    out.push({
      key: `${base}:${o.id || `${ts}:${out.length}`}:${role}`,
      role,
      text,
      date: new Date(ts),
    });
  }
  return out;
}

function collectEvents() {
  const dir = projectDir();
  if (!fs.existsSync(dir)) return { dir, events: [] };
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && !f.includes('.file-rollback.'))
    .map((f) => path.join(dir, f));
  const events = [];
  for (const f of files) events.push(...parseFile(f));
  events.sort((a, b) => a.date - b.date);
  return { dir, events };
}

function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`找不到账套数据库：${DB_PATH}（请先启动一次妆点本地后端）`);
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS claw_sync_log (
      key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id INTEGER,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claw_sync_session ON claw_sync_log(session_id);

    /* 用户主动删掉的会话：记墓碑，同步时不再复活 */
    CREATE TABLE IF NOT EXISTS claw_deleted (
      session_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );

    /* 在库层面拦截「删除」这个动作，任何来源（桌面端、网页、脚本）删除 claw-* 会话都会被记住 */
    CREATE TRIGGER IF NOT EXISTS claw_session_deleted
    AFTER DELETE ON agent_sessions
    WHEN OLD.id LIKE 'claw-%'
    BEGIN
      DELETE FROM claw_sync_log WHERE session_id = OLD.id;
      INSERT OR REPLACE INTO claw_deleted (session_id, deleted_at) VALUES (OLD.id, datetime('now', 'localtime'));
    END;
  `);
  return db;
}

function syncOnce() {
  const { dir, events } = collectEvents();
  if (!events.length) return { dir, added: 0, sessions: [], total: 0 };

  const db = openDb();
  const seen = new Set(db.prepare('SELECT key FROM claw_sync_log').all().map((r) => r.key));
  const tomb = new Set(db.prepare('SELECT session_id FROM claw_deleted').all().map((r) => r.session_id));
  const insSession = db.prepare(`INSERT OR IGNORE INTO agent_sessions (id, set_id, title, title_source, created_at)
    VALUES (?, ?, ?, 'manual', ?)`);
  const insMsg = db.prepare('INSERT INTO agent_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)');
  const insLog = db.prepare('INSERT OR REPLACE INTO claw_sync_log (key, session_id, message_id, synced_at) VALUES (?, ?, ?, ?)');

  // 已删除的会话不再复活：命中墓碑的事件直接跳过
  const pending = events.filter((e) => !seen.has(e.key) && !tomb.has(`claw-${dayKey(e.date)}`));
  const sessions = new Set();
  let added = 0;

  if (DRY) {
    for (const e of pending) {
      console.log(`[${stamp(e.date)}] ${e.role}: ${e.text.slice(0, 60).replace(/\n/g, ' ')}`);
    }
    db.close();
    return { dir, added: pending.length, sessions: [...sessions], total: events.length };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of pending) {
      const sid = `claw-${dayKey(e.date)}`;
      insSession.run(sid, SET_ID, `本地助理 · ${dayTitle(e.date)}`, stamp(e.date));
      const content = `[${pad(e.date.getHours())}:${pad(e.date.getMinutes())}] ${e.text}`;
      const r = insMsg.run(sid, e.role, content, stamp(e.date));
      insLog.run(e.key, sid, Number(r.lastInsertRowid), stamp(new Date()));
      sessions.add(sid);
      added += 1;
      if (VERBOSE) console.log(`+ ${sid} [${stamp(e.date)}] ${e.role}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();
  return { dir, added, sessions: [...sessions], total: events.length };
}

function report(r) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`${t} 同步完成：新增 ${r.added} 条 / 共 ${r.total} 条${r.sessions.length ? `，涉及会话 ${r.sessions.join(', ')}` : ''}`);
}

// 手动恢复被删掉的某天会话：--restore 20261110 / --restore claw-20261110 / --restore all
const ri = process.argv.indexOf('--restore');
if (ri > -1) {
  const raw = String(process.argv[ri + 1] || '').trim();
  const sid = raw && raw !== 'all' ? (raw.startsWith('claw-') ? raw : `claw-${raw.replace(/\D/g, '')}`) : 'all';
  const db = openDb();
  if (sid === 'all') {
    db.exec('DELETE FROM claw_deleted');
    db.exec('DELETE FROM claw_sync_log');
    console.log('已清空删除标记与同步记录，准备全量重建');
  } else {
    db.prepare('DELETE FROM claw_deleted WHERE session_id = ?').run(sid);
    db.prepare('DELETE FROM claw_sync_log WHERE session_id = ?').run(sid);
    console.log(`已取消删除标记：${sid}`);
  }
  db.close();
  const r = syncOnce();
  report(r);
  process.exit(0);
}

if (WATCH) {
  let lastSig = '';
  const tick = () => {
    const { events } = collectEvents();
    const sig = `${events.length}:${events.at(-1)?.key || ''}`;
    if (sig === lastSig) return;
    lastSig = sig;
    try {
      const r = syncOnce();
      if (r.added) report(r);
    } catch (e) {
      console.error(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 同步失败：${e.message}`);
    }
  };
  tick();
  console.log(`claw-sync 监听中（每 15 秒检查一次）：${projectDir()}`);
  setInterval(tick, 15000);
} else {
  const r = syncOnce();
  report(r);
}
