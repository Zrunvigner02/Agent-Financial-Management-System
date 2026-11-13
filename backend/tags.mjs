/**
 * 通用标注：给业务对象挂「离职 / 调岗 / 钱货两讫 / 已结清 / 作废」等状态。
 * 规则：只新增、不作物理删除；撤销用 voided=1 留痕。
 * entity_type：recurring（固定支出模板/员工）、invoice（发票/订单）、voucher、asset
 */
import { get, all, run, now } from './store.mjs';

const ok = (data, message = '') => ({ code: 0, message, data });
const fail = (message) => ({ code: 1, message, data: null });

export const TAGS = ['离职', '调岗', '钱货两讫', '已结清', '作废', '暂停'];
const TYPES = ['recurring', 'invoice', 'voucher', 'asset'];

export function addTag(setId, data = {}, user = '') {
  const type = String(data.entity_type || data.type || '').trim();
  const id = Number(data.entity_id || data.id || 0);
  const tag = String(data.tag || '').trim();
  if (!TYPES.includes(type)) return fail(`标注对象类型应为：${TYPES.join(' / ')}`);
  if (!id) return fail('缺少对象编号');
  if (!tag) return fail('缺少标注内容');
  const eff = String(data.effective_from || '').trim();
  if (eff && !/^\d{4}-(0[1-9]|1[0-2])$/.test(eff)) return fail('生效月份格式应为 YYYY-MM');

  const dup = get(`SELECT * FROM entity_tags
    WHERE set_id=? AND entity_type=? AND entity_id=? AND tag=? AND voided=0 AND effective_from=?`,
    setId, type, id, tag, eff);
  if (dup) return ok({ id: dup.id, duplicate: true }, '该标注已存在，未重复添加');

  const info = run(`INSERT INTO entity_tags
    (set_id, entity_type, entity_id, tag, note, effective_from, voided, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    setId, type, id, tag, String(data.note || ''), eff, String(user || ''), now());
  return ok({ id: Number(info.lastInsertRowid), entity_type: type, entity_id: id, tag, effective_from: eff },
    `已标注「${tag}」${eff ? `（自 ${eff} 起）` : ''}`);
}

export function listTags(setId, { entity_type, entity_id, includeVoided = false } = {}) {
  let sql = 'SELECT * FROM entity_tags WHERE set_id = ?';
  const params = [setId];
  if (entity_type) { sql += ' AND entity_type = ?'; params.push(entity_type); }
  if (entity_id) { sql += ' AND entity_id = ?'; params.push(Number(entity_id)); }
  if (!includeVoided) sql += ' AND voided = 0';
  sql += ' ORDER BY id DESC';
  return all(sql, ...params).map((r) => ({
    id: r.id, entity_type: r.entity_type, entity_id: r.entity_id, tag: r.tag,
    note: r.note, effective_from: r.effective_from, voided: Boolean(r.voided),
    created_by: r.created_by, created_at: r.created_at,
  }));
}

export function voidTag(setId, id) {
  const row = get('SELECT * FROM entity_tags WHERE id = ? AND set_id = ?', Number(id), setId);
  if (!row) return fail('标注不存在');
  run('UPDATE entity_tags SET voided = 1 WHERE id = ?', Number(id));
  return ok({ id: Number(id) }, '已撤销该标注（留痕，不删除）');
}

/** 取某类对象的最新标注，返回 Map<entity_id, {离职?: effective_from, ...}> */
export function tagMap(setId, entityType) {
  const map = new Map();
  for (const t of listTags(setId, { entity_type: entityType })) {
    if (!map.has(t.entity_id)) map.set(t.entity_id, {});
    map.get(t.entity_id)[t.tag] = t.effective_from || '';
  }
  return map;
}
