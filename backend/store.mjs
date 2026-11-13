import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'backend', 'data');
export const SEED_DIR = path.join(ROOT, 'backend', 'seed');
export const LOCAL_DIR = path.join(ROOT, '.local');
export const DEFAULT_SET_ID = 85;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOCAL_DIR, { recursive: true });

// 允许测试实例通过 ZD_DB_PATH 把数据库完全隔离到临时目录，
// 避免「跑一次回归就往用户真实账套写一张凭证」这类污染。
// 未设置时行为与原来完全一致（backend/data/jinli.db）。
export const DB_PATH = process.env.ZD_DB_PATH
  ? path.resolve(process.env.ZD_DB_PATH)
  : path.join(DATA_DIR, 'jinli.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email TEXT DEFAULT '',
  name TEXT DEFAULT '',
  role TEXT DEFAULT '管理员',
  role_id INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT DEFAULT '',
  start_month TEXT DEFAULT '',
  standard TEXT DEFAULT '小企业会计准则（2011年）',
  tax_type TEXT DEFAULT '小规模纳税人',
  taxpayer_id TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  region TEXT DEFAULT '',
  frozen INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  business_data_key TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY,
  set_id INTEGER NOT NULL,
  parent_id INTEGER DEFAULT 0,
  code TEXT NOT NULL,
  full_code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT DEFAULT '',
  type TEXT DEFAULT '',
  direction TEXT DEFAULT '借',
  currency TEXT DEFAULT 'CNY',
  aux_keys TEXT DEFAULT '[]',
  status INTEGER DEFAULT 0,
  level INTEGER DEFAULT 1,
  locked INTEGER DEFAULT 0,
  is_leaf INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(set_id, code)
);
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  date TEXT NOT NULL,
  word TEXT DEFAULT '记',
  no INTEGER NOT NULL,
  status TEXT DEFAULT 'draft',
  creator TEXT DEFAULT '',
  reviewer TEXT DEFAULT '',
  poster TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS voucher_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id INTEGER NOT NULL,
  line INTEGER NOT NULL,
  summary TEXT DEFAULT '',
  subject_code TEXT NOT NULL,
  subject_name TEXT DEFAULT '',
  debit REAL DEFAULT 0,
  credit REAL DEFAULT 0,
  aux TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS open_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  scope TEXT DEFAULT 'read,write',
  default_set_id INTEGER,
  created_at TEXT NOT NULL,
  last_used_at TEXT DEFAULT '',
  revoked_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  set_id INTEGER,
  title TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_config (
  user_id INTEGER PRIMARY KEY,
  provider TEXT DEFAULT 'deepseek',
  base_url TEXT DEFAULT 'https://api.deepseek.com/v1',
  model TEXT DEFAULT 'deepseek-chat',
  api_key TEXT DEFAULT '',
  configured INTEGER DEFAULT 0,
  tested_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  code TEXT, name TEXT, category TEXT, amount REAL DEFAULT 0,
  purchased_at TEXT DEFAULT '', status TEXT DEFAULT 'normal', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auxiliaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL, type TEXT, code TEXT, name TEXT, status INTEGER DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL, number TEXT, kind TEXT, amount REAL DEFAULT 0,
  invoice_date TEXT DEFAULT '', status TEXT DEFAULT 'pending', file_name TEXT DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoice_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL, name TEXT NOT NULL, config TEXT DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS closings (
  set_id INTEGER NOT NULL, period TEXT NOT NULL, is_closed INTEGER DEFAULT 0,
  closed_at TEXT DEFAULT '', operator TEXT DEFAULT '',
  PRIMARY KEY (set_id, period)
);
CREATE INDEX IF NOT EXISTS idx_subjects_set ON subjects(set_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_set ON vouchers(set_id, period);
CREATE INDEX IF NOT EXISTS idx_entries_voucher ON voucher_entries(voucher_id);
`);

/* 账户管理本地化迁移（幂等）。SQLite 不支持 ADD COLUMN IF NOT EXISTS，先查列再补。 */
const _userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!_userCols.includes('phone')) db.exec("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''");
if (!_userCols.includes('status')) db.exec('ALTER TABLE users ADD COLUMN status INTEGER DEFAULT 1');
/* 软删除：账号删除后保留痕迹，凭证创建人仍可追溯；用户名加后缀释放占用 */
if (!_userCols.includes('deleted_at')) db.exec("ALTER TABLE users ADD COLUMN deleted_at TEXT DEFAULT ''");
const _sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
/* 会话有效期：默认 7 天，过期即失效（此前 token 永不过期） */
if (!_sessionCols.includes('expires_at')) db.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT DEFAULT ''");
db.exec(`
/* 登录失败计数：按「账号+来源」累计，5 次锁 15 分钟，落库以便重启后仍然生效 */
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT DEFAULT '',
  updated_at TEXT NOT NULL
);
/* 删除账号的二次确认令牌：一次性、60 秒有效，避免误点一键删除 */
CREATE TABLE IF NOT EXISTS delete_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  menus TEXT DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sets (
  user_id INTEGER NOT NULL,
  set_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, set_id)
);
`);
// 角色表为空时用云端快照做一次初始化，之后完全以本地表为准
if (db.prepare('SELECT COUNT(*) AS n FROM roles').get().n === 0) {
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend', 'seed', 'roles.json'), 'utf8'));
    const list = seed?.data?.list || [];
    const ins = db.prepare('INSERT OR IGNORE INTO roles (id, name, description, menus, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const r of list) ins.run(r.id, r.name, r.description || '', '[]', r.created_at || '2026-11-11 00:00:00');
  } catch { /* 无快照时保持空表，不影响页面 */ }
  db.prepare(`INSERT OR IGNORE INTO roles (name, description, menus, created_at)
              VALUES (?, ?, ?, ?)`).run('管理员', '本地全部权限', '[]', '2026-11-11 00:00:00');
}

/* 智能体本地化迁移（幂等）。前端会话列表支持置顶，设置面板支持记忆与规则。 */
const _agentSessionCols = db.prepare('PRAGMA table_info(agent_sessions)').all().map((c) => c.name);
if (!_agentSessionCols.includes('pinned')) {
  db.exec('ALTER TABLE agent_sessions ADD COLUMN pinned INTEGER DEFAULT 0');
}
// 会话名来源：'' = 前端默认 / auto = 自动生成 / manual = 用户手动重命名（自动逻辑永不覆盖）
if (!_agentSessionCols.includes('title_source')) {
  db.exec("ALTER TABLE agent_sessions ADD COLUMN title_source TEXT DEFAULT ''");
}
db.exec(`
CREATE TABLE IF NOT EXISTS agent_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_rules (
  set_id INTEGER PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_set ON agent_memories(set_id);
/* 设置面板「技能」tab 的自定义提示词技能，真实落库避免保存假成功 */
CREATE TABLE IF NOT EXISTS agent_prompt_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_apply INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
/* 意图追问工具：按会话保存多轮反问进度与已收集的答案 */
CREATE TABLE IF NOT EXISTS agent_clarify (
  session_id TEXT PRIMARY KEY,
  intent TEXT NOT NULL DEFAULT '',
  intent_label TEXT NOT NULL DEFAULT '',
  original TEXT NOT NULL DEFAULT '',
  asked TEXT NOT NULL DEFAULT '[]',
  answers TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'asking',
  updated_at TEXT NOT NULL
);

/* 意图追问开关：用户说「不用反问了」后持久化，聊天窗口 / REST / MCP 共同遵守 */
CREATE TABLE IF NOT EXISTS agent_clarify_prefs (
  scope TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

/* 智能体附件原件：多格式上传后留档，便于 WorkBuddy 侧继续读取 */
/* 固定支出（周期性凭证）：模板 + 单月覆盖 + 生成记录 + 提醒状态 */
CREATE TABLE IF NOT EXISTS recurring_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  entries TEXT NOT NULL DEFAULT '[]',
  day INTEGER NOT NULL DEFAULT 1,
  start_period TEXT NOT NULL DEFAULT '',
  end_period TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recurring_set ON recurring_templates(set_id, active);

CREATE TABLE IF NOT EXISTS recurring_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  entries TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(template_id, period)
);

CREATE TABLE IF NOT EXISTS recurring_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  set_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  voucher_id INTEGER,
  amount REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL,
  UNIQUE(template_id, period)
);

