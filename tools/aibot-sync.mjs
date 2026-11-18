#!/usr/bin/env node
/**
 * aibot-sync —— WorkBuddy 企微 AIBot 会话 → 妆点智能体会话历史
 *
 * 背景：企微接入走的是 WorkBuddy 自带「企微 AIBot」（websocket 长连接），
 *      对话记录存在 WorkBuddy 侧（workbuddy.db + projects/*.jsonl），
 *      本脚本把它按日期合并进项目前端的「妆点智能体」会话，便于在桌面端查看。
 *
 * 规则：
 * 1. 同一天的所有企微 AIBot 对话，合并为一条会话：id = wecom-aibot-YYYYMMDD
 *    标题 = 「企微助理 · MM-DD」
 * 2. 消息正文前缀 [HH:MM]，sender 记「企微成员」（拿到发送人后再细化）
 * 3. 幂等：按事件 key 去重，重复跑不会重复写入
 * 4. 支持 --watch 常驻，--dry 预演，--self-test 自检，--list 列出识别到的会话
 *
 * 用法：
 *   node tools/aibot-sync.mjs             # 同步一次
 *   node tools/aibot-sync.mjs --watch     # 常驻监听
 *   node tools/aibot-sync.mjs --list      # 只列出识别到的企微会话
 *   node tools/aibot-sync.mjs --self-test # 用样例数据验证入库链路
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const ARGS = new Set(process.argv.slice(2));
const WATCH = ARGS.has('--watch');
const DRY = ARGS.has('--dry');
const LIST = ARGS.has('--list');
const SELF_TEST = ARGS.has('--self-test');

const WB_DB = process.env.ZD_WB_DB || path.join(HOME, '.workbuddy', 'workbuddy.db');
const WB_PROJECTS = path.join(HOME, '.workbuddy', 'projects');
const DB_PATH = process.env.ZD_DB_PATH
  ? path.resolve(process.env.ZD_DB_PATH)
  : path.join(ROOT, 'backend', 'data', 'jinli.db');
const SET_ID = Number(process.env.ZD_SET_ID || 85);
const CHAT_MEDIA = path.join(ROOT, 'upstream', 'chat-media');
const SENDER = process.env.ZD_AIBOT_SENDER || '企微成员';
const LOCK = path.join(ROOT, 'data', 'aibot-sync.lock');

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function acquireLock() {
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return true; } catch {
    let pid = 0;
    try { pid = Number(fs.readFileSync(LOCK, 'utf8')) || 0; } catch { /* ignore */ }
    if (pid && alive(pid)) return false;
    try { fs.unlinkSync(LOCK); } catch { /* ignore */ }
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return true; } catch { return false; }
  }
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const dayTitle = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/* ---------------- 识别企微来源会话 ---------------- */
function wecomSessions() {
  if (!fs.existsSync(WB_DB)) return [];
  const db = new DatabaseSync(WB_DB, { readOnly: true });
  let rows = [];
  try {
    const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    if (!cols.includes('conversation_origin')) return [];
    const where = [
      "lower(coalesce(conversation_origin,'')) LIKE '%wecom%'",
      "lower(coalesce(conversation_origin,'')) LIKE '%aibot%'",
      "lower(coalesce(transport,'')) LIKE '%wecom%'",
      "lower(coalesce(transport,'')) LIKE '%aibot%'",
    ].join(' OR ');
    rows = db.prepare(`SELECT id, title, cwd, created_at, conversation_origin, transport
      FROM sessions WHERE (${where}) ORDER BY created_at DESC`).all();
  } catch {
    rows = [];
  } finally {
    db.close();
  }
  return rows;
}

/** 在 ~/.workbuddy/projects/* 里按会话 id 找转录文件 */
function transcriptOf(sessionId) {
  if (!fs.existsSync(WB_PROJECTS)) return '';
  for (const dir of fs.readdirSync(WB_PROJECTS)) {
    const f = path.join(WB_PROJECTS, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return '';
}

/* ---------------- 解析转录 ---------------- */
const MEDIA_EXTS = 'png|jpe?g|gif|webp|bmp|svg|pdf|xlsx?|csv|docx?|pptx?|zip|mp4|md|txt';
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const REL_RE = new RegExp(`((?:报表|规则|备份|工具)/[^\\n\\r"'\`<>|{}]*?\\.(?:${MEDIA_EXTS}))`, 'gi');
const ABS_RE = new RegExp(`([A-Za-z]:[\\\\/][^\\n\\r"'<>|{}]*?\\.(?:${MEDIA_EXTS}))`, 'gi');

function cleanUserText(raw) {
  let text = String(raw || '');
  const q = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (q) return q[1].trim();
  return text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '').trim();
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && ['text', 'input_text', 'output_text'].includes(p.type))
    .map((p) => String(p.text || ''))
    .join('\n')
    .trim();
}

