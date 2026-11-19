/**
 * 实体生命周期：员工离职 / 品牌不做 / 渠道停用
 *
 * 一条铁律：**历史一个字都不删，未来一天都不多算。**
 *   - 已经发生的凭证、销售、报表、对话，原样留在库里，随时能查；
 *   - 从「最后有效日」的次日起，不再自动产生这个实体的支出 / 业绩 / 报表。
 *
 * 怎么表达"最后有效日"：
 *   effective_to = 最后一天仍然有效的日期（含当天）。
 *   例：张三 11 月 16 日离职 → effective_to = 2026-11-16 → 11/17 起不再算他。
 *   例：品牌世家 11 月底停 → effective_to = 2026-11-30 → 12/1 起不再入表。
 *
 * 与旧机制（entity_tags 里的「离职」标注）的关系：
 *   旧标注只到"月"，语义是「该月起不再生成」。这里仍然兼容读取，
 *   统一折算成 effective_to = 该月月初的前一天；新数据一律写 entity_status。
 *
 * 只做三件事：查询状态、写状态、按日期判定。具体怎么用由各模块决定。
 */
import { get, all, run, now } from './store.mjs';

const ok = (data, message = '') => ({ code: 0, message, data });
const fail = (message) => ({ code: 1, message, data: null });
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 可停用的实体类型：员工 / 品牌 / 渠道 / 店铺 */
export const TYPES = ['staff', 'brand', 'channel', 'store'];
export const TYPE_LABEL = { staff: '员工', brand: '品牌', channel: '渠道', store: '店铺' };

const pad2 = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const monthDays = (period) => new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate();