CREATE TABLE IF NOT EXISTS app_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT '',
  set_id INTEGER NOT NULL DEFAULT 85,
  name TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  engine TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  rows INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

/* 三大报表模板：未自定义时用内置默认模板，自定义后按库里的行计算 */
CREATE TABLE IF NOT EXISTS report_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT 'left',
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'item',
  level INTEGER NOT NULL DEFAULT 1,
  formula TEXT NOT NULL DEFAULT '',
  formula2 TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_templates_set ON report_templates(set_id, type);

/* 报表级设置：目前只存资产负债表的重分类开关 */
CREATE TABLE IF NOT EXISTS report_settings (
  set_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (set_id, key)
);
`);

export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function hashPassword(plain, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(plain, salt, 32).toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [salt, expected] = stored.split(':');
    const actual = scryptSync(plain, salt, 32);
    return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

export function readSeed(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SEED_DIR, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function initialize() {
  const setRow = db.prepare('SELECT id FROM sets WHERE id = ?').get(DEFAULT_SET_ID);
  if (!setRow) {
    const seedSet = readSeed('sets_enabled')?.data?.[0];
    db.prepare(`INSERT INTO sets (id, name, created_at) VALUES (?, ?, ?)`)
      .run(DEFAULT_SET_ID, seedSet?.name || '本地账套', now());
  }

  const subjectCount = db.prepare('SELECT COUNT(*) AS n FROM subjects WHERE set_id = ?').get(DEFAULT_SET_ID).n;
  if (subjectCount === 0) {
    const seedSubjects = readSeed('subjects')?.data || [];
    const insert = db.prepare(`INSERT OR IGNORE INTO subjects
      (id, set_id, parent_id, code, full_code, name, category, type, direction, currency,
       aux_keys, status, level, locked, is_leaf, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const s of seedSubjects) {
      insert.run(
        s.id, DEFAULT_SET_ID, s.parent_id ?? 0, s.code, s.full_code ?? s.code, s.name,
        s.category ?? '', s.type ?? '', s.direction ?? '借', s.currency ?? 'CNY',
        JSON.stringify(s.aux_keys ?? []), s.status ?? 0, s.level ?? 1,
        s.locked ? 1 : 0, s.is_leaf === false ? 0 : 1, now(),
      );
    }
    console.log(`[store] seeded ${seedSubjects.length} subjects`);
  }

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    const password = randomBytes(9).toString('base64url');
    db.prepare(`INSERT INTO users (username, password_hash, email, name, role, role_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('admin', hashPassword(password), '', '本地管理员', '管理员', 1, now());
    // 隔离库（测试/临时实例）不要把初始密码写进共享的 .local，避免污染真实凭据
    const adminFile = process.env.ZD_DB_PATH
      ? path.join(path.dirname(DB_PATH), 'local-admin.txt')
      : path.join(LOCAL_DIR, 'local-admin.txt');
    fs.writeFileSync(adminFile, `username=admin\npassword=${password}\n`);
    console.log(`[store] created local admin (password in ${path.relative(ROOT, adminFile)})`);
  }

  const cfg = db.prepare('SELECT user_id FROM agent_config WHERE user_id = 1').get();
  if (!cfg) {
    const key = readEnv('DEEPSEEK_API_KEY');
    db.prepare(`INSERT INTO agent_config (user_id, provider, base_url, model, api_key, configured)
                VALUES (1, 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat', ?, ?)`)
      .run(key, key ? 1 : 0);
  }
}

export function readEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
      .split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : '';
  } catch {
    return '';
  }
}

initialize();

export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const get = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);