function parseFile(file) {
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const base = path.basename(file, '.jsonl');
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== 'message') continue;
    const role = o.role === 'user' ? 'user' : o.role === 'assistant' ? 'assistant' : '';
    if (!role) continue;
    const text = role === 'user' ? cleanUserText(textOf(o.content)) : textOf(o.content);
    if (!text) continue;
    const ts = Number(o.timestamp) || Date.now();
    out.push({ key: `${base}:${o.id || `${ts}:${out.length}`}:${role}`, role, text, date: new Date(ts) });
  }
  return out;
}

/* ---------------- 媒体：复制到前端可访问目录 ---------------- */
function decorateMedia(text, day) {
  let out = String(text || '');
  const found = new Set();
  let m;
  REL_RE.lastIndex = 0;
  while ((m = REL_RE.exec(out))) found.add(path.join(HOME, 'WorkBuddy', 'Claw', m[1].replace(/\//g, path.sep)));
  ABS_RE.lastIndex = 0;
  while ((m = ABS_RE.exec(out.replace(/\\\\/g, '\\')))) found.add(m[1]);
  for (const p of found) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile() || st.size > 30 * 1024 * 1024) continue;
    const ext = path.extname(p).slice(1).toLowerCase();
    const dir = path.join(CHAT_MEDIA, `aibot-${day}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const hash = crypto.createHash('sha1').update(p).digest('hex').slice(0, 8);
      const name = `${hash}_${path.basename(p)}`;
      const dest = path.join(dir, name);
      if (!fs.existsSync(dest)) fs.copyFileSync(p, dest);
      const url = `/chat-media/aibot-${day}/${encodeURIComponent(name)}`;
      if (out.includes(url)) continue;
      const kind = IMG_EXTS.has(ext) ? 'img' : 'file';
      out += `\n\n[[MEDIA:${url}|${path.basename(p)}|${kind}]]`;
    } catch { /* 媒体失败不影响同步 */ }
  }
  return out;
}

/* ---------------- 数据库 ---------------- */
function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`找不到账套数据库：${DB_PATH}（请先启动一次妆点本地后端）`);
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS aibot_sync_log (
      event_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS aibot_session_deleted
    AFTER DELETE ON agent_sessions
    WHEN OLD.id LIKE 'wecom-aibot-%'
    BEGIN
      DELETE FROM aibot_sync_log WHERE session_id = OLD.id;
      INSERT OR REPLACE INTO claw_deleted (session_id, deleted_at) VALUES (OLD.id, datetime('now','localtime'));
    END;
  `);
  return db;
}

/* ---------------- 主流程 ---------------- */
function gather() {
  const sessions = wecomSessions();
  const events = [];
  const missing = [];
  for (const s of sessions) {
    const f = transcriptOf(s.id);
    if (!f) { missing.push(s); continue; }
    for (const e of parseFile(f)) events.push({ ...e, session: s });
  }
  events.sort((a, b) => a.date - b.date);
  return { sessions, events, missing };
}

function syncOnce() {
  const { sessions, events, missing } = gather();
  if (LIST) {
    console.log(`企微来源会话：${sessions.length} 条`);
    for (const s of sessions) {
      console.log(`  ${s.id.slice(0, 12)} | ${s.title || '(无标题)'} | ${new Date(s.created_at).toLocaleString('sv-SE')} | origin=${s.conversation_origin || '-'}`);
    }
    console.log(`可解析消息：${events.length} 条；找不到转录文件：${missing.length} 条`);
    return { wrote: 0, sessions: 0 };
  }
  if (!events.length) {
    console.log('暂无企微 AIBot 对话可同步（去企微给机器人发一条消息后再跑）。');
    if (missing.length) console.log(`提示：${missing.length} 个会话未找到转录文件。`);
    return { wrote: 0, sessions: 0 };
  }

  const db = openDb();
  const insSession = db.prepare(`INSERT OR IGNORE INTO agent_sessions (id, set_id, title, title_source, created_at)
    VALUES (?, ?, ?, 'auto', ?)`);
  const insMsg = db.prepare(`INSERT INTO agent_messages (session_id, role, content, created_at, sender)
    VALUES (?, ?, ?, ?, ?)`);
  const insLog = db.prepare('INSERT OR IGNORE INTO aibot_sync_log (event_key, session_id, created_at) VALUES (?, ?, ?)');
  const seen = db.prepare('SELECT 1 FROM aibot_sync_log WHERE event_key = ?');
  const tomb = db.prepare('SELECT 1 FROM claw_deleted WHERE session_id = ?');

  let wrote = 0;
  let made = 0;
  try {
    db.exec('BEGIN');
    for (const e of events) {
      const sid = `wecom-aibot-${dayKey(e.date)}`;
      if (tomb.get(sid)) continue;
      if (seen.get(e.key)) continue;
      const title = `企微助理 · ${dayTitle(e.date)}`;
      const r = insSession.run(sid, SET_ID, title, stamp(e.date));
      if (r.changes) made += 1;
      const body = `[${pad(e.date.getHours())}:${pad(e.date.getMinutes())}] ${e.text}`;
      const content = DRY ? body : decorateMedia(body, dayKey(e.date));
      if (!DRY) insMsg.run(sid, e.role, content, stamp(e.date), e.role === 'user' ? SENDER : '助手');
      insLog.run(e.key, sid, stamp(new Date()));
      wrote += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    db.close();
  }
  console.log(`${DRY ? '[预演] ' : ''}同步 ${wrote} 条消息，涉及 ${made} 个新会话（企微 AIBot）`);
  return { wrote, sessions: made };
}

/* ---------------- 自检：用样例转录验证链路 ---------------- */
function selfTest() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-aibot-'));
  const sid = `selftest-${Date.now()}`;
  const now = Date.now();
  const lines = [
    { type: 'message', id: 'u1', role: 'user', timestamp: now - 60000, content: [{ type: 'text', text: '你好，帮我看下本月销售' }] },
    { type: 'message', id: 'a1', role: 'assistant', timestamp: now - 30000, content: [{ type: 'text', text: '本月销售额 2,703,696.62 元，净利 1,619,726.73 元。' }] },
  ];
  const f = path.join(tmpDir, `${sid}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const evs = parseFile(f);
  console.log(`自检：解析 ${evs.length} 条消息（期望 2）`);
  if (evs.length !== 2) { fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1); }
  const db = openDb();
  const testSid = `wecom-aibot-TEST`;
  try {
    db.exec('BEGIN');
    db.prepare(`INSERT OR REPLACE INTO agent_sessions (id, set_id, title, title_source, created_at) VALUES (?,?,?,'auto',?)`)
      .run(testSid, SET_ID, '企微助理 · 自检', stamp(new Date()));
    for (const e of evs) {
      db.prepare('INSERT INTO agent_messages (session_id, role, content, created_at, sender) VALUES (?,?,?,?,?)')
        .run(testSid, e.role, `[自检] ${e.text}`, stamp(e.date), e.role === 'user' ? SENDER : '助手');
    }
    const n = db.prepare('SELECT COUNT(*) n FROM agent_messages WHERE session_id = ?').get(testSid).n;
    console.log(`自检：写入 ${n} 条消息（期望 2）`);
    db.exec('ROLLBACK'); // 不污染真实数据
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    console.error('自检失败：', err.message);
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('自检通过：解析 + 入库链路可用。');
}

/* ---------------- 入口 ---------------- */
if (SELF_TEST) {
  selfTest();
} else if (WATCH) {
  if (!acquireLock()) {
    console.log('已有 aibot-sync 在运行，本次退出。');
    process.exit(0);
  }
  let last = '';
  const tick = () => {
    try {
      const sig = gather().events.map((e) => e.key).join('|');
      if (sig && sig !== last) { last = sig; syncOnce(); }
    } catch (e) {
      console.error('同步失败：', e.message);
    }
  };
  tick();
  setInterval(tick, 15000);
  console.log('aibot-sync 监听中（每 15 秒检查一次）…');
} else {
  try {
    syncOnce();
  } catch (e) {
    console.error('同步失败：', e.message);
    process.exit(1);
  }
}