export function ensureStatusTables() {
  run(`CREATE TABLE IF NOT EXISTS entity_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    effective_from TEXT NOT NULL DEFAULT '',
    effective_to TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    prorate INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(set_id, type, name)
  )`);
  run('CREATE INDEX IF NOT EXISTS idx_entity_status ON entity_status(set_id, type, status)');
  // 变更留痕：谁在什么时候、依据什么话、把谁停了
  run(`CREATE TABLE IF NOT EXISTS entity_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    action TEXT NOT NULL,
    effective_to TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  run('CREATE INDEX IF NOT EXISTS idx_entity_log ON entity_status_log(set_id, type, name)');
}

/* ---------------- 读 ---------------- */

export function statusOf(setId, type, name) {
  ensureStatusTables();
  const n = String(name || '').trim();
  if (!n) return null;
  const row = get('SELECT * FROM entity_status WHERE set_id = ? AND type = ? AND name = ?', setId, type, n);
  return row ? rowOf(row) : null;
}

function rowOf(r) {
  return {
    id: r.id, type: r.type, name: r.name, status: r.status,
    effective_from: r.effective_from || '', effective_to: r.effective_to || '',
    reason: r.reason || '', note: r.note || '',
    prorate: Number(r.prorate) !== 0,
    created_by: r.created_by || '', created_at: r.created_at, updated_at: r.updated_at,
    stopped: r.status === 'stopped',
  };
}

export function listStatus(setId, { type = '', includeActive = true } = {}) {
  ensureStatusTables();
  const params = [setId];
  let sql = 'SELECT * FROM entity_status WHERE set_id = ?';
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (!includeActive) sql += " AND status = 'stopped'";
  sql += ' ORDER BY status DESC, effective_to DESC, name';
  const rows = all(sql, ...params).map(rowOf);
  const logs = all(`SELECT * FROM entity_status_log WHERE set_id = ? ORDER BY id DESC LIMIT 50`, setId);
  return ok({ items: rows, logs });
}

/** 停用映射：Map<name, effective_to>，只含已停用的 */
export function stoppedMap(setId, type) {
  ensureStatusTables();
  const rows = all(`SELECT name, effective_to FROM entity_status
    WHERE set_id = ? AND type = ? AND status = 'stopped'`, setId, type);
  return new Map(rows.map((r) => [r.name, r.effective_to || '']));
}

/**
 * 建一个"日期判定器"，聚合时用它过滤行，避免每行查库。
 * allowed(date) → true 表示这一天仍然算这个人 / 这个品牌。
 */
export function dayFilter(setId, type) {
  const map = stoppedMap(setId, type);
  return (name, date) => {
    const to = map.get(String(name || '').trim());
    if (to === undefined) return true;          // 没登记 = 默认有效
    if (!to) return true;                        // 停用但没给日期 = 不按日期卡
    return String(date || '').slice(0, 10) <= to;
  };
}

export function isActiveOn(setId, type, name, date) {
  return dayFilter(setId, type)(name, date);
}

/* ---------------- 写 ---------------- */

/**
 * 停用 / 恢复。
 *   action: 'stop' | 'resume'
 *   effective_to: 最后有效日（stop 必填；也接受 effective_from 作为别名，按最后有效日理解）
 */
export function setStatus(setId, data = {}, user = '') {
  ensureStatusTables();
  const type = String(data.type || data.entity_type || '').trim();
  const name = String(data.name || data.person || data.brand || '').trim();
  const action = String(data.action || (data.status === 'active' ? 'resume' : 'stop')).toLowerCase();

  if (!TYPES.includes(type)) return fail(`类型应为：${TYPES.join(' / ')}`);
  if (!name) return fail('请给出名称（员工姓名 / 品牌名 / 渠道名）');

  const effTo = String(data.effective_to || data.effectiveTo || data.date || data.effective_from || '').trim();
  const effFrom = String(data.effective_from || '').trim();
  const reason = String(data.reason || '').slice(0, 200);
  const note = String(data.note || '').slice(0, 200);
  const prorate = data.prorate === false || data.prorate === 0 ? 0 : 1;

  if (action === 'resume') {
    const exist = get('SELECT * FROM entity_status WHERE set_id = ? AND type = ? AND name = ?', setId, type, name);
    if (!exist) return fail('没有停用记录，无需恢复');
    run(`UPDATE entity_status SET status = 'active', effective_to = '', reason = ?, note = ?, updated_at = ?
      WHERE id = ?`, reason || exist.reason, note || exist.note, now(), exist.id);
    run(`INSERT INTO entity_status_log (set_id, type, name, action, effective_to, reason, actor, created_at)
      VALUES (?, ?, ?, 'resume', '', ?, ?, ?)`, setId, type, name, reason, String(user || ''), now());
    return ok({ type, name, status: 'active' }, `已恢复 ${TYPE_LABEL[type]}「${name}」，历史数据不受影响`);
  }

  // 允许只给月份：按该月最后一天算（「11 月做完」= 11-30）
  let to = effTo;
  if (MONTH_RE.test(to)) to = `${to}-${pad2(monthDays(to))}`;
  if (!to) return fail('请给出停用生效日（最后有效日），例如 2026-11-16');
  if (!DAY_RE.test(to)) return fail('日期格式应为 YYYY-MM-DD 或 YYYY-MM');
  const exist = get('SELECT * FROM entity_status WHERE set_id = ? AND type = ? AND name = ?', setId, type, name);
  if (exist) {
    run(`UPDATE entity_status SET status = 'stopped', effective_to = ?, reason = ?, note = ?, prorate = ?,
      updated_at = ? WHERE id = ?`, to, reason || exist.reason, note || exist.note, prorate, now(), exist.id);
  } else {
    run(`INSERT INTO entity_status (set_id, type, name, status, effective_from, effective_to, reason, note,
      prorate, created_by, created_at, updated_at) VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?)`,
    setId, type, name, effFrom, to, reason, note, prorate, String(user || ''), now(), now());
  }
  run(`INSERT INTO entity_status_log (set_id, type, name, action, effective_to, reason, actor, created_at)
    VALUES (?, ?, ?, 'stop', ?, ?, ?, ?)`, setId, type, name, to, reason, String(user || ''), now());

  const extra = type === 'staff'
    ? `；${to} 之后不再生成其固定支出、不再计其业绩（历史全部保留）`
    : `；${to} 之后不再自动入表（历史全部保留）`;
  return ok({ type, name, status: 'stopped', effective_to: to, prorate: Boolean(prorate) },
    `已停用${TYPE_LABEL[type]}「${name}」，最后有效日 ${to}${extra}`);
}

/**
 * 按月折算：仅当停用日落在该月中间时才打折。
 * 返回 amount（折算后金额）、days（在职天数）、monthDays（当月天数）。
 */
export function prorateMonth(amount, period, effectiveTo, { prorate = true } = {}) {
  const total = monthDays(period);
  const first = `${period}-01`;
  const last = `${period}-${pad2(total)}`;
  const raw = Number(amount) || 0;
  if (!effectiveTo) return { amount: raw, days: total, monthDays: total, ratio: 1, prorated: false, reason: '' };
  if (effectiveTo < first) return { amount: 0, days: 0, monthDays: total, ratio: 0, prorated: true, reason: 'stopped_before_month' };
  if (effectiveTo >= last) return { amount: raw, days: total, monthDays: total, ratio: 1, prorated: false, reason: '' };
  const days = Number(effectiveTo.slice(8, 10));
  const ratio = days / total;
  return {
    amount: prorate ? Math.round(raw * ratio * 100) / 100 : raw,
    days, monthDays: total, ratio, prorated: true, reason: 'mid_month',
  };
}

/** 旧「离职」标注（按月）→ 折算成最后有效日：该月月初的前一天 */
export function legacyMonthToDate(periodMonth) {
  if (!MONTH_RE.test(String(periodMonth || ''))) return '';
  const [y, m] = periodMonth.split('-').map(Number);
  const d = new Date(y, m - 1, 0); // 上个月最后一天
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export const _internal = { monthDays, todayStr };
