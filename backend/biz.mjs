import { all, get, run, db, now, readEnv, hashPassword, verifyPassword, randomToken, readSeed, DEFAULT_SET_ID } from './store.mjs';
import * as llm from './llm.mjs';
import * as exp from './export.mjs';
import * as sessionTitle from './session-title.mjs';

export const ok = (data = null, message = '') => ({ code: 0, data, message });
export const fail = (message = '操作失败', code = 1) => ({ code, data: null, message });

const parseSetId = (raw) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SET_ID;
};

/* ---------------- 认证 ---------------- */

export function register({ username, password, email = '', name = '' }) {
  if (!username || !password) return fail('账号和密码不能为空');
  if (String(password).length < 6 || String(password).length > 32) return fail('密码长度须为 6-32 位');
  if (get('SELECT id FROM users WHERE username = ?', username)) return fail('账号已存在');
  const info = run(
    `INSERT INTO users (username, password_hash, email, name, role, role_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    username, hashPassword(password), email || '', name || username, '管理员', 1, now(),
  );
  return login({ username, password }, Number(info.lastInsertRowid));
}

export function login({ username, password }, forcedUserId = null) {
  const user = forcedUserId
    ? get('SELECT * FROM users WHERE id = ?', forcedUserId)
    : get('SELECT * FROM users WHERE username = ?', username || '');
  if (!user || !verifyPassword(password || '', user.password_hash)) return fail('账号或密码错误');
  const token = randomToken();
  run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', token, user.id, now());
  return ok({
    token,
    username: user.username,
    name: user.name,
    role: 'admin',
    roleId: null,
    menus: menusForUser(user),
  });
}

// 角色若配置了菜单路径则按配置下发；空配置回落全量，避免把自己锁在门外。
function menusForUser(user) {
  const r = user.role_id ? get('SELECT menus FROM roles WHERE id = ?', user.role_id) : null;
  if (r) {
    try {
      const paths = JSON.parse(r.menus || '[]');
      if (Array.isArray(paths) && paths.length) return [...new Set([...paths, '/tools/convert'])];
    } catch { /* 配置损坏时回落全量菜单 */ }
  }
  return defaultMenus();
}

export function userFromToken(token) {
  if (!token) return null;
  return get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    token,
  ) || null;
}

export function changePassword(userId, { old_password, new_password }) {
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  if (!user || !verifyPassword(old_password || '', user.password_hash)) return fail('原密码不正确');
  if (!new_password || String(new_password).length < 6) return fail('新密码至少 6 位');
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(new_password), userId);
  return ok(null, '密码已修改');
}

function defaultMenus() {
  // 与云端登录响应一致：路由路径字符串数组（前端据此做权限判断）
  return [
    '/dashboard', '/smart/invoice', '/voucher/create', '/voucher/list',
    '/ledger/general', '/ledger/detail', '/ledger/balance',
    '/ledger/auxiliary-detail', '/ledger/auxiliary-balance', '/ledger/aging',
    '/report/balance-sheet', '/report/income', '/report/cash-flow',
    '/closing/index', '/asset/category', '/asset/manage',
    '/setting/subjects', '/setting/auxiliary', '/setting/opening-balance',
    '/auth/roles', '/auth/accounts', '/auth/sets', '/agent',
    '/settings/tokens', '/tools/convert',
  ];
}

/* ---------------- 本地账户 / 角色管理 ----------------
 * 前端 AccountManage / RoleManage 调 /accounts、/roles 系列接口；
 * 之前全部落到「ok(null, 本地版暂未实现)」兜底，页面会误报保存成功。
 * 这里改为真实读写本地 SQLite，账号与角色数据完全留在本机。
 */

const ACCOUNT_SELECT = `SELECT u.*, r.name AS role_name FROM users u
  LEFT JOIN roles r ON r.id = u.role_id`;

const accountDto = (u) => ({
  id: u.id,
  name: u.name || u.username,
  username: u.username,
  phone: u.phone || '',
  role_id: u.role_id ?? null,
  role_name: u.role_name || u.role || '管理员',
  status: u.status ?? 1,
  created_at: u.created_at,
});

const roleDto = (r) => ({
  id: r.id, name: r.name, description: r.description || '', created_at: r.created_at,
});

const resolveRole = (roleId) => {
  if (!roleId) return { id: null, name: '管理员' };
  const r = get('SELECT id, name FROM roles WHERE id = ?', roleId);
  return r ? { id: r.id, name: r.name } : { id: null, name: '管理员' };
};

export function listAccounts(keyword = '') {
  const kw = String(keyword || '').trim();
  const rows = kw
    ? all(`${ACCOUNT_SELECT} WHERE u.username LIKE ? OR u.name LIKE ? OR u.phone LIKE ? ORDER BY u.id`,
      `%${kw}%`, `%${kw}%`, `%${kw}%`)
    : all(`${ACCOUNT_SELECT} ORDER BY u.id`);
  return ok(rows.map(accountDto));
}

export function createAccount(data = {}) {
  const username = String(data.username || '').trim();
  const password = String(data.password || '');
  const name = String(data.name || username).trim();
  if (!username) return fail('登录账号不能为空');
  if (get('SELECT id FROM users WHERE username = ?', username)) return fail('该登录账号已存在');
  if (password.length < 6 || password.length > 32) return fail('密码长度须为 6-32 位');
  const role = resolveRole(data.roleId ?? data.role_id);
  const info = run(
    `INSERT INTO users (username, password_hash, email, name, role, role_id, phone, status, created_at)
     VALUES (?, ?, '', ?, ?, ?, ?, 1, ?)`,
    username, hashPassword(password), name, role.name, role.id,
    String(data.phone || '').trim(), now(),
  );
  return ok({ id: Number(info.lastInsertRowid) }, '账号已创建');
}

export function updateAccount(id, data = {}) {
  const u = get('SELECT * FROM users WHERE id = ?', id);
  if (!u) return fail('账号不存在');
  const sets = [], vals = [];
  if (data.name !== undefined) { sets.push('name = ?'); vals.push(String(data.name).trim() || u.name); }
  if (data.phone !== undefined) { sets.push('phone = ?'); vals.push(String(data.phone).trim()); }
  if (data.roleId !== undefined || data.role_id !== undefined) {
    const role = resolveRole(data.roleId ?? data.role_id);
    sets.push('role_id = ?', 'role = ?'); vals.push(role.id, role.name);
  }
  const pwd = String(data.password || '').trim();
  if (pwd) {
    if (pwd.length < 6 || pwd.length > 32) return fail('密码长度须为 6-32 位');
    sets.push('password_hash = ?'); vals.push(hashPassword(pwd));
  }
  if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  return ok(null, '账号已更新');
}

export function setAccountStatus(id, status, actorId = null) {
  if (!get('SELECT id FROM users WHERE id = ?', id)) return fail('账号不存在');
  if (actorId && Number(id) === Number(actorId)) return fail('不能停用当前登录账号');
  run('UPDATE users SET status = ? WHERE id = ?', status ? 1 : 0, id);
  if (!status) run('DELETE FROM sessions WHERE user_id = ?', id);
  return ok(null, status ? '账号已启用' : '账号已停用');
}

export function deleteAccount(id, actorId = null) {
  if (!get('SELECT id FROM users WHERE id = ?', id)) return fail('账号不存在');
  if (actorId && Number(id) === Number(actorId)) return fail('不能删除当前登录账号');
  if (get('SELECT COUNT(*) AS n FROM users').n <= 1) return fail('至少保留一个账号');
  run('DELETE FROM users WHERE id = ?', id);
  run('DELETE FROM sessions WHERE user_id = ?', id);
  run('DELETE FROM account_sets WHERE user_id = ?', id);
  return ok(null, '账号已删除');
}

export function accountSets(id) {
  return ok(all('SELECT set_id FROM account_sets WHERE user_id = ? ORDER BY set_id', id)
    .map((r) => r.set_id));
}

export function saveAccountSets(id, setIds = []) {
  if (!get('SELECT id FROM users WHERE id = ?', id)) return fail('账号不存在');
  const ids = [...new Set((Array.isArray(setIds) ? setIds : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  run('DELETE FROM account_sets WHERE user_id = ?', id);
  for (const sid of ids) run('INSERT OR IGNORE INTO account_sets (user_id, set_id) VALUES (?, ?)', id, sid);
  return ok(null, '账套权限已保存');
}

export function listRoles(keyword = '') {
  const kw = String(keyword || '').trim();
  const rows = kw
    ? all('SELECT * FROM roles WHERE name LIKE ? ORDER BY id', `%${kw}%`)
    : all('SELECT * FROM roles ORDER BY id');
  return ok({ list: rows.map(roleDto), total: rows.length, page: 1, pageSize: 1000 });
}

export function createRole(data = {}) {
  const name = String(data.name || '').trim();
  if (!name) return fail('角色名称不能为空');
  if (get('SELECT id FROM roles WHERE name = ?', name)) return fail('角色已存在');
  const info = run('INSERT INTO roles (name, description, menus, created_at) VALUES (?, ?, ?, ?)',
    name, String(data.description || '').trim(), '[]', now());
  return ok({ id: Number(info.lastInsertRowid) }, '角色已创建');
}

export function updateRole(id, data = {}) {
  if (!get('SELECT id FROM roles WHERE id = ?', id)) return fail('角色不存在');
  const sets = [], vals = [];
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) return fail('角色名称不能为空');
    const dup = get('SELECT id FROM roles WHERE name = ? AND id <> ?', name, id);
    if (dup) return fail('角色名称已存在');
    sets.push('name = ?'); vals.push(name);
  }
  if (data.description !== undefined) { sets.push('description = ?'); vals.push(String(data.description).trim()); }
  if (sets.length) run(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  return ok(null, '角色已更新');
}

export function deleteRole(id) {
  if (!get('SELECT id FROM roles WHERE id = ?', id)) return fail('角色不存在');
  run('UPDATE users SET role_id = NULL WHERE role_id = ?', id);
  run('DELETE FROM roles WHERE id = ?', id);
  return ok(null, '角色已删除');
}

export function roleMenus(id) {
  const r = get('SELECT menus FROM roles WHERE id = ?', id);
  if (!r) return fail('角色不存在');
  let paths = [];
  try { paths = JSON.parse(r.menus || '[]'); } catch { /* 损坏时按空处理 */ }
  return ok(Array.isArray(paths) ? paths : []);
}

export function saveRoleMenus(id, paths = []) {
  if (!get('SELECT id FROM roles WHERE id = ?', id)) return fail('角色不存在');
  const clean = [...new Set((Array.isArray(paths) ? paths : []).map(String).filter((p) => p.startsWith('/')))];
  run('UPDATE roles SET menus = ? WHERE id = ?', JSON.stringify(clean), id);
  return ok(null, '权限已保存');
}

/* ---------------- 账套 ---------------- */

const setDto = (s) => ({
  id: s.id, name: s.name, company: s.company, start_month: s.start_month,
  standard: s.standard, tax_type: s.tax_type, taxpayer_id: s.taxpayer_id,
  industry: s.industry, region: s.region, frozen: s.frozen, enabled: s.enabled,
  created_at: s.created_at,
});

export function listSets(enabledOnly = false) {
  const rows = enabledOnly
    ? all('SELECT * FROM sets WHERE enabled = 1 ORDER BY id')
    : all('SELECT * FROM sets ORDER BY id');
  return ok(rows.map(setDto));
}

export function createSet(data, forceId = null) {
  const id = forceId || Number(get('SELECT COALESCE(MAX(id), 0) AS m FROM sets').m) + 1;
  if (get('SELECT id FROM sets WHERE id = ?', id)) return fail('账套已存在');
  run(
    `INSERT INTO sets (id, name, company, start_month, standard, tax_type, taxpayer_id,
                       industry, region, business_data_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, data.name || '新账套', data.company || '', data.start_month || data.financial_start || '',
    data.standard || '', data.tax_type || '', data.taxpayer_id || '',
    data.industry || '', data.region || '', data.business_data_key || '', now(),
  );
  return ok({ id, ...setDto(get('SELECT * FROM sets WHERE id = ?', id)) });
}

export function updateSet(id, data) {
  if (!get('SELECT id FROM sets WHERE id = ?', id)) return fail('账套不存在');
  const fields = ['name', 'company', 'start_month', 'standard', 'tax_type', 'taxpayer_id', 'industry', 'region', 'frozen'];
  const sets = [];
  const values = [];
  for (const f of fields) {
    if (data[f] !== undefined) { sets.push(`${f} = ?`); values.push(data[f]); }
  }
  if (sets.length) run(`UPDATE sets SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
  return ok(setDto(get('SELECT * FROM sets WHERE id = ?', id)));
}

/* ---------------- 科目 ---------------- */

function subjectDto(s) {
  let aux = [];
  try { aux = JSON.parse(s.aux_keys || '[]'); } catch { aux = []; }
  return {
    id: s.id, set_id: s.set_id, parent_id: s.parent_id, code: s.code,
    full_code: s.full_code, name: s.name, category: s.category, type: s.type,
    direction: s.direction, currency: s.currency, aux_keys: aux, status: s.status,
    level: s.level, is_system: 0, locked: Boolean(s.locked),
    lock_reason: s.locked ? '已被 报表公式 使用' : '', children: [],
    created_at: s.created_at,
  };
}

export function listSubjects(setId) {
  return ok(all('SELECT * FROM subjects WHERE set_id = ? ORDER BY code', setId).map(subjectDto));
}

export function createSubject(setId, data) {
  if (!data.code || !data.name) return fail('科目编码和名称不能为空');
  if (get('SELECT id FROM subjects WHERE set_id = ? AND code = ?', setId, data.code)) return fail('科目编码已存在');
  const id = Number(get('SELECT COALESCE(MAX(id), 10000) AS m FROM subjects').m) + 1;
  run(
    `INSERT INTO subjects (id, set_id, parent_id, code, full_code, name, category, type,
                           direction, currency, aux_keys, status, level, locked, is_leaf, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, setId, data.parent_id ?? 0, data.code, data.full_code ?? data.code, data.name,
    data.category ?? '', data.type ?? '', data.direction ?? '借', data.currency ?? 'CNY',
    JSON.stringify(data.aux_keys ?? []), 0, data.level ?? 1, 0, 1, now(),
  );
  return ok(subjectDto(get('SELECT * FROM subjects WHERE id = ?', id)));
}

export function deleteSubject(setId, id) {
  const s = get('SELECT * FROM subjects WHERE id = ? AND set_id = ?', id, setId);
  if (!s) return fail('科目不存在');
  if (s.locked) return fail('系统锁定科目不可删除');
  run('DELETE FROM subjects WHERE id = ?', id);
  return ok(null, '已删除');
}

/* ---------------- 凭证 ---------------- */

const STATUS_LABEL = { draft: '未审核', reviewed: '已审核', posted: '已记账', void: '作废' };

function voucherDto(v, withEntries = false) {
  const entries = all('SELECT * FROM voucher_entries WHERE voucher_id = ? ORDER BY line', v.id)
    .map((e) => ({
      id: e.id, line: e.line, summary: e.summary, subject_code: e.subject_code,
      subject_name: e.subject_name, debit: e.debit, credit: e.credit,
      aux: (() => { try { return JSON.parse(e.aux || '{}'); } catch { return {}; } })(),
    }));
  const amount = entries.reduce((sum, e) => sum + e.debit, 0);
  return {
    id: v.id, set_id: v.set_id, period: v.period, date: v.date, word: v.word, no: v.no,
    no_display: `${v.word}-${String(v.no).padStart(3, '0')}`,
    summary: entries[0]?.summary ?? '', amount,
    status: v.status, status_label: STATUS_LABEL[v.status] ?? v.status,
    creator: v.creator, reviewer: v.reviewer, poster: v.poster,
    created_at: v.created_at,
    ...(withEntries ? { entries } : {}),
  };
}

export function listVouchers(setId, query = {}) {
  const period = query.period || '';
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.max(1, Number(query.pageSize) || 20);
  const where = ['set_id = ?'];
  const params = [setId];
  if (period) { where.push('period = ?'); params.push(period); }
  if (query.status) { where.push('status = ?'); params.push(query.status); }
  const clause = where.join(' AND ');
  const total = get(`SELECT COUNT(*) AS n FROM vouchers WHERE ${clause}`, ...params).n;
  const rows = all(
    `SELECT * FROM vouchers WHERE ${clause} ORDER BY date DESC, no DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize,
  );
  return ok({ list: rows.map((v) => voucherDto(v)), total, page, pageSize });
}

export function getVoucher(setId, id) {
  const v = get('SELECT * FROM vouchers WHERE id = ? AND set_id = ?', id, setId);
  return v ? ok(voucherDto(v, true)) : fail('凭证不存在');
}

/** 前端「新增凭证」提交 items + subject_id；API/MCP 提交 entries + subject_code，两者都要能落库 */
function normalizeSubjectCode(setId, e) {
  const direct = e.subject_code ?? e.subject_full_code;
  if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct).trim();
  const sid = e.subject_id;
  if (sid === undefined || sid === null || sid === '') return '';
  const row = get('SELECT code FROM subjects WHERE set_id = ? AND (CAST(id AS TEXT) = ? OR code = ?) LIMIT 1',
    setId, String(sid), String(sid));
  return row?.code ? String(row.code) : String(sid);
}

function validMoney(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) && n >= 0 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

export function createVoucher(setId, data, user = 'admin') {
  const raw = Array.isArray(data.entries) ? data.entries : Array.isArray(data.items) ? data.items : [];
  const entries = raw.map((e) => ({ ...e, subject_code: normalizeSubjectCode(setId, e) }));
  if (entries.length < 2) return fail('凭证至少要有两条分录');

  // 录入即校验：科目必须真实存在、金额必须是合法的非负两位小数、单行不能同时借贷。
  for (const [i, e] of entries.entries()) {
    if (!e.subject_code || !get('SELECT 1 FROM subjects WHERE set_id = ? AND code = ?', setId, e.subject_code)) {
      return fail(`第 ${i + 1} 行科目不存在：${e.subject_code || '(空)'}`);
    }
    if (!validMoney(e.debit) || !validMoney(e.credit)) return fail(`第 ${i + 1} 行金额非法（需非负且最多两位小数）`);
    if (Number(e.debit || 0) > 0 && Number(e.credit || 0) > 0) return fail(`第 ${i + 1} 行不能同时填写借方和贷方`);
  }
  const debit = entries.reduce((s, e) => s + Number(e.debit || 0), 0);
  const credit = entries.reduce((s, e) => s + Number(e.credit || 0), 0);
  if (Math.abs(debit - credit) > 0.005) return fail('借贷不平衡，无法保存');
  if (debit <= 0) return fail('凭证金额必须大于 0');
  const date = data.date || new Date().toISOString().slice(0, 10);
  const period = String(data.period || date.slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(period)) return fail('期间格式应为 YYYY-MM');
  const word = data.word || '记';
  const next = get('SELECT COALESCE(MAX(no), 0) AS m FROM vouchers WHERE set_id = ? AND period = ? AND word = ?', setId, period, word).m + 1;
  const info = run(
    `INSERT INTO vouchers (set_id, period, date, word, no, status, creator, created_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
    setId, period, date, word, next, user, now(),
  );
  const voucherId = Number(info.lastInsertRowid);
  const insert = dbInsertEntry();
  entries.forEach((e, i) => {
    insert.run(voucherId, i + 1, e.summary || '', String(e.subject_code || ''),
      e.subject_name || lookupSubjectName(setId, e.subject_code), Number(e.debit || 0),
      Number(e.credit || 0), JSON.stringify(e.aux || {}));
  });
  return getVoucher(setId, voucherId);
}

function dbInsertEntry() {
  return {
    run: (...args) => run(
      `INSERT INTO voucher_entries (voucher_id, line, summary, subject_code, subject_name, debit, credit, aux)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ...args),
  };
}

function lookupSubjectName(setId, code) {
  return get('SELECT name FROM subjects WHERE set_id = ? AND code = ?', setId, String(code || ''))?.name || '';
}

function transitionVoucher(setId, id, from, to, field, user) {
  const v = get('SELECT * FROM vouchers WHERE id = ? AND set_id = ?', id, setId);
  if (!v) return fail('凭证不存在');
  if (v.status !== from) return fail(`凭证状态为「${STATUS_LABEL[v.status]}」，不允许该操作`);
  run(`UPDATE vouchers SET status = ?, ${field} = ? WHERE id = ?`, to, user, id);
  return getVoucher(setId, id);
}

export const auditVoucher = (setId, id, user) => transitionVoucher(setId, id, 'draft', 'reviewed', 'reviewer', user);
export const postVoucher = (setId, id, user) => transitionVoucher(setId, id, 'reviewed', 'posted', 'poster', user);
export const unauditVoucher = (setId, id, user) => transitionVoucher(setId, id, 'reviewed', 'draft', 'reviewer', user);
export const unpostVoucher = (setId, id, user) => transitionVoucher(setId, id, 'posted', 'reviewed', 'poster', user);

export function deleteVoucher(setId, id) {
  const v = get('SELECT * FROM vouchers WHERE id = ? AND set_id = ?', id, setId);
  if (!v) return fail('凭证不存在');
  if (v.status !== 'draft') return fail('只能删除草稿凭证');
  run('DELETE FROM voucher_entries WHERE voucher_id = ?', id);
  run('DELETE FROM vouchers WHERE id = ?', id);
  return ok(null, '已删除');
}

/* ---------------- 账簿 / 看板 ---------------- */

function periodFigures(setId, period) {
  const rows = all(
    `SELECT e.subject_code, SUM(e.debit) AS debit, SUM(e.credit) AS credit
     FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
     WHERE v.set_id = ? AND v.period = ? AND v.status != 'void'
     GROUP BY e.subject_code`, setId, period);
  const map = new Map();
  for (const r of rows) map.set(r.subject_code, { debit: r.debit || 0, credit: r.credit || 0 });
  return map;
}

export function ledgerBalance(setId, period) {
  if (!/^\d{4}-\d{2}$/.test(period || '')) return fail('期间格式应为 YYYY-MM（或 from~to 且开始不得晚于结束）');
  const seed = readSeed('ledger_balance');
  const roots = (seed?.data?.roots || []).map((r) => ({ ...r, set_id: setId }));
  const figures = periodFigures(setId, period);
  const sign = (dir) => (dir === '借' ? 1 : -1);
  for (const r of roots) {
    const f = figures.get(r.code) || { debit: 0, credit: 0 };
    const s = sign(r.direction);
    Object.assign(r, {
      period_debit: f.debit, period_credit: f.credit,
      year_debit: f.debit, year_credit: f.credit,
      signed_opening: 0, signed_ending: (f.debit - f.credit) * s,
      ending_debit: s > 0 ? Math.max(0, f.debit - f.credit) : 0,
      ending_credit: s < 0 ? Math.max(0, f.credit - f.debit) : 0,
      hasValue: f.debit !== 0 || f.credit !== 0,
    });
  }
  return ok({ period, includeUnposted: false, hideZeroBalance: false, hideZeroAll: false, roots });
}

export function ledgerDetail(setId, { period, subject_code }) {
  if (!/^\d{4}-\d{2}$/.test(period || '')) return fail('期间格式应为 YYYY-MM（或 from~to 且开始不得晚于结束）');
  const params = [setId, period];
  let filter = '';
  if (subject_code) { filter = ' AND e.subject_code LIKE ?'; params.push(`${subject_code}%`); }
  const rows = all(
    `SELECT v.date, v.word, v.no, v.status, e.line, e.summary, e.subject_code,
            e.subject_name, e.debit, e.credit
     FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
     WHERE v.set_id = ? AND v.period = ? AND v.status != 'void'${filter}
     ORDER BY v.date, v.no, e.line`, ...params);
  return ok({ period, rows, total: rows.length });
}

export function dashboardOverview(setId, period) {
  const seed = readSeed('dashboard_overview');
  const base = seed?.data ? JSON.parse(JSON.stringify(seed.data)) : { found: true, months: [] };
  const p = period || new Date().toISOString().slice(0, 7);
  base.period = p;
  base.found = true;
  const figures = periodFigures(setId, p);
  let revenue = 0, cost = 0, expense = 0, capital = 0, ar = 0, ap = 0;
  for (const [code, f] of figures) {
    const net = f.debit - f.credit;
    if (/^60(01|41|51)|^61|^63/.test(code)) revenue += f.credit - f.debit;
    else if (/^64/.test(code)) cost += net;
    else if (/^6[68]/.test(code)) expense += net;
    if (/^100[12]/.test(code)) capital += net;
    if (/^1122/.test(code)) ar += net;
    if (/^2202/.test(code)) ap += net;
  }
  const profit = revenue - cost - expense;
  if (Array.isArray(base.months)) {
    for (const m of base.months) {
      const isCurrent = m.period === p;
      Object.assign(m, {
        revenue: isCurrent ? revenue : m.revenue || 0,
        cost: isCurrent ? cost : m.cost || 0,
        expense: isCurrent ? expense : m.expense || 0,
        profit: isCurrent ? profit : m.profit || 0,
        ar: isCurrent ? ar : m.ar || 0,
        ap: isCurrent ? ap : m.ap || 0,
      });
    }
  }
  base.capital = capital;
  base.revenue = revenue;
  base.profit = profit;
  base.ar = ar;
  base.ap = ap;
  return ok(base);
}

// 按本地凭证分录汇总各业务口径（供看板分项接口复用）
export function dashboardMetrics(setId, period) {
  const figures = periodFigures(setId, period);
  const m = { revenue: 0, cost: 0, expense: 0, profit: 0, capital: 0, ar: 0, ap: 0, tax: 0 };
  for (const [code, f] of figures) {
    const net = f.debit - f.credit;
    if (/^(6001|6041|6051|6101|6111|6115|6117|6301)/.test(code)) m.revenue += f.credit - f.debit;
    else if (/^64/.test(code)) m.cost += net;
    else if (/^(66|68)/.test(code)) m.expense += net;
    if (/^(1001|1002|1012)/.test(code)) m.capital += net;
    if (/^(1121|1122)/.test(code)) m.ar += net;
    if (/^2202/.test(code)) m.ap += -net;
    if (/^2221/.test(code)) m.tax += -net;
  }
  m.profit = m.revenue - m.cost - m.expense;
  return m;
}

function fillCurrentMonth(arr, patch) {
  if (!Array.isArray(arr)) return;
  for (const row of arr) {
    if (row && row.period === patch.period) Object.assign(row, patch.values);
  }
}

// 看板分项接口：复用云端响应结构，数值改用本地凭证计算
export function dashboardSection(name, setId, period) {
  const seed = readSeed(`dash_${name}`);
  if (!seed || seed.code !== 0 || !seed.data || Array.isArray(seed.data)) return fail('未知看板分项');
  const d = JSON.parse(JSON.stringify(seed.data));
  const m = dashboardMetrics(setId, period);
  d.found = true;
  d.period = period;
  const patch = (values) => fillCurrentMonth(d.months, { period, values });

  switch (name) {
    case 'capital':
      d.total = m.capital;
      d.last_week_change = m.capital;
      if (Array.isArray(d.accounts)) d.accounts.forEach((a) => { a.balance = m.capital; });
      if (d.trend && Array.isArray(d.trend.points) && d.trend.points.length) {
        d.trend.points[d.trend.points.length - 1] = m.capital;
      }
      break;
    case 'capital-detail':
      if (Array.isArray(d.rows)) d.rows.forEach((r) => { r.inflow = Math.max(0, m.capital); r.end = m.capital; });
      if (d.total) Object.assign(d.total, { inflow: Math.max(0, m.capital), end: m.capital });
      break;
    case 'revenue':
      if (d.revenue) Object.assign(d.revenue, { month: m.revenue, ytd: m.revenue });
      if (d.ar) d.ar.end = m.ar;
      patch({ revenue: m.revenue, ar_end: m.ar });
      break;
    case 'cost':
      d.month = m.cost; d.ytd = m.cost; d.revenueMonth = m.revenue; d.revenueYtd = m.revenue;
      d.costRateMonth = m.revenue ? Number((m.cost / m.revenue * 100).toFixed(2)) : null;
      d.costRateYtd = d.costRateMonth;
      patch({ amount: m.cost, revenue: m.revenue });
      break;
    case 'profit':
      if (d.profit) Object.assign(d.profit, { month: m.profit, ytd: m.profit });
      if (d.composition) Object.assign(d.composition, {
        income: m.revenue, cost: m.cost, expense: m.expense, profit: m.profit,
      });
      patch({ profit: m.profit });
      break;
    case 'expense':
      d.month = m.expense; d.ytd = m.expense; d.revenueMonth = m.revenue; d.revenueYtd = m.revenue;
      d.expenseRateMonth = m.revenue ? Number((m.expense / m.revenue * 100).toFixed(2)) : null;
      d.expenseRateYtd = d.expenseRateMonth;
      patch({ amount: m.expense, revenue: m.revenue });
      break;
    case 'tax':
      d.total = m.tax; d.revenue = m.revenue;
      d.taxRate = m.revenue ? Number((m.tax / m.revenue * 100).toFixed(2)) : null;
      d.overWarn = false;
      if (Array.isArray(d.items)) d.items.forEach((i) => { i.month = m.tax; i.ytd = m.tax; });
      break;
    case 'ar':
      d.open = 0; d.borrow = m.ar; d.end = m.ar;
      patch({ borrow: m.ar, end: m.ar });
      break;
    case 'ap':
      d.open = 0; d.occur = m.ap; d.end = m.ap;
      patch({ occur: m.ap, end: m.ap });
      break;
    case 'ar-aging':
    case 'ap-aging':
      d.total = name === 'ar-aging' ? m.ar : m.ap;
      d.netTotal = d.total;
      break;
    default:
      break;
  }
  return ok(d);
}

export function bizSettings() {
  return ok(readSeed('dashboard_biz_settings')?.data ?? {});
}

export function closingList(setId, period = new Date().toISOString().slice(0, 7)) {
  const row = get('SELECT * FROM closings WHERE set_id = ? AND period = ?', setId, period);
  const counts = get(
    `SELECT
       SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS draft_count,
       SUM(CASE WHEN status='reviewed' THEN 1 ELSE 0 END) AS reviewed_count,
       SUM(CASE WHEN status='posted' THEN 1 ELSE 0 END) AS posted_count
     FROM vouchers WHERE set_id = ? AND period = ?`, setId, period);
  return ok({
    rows: [{
      period, is_closed: Boolean(row?.is_closed), closed_at: row?.closed_at || '',
      operator: row?.operator || '', total: (counts?.draft_count || 0) + (counts?.reviewed_count || 0) + (counts?.posted_count || 0),
      draft_count: counts?.draft_count || 0, reviewed_count: counts?.reviewed_count || 0,
      posted_count: counts?.posted_count || 0, void_count: 0, reversed_count: 0,
    }],
  });
}

/* ---------------- 开放令牌 ---------------- */

const tokenDto = (t, reveal = false) => ({
  id: t.id, name: t.name, token_prefix: t.token.slice(0, 12),
  scope: t.scope, default_set_id: t.default_set_id,
  expires_at: '', last_used_at: t.last_used_at, revoked_at: t.revoked_at,
  created_at: t.created_at, ...(reveal ? { token: t.token } : {}),
});

export function listTokens() {
  return ok(all('SELECT * FROM open_tokens WHERE revoked_at = ? ORDER BY id', '').map((t) => tokenDto(t)));
}

export function createToken(data) {
  if (!data.name) return fail('请输入令牌名称');
  const token = `jl_at_${randomToken(20)}`;
  const info = run(
    `INSERT INTO open_tokens (name, token, scope, default_set_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    data.name, token, data.scope || 'read,write', data.default_set_id || DEFAULT_SET_ID, now(),
  );
  const row = get('SELECT * FROM open_tokens WHERE id = ?', Number(info.lastInsertRowid));
  return ok(tokenDto(row, true));
}

export function updateToken(id, data) {
  const t = get('SELECT * FROM open_tokens WHERE id = ?', id);
  if (!t) return fail('令牌不存在');
  run('UPDATE open_tokens SET name = ?, scope = ?, default_set_id = ? WHERE id = ?',
    data.name ?? t.name, data.scope ?? t.scope, data.default_set_id ?? t.default_set_id, id);
  return ok(tokenDto(get('SELECT * FROM open_tokens WHERE id = ?', id)));
}

export function deleteToken(id) {
  run('UPDATE open_tokens SET revoked_at = ? WHERE id = ?', now(), id);
  return ok(null, '已撤销');
}

export function tokenFromRequest(token) {
  const t = get('SELECT * FROM open_tokens WHERE token = ? AND revoked_at = ?', token || '', '');
  if (t) run('UPDATE open_tokens SET last_used_at = ? WHERE id = ?', now(), t.id);
  return t || null;
}

/* ---------------- 智能体 ---------------- */

export function agentConfig() {
  const c = get('SELECT * FROM agent_config WHERE user_id = 1');
  const key = c?.api_key || readEnv('DEEPSEEK_API_KEY') || '';
  const desc = llm.describeModel(c?.model || readEnv('DEEPSEEK_MODEL') || 'deepseek-chat');
  return ok({
    configured: Boolean(c?.configured) || Boolean(key), has_global: Boolean(key),
    provider: c?.provider || 'deepseek', base_url: c?.base_url || '',
    model: desc.configured_model, effective_model: desc.effective_model, model_aliased: desc.aliased,
    key_hint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '',
    tested_at: c?.tested_at || '',
  });
}

export function saveAgentConfig(data) {
  run('INSERT OR IGNORE INTO agent_config (user_id) VALUES (1)');
  const cur = get('SELECT * FROM agent_config WHERE user_id = 1') || {};
  // 前端只改模型/接口地址时可能不回传 api_key；空值一律视为「保持不变」，
  // 否则一次保存就会把本来可用的 key 清空，变成难以排查的智能体故障。
  const key = String(data.api_key || '').trim() || cur.api_key || '';
  const provider = data.provider || cur.provider || 'deepseek';
  const baseUrl = data.base_url || cur.base_url || 'https://api.deepseek.com/v1';
  const model = data.model || cur.model || readEnv('DEEPSEEK_MODEL') || 'deepseek-chat';
  run(`UPDATE agent_config SET provider = ?, base_url = ?, model = ?, api_key = ?, configured = ?
       WHERE user_id = 1`, provider, baseUrl, model, key, key ? 1 : 0);
  const desc = llm.describeModel(model);
  return ok({ ...desc }, `已保存：${desc.configured_model}${desc.aliased ? ` → ${desc.effective_model}` : ''}`);
}

/** 「恢复默认」= 清掉 DB 里的自定义配置，回落到 .env（key 与模型都还在） */
export function resetAgentConfig() {
  run('INSERT OR IGNORE INTO agent_config (user_id) VALUES (1)');
  const model = readEnv('DEEPSEEK_MODEL') || 'deepseek-chat';
  run(`UPDATE agent_config SET provider = ?, base_url = ?, model = ?, api_key = ?, configured = ?, tested_at = ?
       WHERE user_id = 1`, 'deepseek', '', model, '', 0, '');
  const desc = llm.describeModel(model);
  return ok(null, `已恢复默认：回落到 .env（${desc.configured_model} → ${desc.effective_model}）`);
}

export function agentSkills() {
  return ok(readSeed('agent_skills')?.data ?? { list: [] });
}

export function agentSessions(setId) {
  // 历史会话名补齐：老版本留下的「新对话」按首条真实消息回填，刷新即生效。
  // 只改 agent_sessions.title，且被 title_source='manual' 挡住，绝不覆盖人工命名。
  sessionTitle.backfillTitles(setId);
  return ok(all('SELECT * FROM agent_sessions WHERE set_id = ? ORDER BY pinned DESC, created_at DESC', setId)
    .map((s) => ({ id: s.id, title: s.title, pinned: Number(s.pinned || 0), created_at: s.created_at })));
}

export function createAgentSession(setId, title = '新对话') {
  const id = randomToken(12);
  const clean = sessionTitle.sanitizeTitle(title, 40) || '新对话';
  const source = sessionTitle.isDefaultTitle(clean) ? '' : 'manual';
  run('INSERT INTO agent_sessions (id, set_id, title, title_source, created_at) VALUES (?, ?, ?, ?, ?)',
    id, setId, clean, source, now());
  return ok({ id, title: clean, pinned: 0, created_at: now() });
}

/** 重命名（title）与置顶（pinned）共用前端的 PUT /agent/sessions/:id */
export function updateAgentSession(setId, id, data = {}) {
  if (!get('SELECT id FROM agent_sessions WHERE id = ? AND set_id = ?', id, setId)) {
    return fail('会话不存在或不属于当前账套');
  }
  if (Object.prototype.hasOwnProperty.call(data, 'title')) {
    const title = String(data.title ?? '').trim();
    if (!title || title.length > 40) return fail('会话名称须为 1-40 个字符');
    // 人工重命名后打标，自动命名（含 LLM 精修）不再覆盖用户的选择
    run("UPDATE agent_sessions SET title = ?, title_source = 'manual' WHERE id = ? AND set_id = ?", title, id, setId);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'pinned')) {
    run('UPDATE agent_sessions SET pinned = ? WHERE id = ?', data.pinned ? 1 : 0, id);
  }
  const row = get('SELECT id, title, pinned, created_at FROM agent_sessions WHERE id = ?', id);
  return ok({ ...row, pinned: Number(row.pinned || 0) });
}

/** 事务级联删除会话消息，避免孤儿消息；按 set_id 校验，防止跨账套删除 */
export function deleteAgentSession(setId, id) {
  if (!get('SELECT id FROM agent_sessions WHERE id = ? AND set_id = ?', id, setId)) {
    return fail('会话不存在或不属于当前账套');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM agent_messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(`删除失败：${e.message}`);
  }
  return ok({ id });
}

export function agentMessages(sessionId) {
  return ok(all('SELECT role, content, created_at FROM agent_messages WHERE session_id = ? ORDER BY id', sessionId));
}

export function saveAgentMessage(sessionId, role, content) {
  run('INSERT INTO agent_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    sessionId, role, content, now());
}

/**
 * 会话活跃度快照：供桌面端做「有新对话就静默刷新」。
 * 只返回计数与最大消息 id，不返回消息正文，轮询开销极小。
 */
export function agentActivity(setId) {
  const rows = all(`SELECT m.session_id AS session_id, COUNT(*) AS messages,
      MAX(m.id) AS last_id, MAX(m.created_at) AS last_at
    FROM agent_messages m
    JOIN agent_sessions s ON s.id = m.session_id
    WHERE s.set_id = ?
    GROUP BY m.session_id`, setId);
  const total = rows.reduce((a, r) => a + Number(r.messages || 0), 0);
  const lastId = rows.reduce((a, r) => Math.max(a, Number(r.last_id || 0)), 0);
  return ok({ total, last_id: lastId, sessions: rows.length });
}

/* 智能体「知识 / 记忆」与「我的规则」。前端 knowledge 需要 { guide, memories }，
   rules / my-rules 需要 { content }；两者都按账套隔离。 */
export function agentKnowledge(setId) {
  return ok({
    guide: '在这里添加业务约定与偏好，智能体每次对话都会参考这些记忆。',
    memories: all('SELECT id, content, created_at FROM agent_memories WHERE set_id = ? ORDER BY id DESC', setId),
  });
}

export function createAgentMemory(setId, content) {
  const c = String(content || '').trim();
  if (!c) return fail('记忆内容不能为空');
  if (c.length > 500) return fail('记忆内容不能超过 500 字');
  const info = run('INSERT INTO agent_memories (set_id, content, created_at) VALUES (?, ?, ?)', setId, c, now());
  return ok({ id: Number(info.lastInsertRowid), content: c, created_at: now() });
}

export function deleteAgentMemory(setId, id) {
  const r = run('DELETE FROM agent_memories WHERE id = ? AND set_id = ?', Number(id), setId);
  if (!r.changes) return fail('记忆不存在或不属于当前账套');
  return ok({ id: Number(id) });
}

export function agentRules(setId) {
  return ok({ content: get('SELECT content FROM agent_rules WHERE set_id = ?', setId)?.content || '' });
}

export function saveAgentRules(setId, content) {
  const c = String(content || '');
  if (c.length > 5000) return fail('规则内容不能超过 5000 字');
  run(`INSERT INTO agent_rules (set_id, content, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(set_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    setId, c, now());
  return ok({ content: c }, '规则已保存，后续对话立即生效');
}

/** 组装 system prompt：基础人设 + 我的规则 + 知识记忆，让「立即生效」不是空话 */
export function agentSystemPrompt(setId) {
  // 旧提示词只说「你是财务助手」，模型会幻觉成「我无法访问你的账务系统，
  // 请提供数据」——但本软件后端直连本地 SQLite 账套，账套就是数据源。
  const setRow = get('SELECT name FROM sets WHERE id = ?', setId);
  const voucherCount = get('SELECT COUNT(*) AS n FROM vouchers WHERE set_id = ?', setId)?.n || 0;
  const parts = [
    '你是妆点管账（本地桌面财务软件）内置的财务助手，回答简洁、专业，涉及金额时保留两位小数。',
    `【运行环境】你运行在本机，后端已直连本地账套「${setRow?.name || '本地账套'}」（ID ${setId}，当前已录入 ${voucherCount} 张凭证）。可查询科目、凭证、账簿、资产、发票与报表，并能生成 CSV/XLSX/JSON/MD/HTML/PDF 等报表文件。`,
    '【重要】用户索要报表、凭证、余额或经营数据时，绝对不要回答「无法访问账务系统」「请提供数据」之类的话——本地账套本身就是数据源。应说明可以从本地账套取数，并引导用户用输入框上方的「意图追问」逐步确认输出形式/格式/期间，或到「报表导出中心 / 文件格式转换」下载文件。',
    '【数据真实性】不要编造具体金额、凭证号或科目余额；没有确切数字时只给取数方法，或说明需要按上述方式生成报表。',
  ];
  const rules = agentRules(setId).data.content.trim();
  if (rules) parts.push(`【用户自定义规则】\n${rules.slice(0, 2000)}`);
  const memories = agentKnowledge(setId).data.memories.slice(0, 20);
  if (memories.length) parts.push(`【业务记忆】\n${memories.map((m) => `- ${m.content}`).join('\n').slice(0, 2000)}`);
  return parts.join('\n\n');
}

/* ---------------- 辅助档案 ---------------- */

export function listAuxiliaries(setId) {
  return ok(all('SELECT * FROM auxiliaries WHERE set_id = ? ORDER BY id', setId));
}
export function createAuxiliary(setId, data) {
  const info = run('INSERT INTO auxiliaries (set_id, type, code, name, created_at) VALUES (?, ?, ?, ?, ?)',
    setId, data.type || '', data.code || '', data.name || '', now());
  return ok(get('SELECT * FROM auxiliaries WHERE id = ?', Number(info.lastInsertRowid)));
}
export function listAssets(setId) {
  return ok(all('SELECT * FROM assets WHERE set_id = ? ORDER BY id', setId));
}
export function createAsset(setId, data) {
  const info = run(`INSERT INTO assets (set_id, code, name, category, amount, purchased_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    setId, data.code || '', data.name || '', data.category || '', Number(data.amount || 0),
    data.purchased_at || '', now());
  return ok(get('SELECT * FROM assets WHERE id = ?', Number(info.lastInsertRowid)));
}
export function listAssetCategories(setId) {
  return ok(all('SELECT * FROM asset_categories WHERE set_id = ? ORDER BY id', setId));
}
export function listInvoices(setId, query = {}) {
  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || 20;
  const total = get('SELECT COUNT(*) AS n FROM invoices WHERE set_id = ?', setId).n;
  const list = all('SELECT * FROM invoices WHERE set_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
    setId, pageSize, (page - 1) * pageSize);
  return ok({ list, total, page, pageSize });
}
export function createInvoice(setId, data) {
  const info = run(`INSERT INTO invoices (set_id, number, kind, amount, invoice_date, file_name, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    setId, data.number || '', data.kind || '', Number(data.amount || 0),
    data.invoice_date || '', data.file_name || data.fileName || '', now());
  return ok(get('SELECT * FROM invoices WHERE id = ?', Number(info.lastInsertRowid)));
}
export function listInvoiceTemplates(setId) {
  return ok(all('SELECT * FROM invoice_templates WHERE set_id = ? ORDER BY id', setId));
}
export function createInvoiceVoucher(setId, invoiceId, user = 'admin') {
  const inv = get('SELECT * FROM invoices WHERE id = ? AND set_id = ?', invoiceId, setId);
  if (!inv) return fail('发票不存在');
  const subjectCode = inv.kind === '销项' || inv.kind === 'output' ? '6001' : '6401';
  const otherCode = inv.kind === '销项' || inv.kind === 'output' ? '1122' : '2202';
  return createVoucher(setId, {
    date: inv.invoice_date || new Date().toISOString().slice(0, 10),
    summary: `发票 ${inv.number}`,
    entries: [
      { summary: `发票 ${inv.number}`, subject_code: otherCode, debit: inv.amount, credit: 0 },
      { summary: `发票 ${inv.number}`, subject_code: subjectCode, debit: 0, credit: inv.amount },
    ],
  }, user);
}

/* ---------------- MCP 19 工具 ---------------- */

export function callTool(name, args = {}, setId = DEFAULT_SET_ID, user = 'workbuddy') {
  const sid = parseSetId(args.set_id || setId);
  switch (name) {
    case 'list_sets': return listSets();
    case 'list_vouchers': return listVouchers(sid, args);
    case 'get_voucher': return getVoucher(sid, args.id || args.voucher_id);
    case 'get_ledger': return args.type === 'detail'
      ? ledgerDetail(sid, args)
      : ledgerBalance(sid, args.period || new Date().toISOString().slice(0, 7));
    // 真实报表：与 /api/export/report 共用同一份本地查询，不再返回空 rows。
    // WorkBuddy 等 MCP 调用方拿到的 columns/rows 可直接用于录入、比对或再加工。
    case 'get_report': {
      const alias = {
        'balance-sheet': 'ledger', balance: 'ledger', 'trial-balance': 'ledger',
        overview: 'dashboard', profit: 'dashboard', 'subject-list': 'subjects',
      };
      const raw = String(args.kind || args.type || 'vouchers').trim();
      const kind = alias[raw.toLowerCase()] || raw;
      const period = String(args.period || '').trim();
      const format = String(args.format || 'json').trim();
      try {
        const { table, period: p } = exp.reportTable({ kind, period, setId: sid });
        const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 1000);
        const rows = table.rows.slice(0, limit);
        const out = exp.buildReport({ kind, period: p, format, setId: sid });
        return ok({
          kind, period: p, format, title: table.title,
          columns: table.columns, rows,
          row_count: table.rows.length, truncated: table.rows.length > rows.length,
          filename: out.filename,
          download_url: `/api/export/download?file=${encodeURIComponent(out.filename)}`,
        }, `已按本地账套真实数据生成 ${table.title}（${table.rows.length} 行）`);
      } catch (e) {
        return fail(`报表生成失败：${e.message}`);
      }
    }
    case 'list_assets': return listAssets(sid);
    case 'list_asset_categories': return listAssetCategories(sid);
    case 'list_subjects': return listSubjects(sid);
    case 'list_auxiliaries': return listAuxiliaries(sid);
    case 'list_invoices': return listInvoices(sid, args);
    case 'get_closing_status': return closingList(sid, args.period);
    case 'create_voucher': return createVoucher(sid, args, user);
    case 'create_asset': return createAsset(sid, args);
    case 'create_subject': return createSubject(sid, args);
    case 'create_auxiliary': return createAuxiliary(sid, args);
    case 'upload_invoice':
    case 'create_invoice': return createInvoice(sid, args);
    case 'list_invoice_templates': return listInvoiceTemplates(sid);
    case 'create_invoice_voucher': return createInvoiceVoucher(sid, args.invoice_id || args.id, user);
    default: return fail(`未知工具: ${name}`);
  }
}

export { parseSetId };
