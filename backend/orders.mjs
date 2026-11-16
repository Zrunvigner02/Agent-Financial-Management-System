/**
 * 订单：状态流转、退货、改价、物流、汇总分析。
 *
 * 状态：open 进行中 / partial 部分发货 / settled 已结清 / returning 退货中 / returned 已退货 / cancelled 已取消
 * 物流：pending 待发货 / picked 已揽收 / transit 运输中 / delivering 派送中 / signed 已签收 / returned 退回
 *
 * 只写订单相关表；不自动生成凭证（记账仍需人工确认）。
 */
import { get, all, run, now } from './store.mjs';

const ok = (data, message = '') => ({ code: 0, message, data });
const fail = (message) => ({ code: 1, message, data: null });
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const STATUS_LABEL = {
  open: '进行中', partial: '部分发货', settled: '已结清', returning: '退货中', returned: '已退货', cancelled: '已取消',
};
export const SHIP_LABEL = {
  pending: '待发货', picked: '已揽收', transit: '运输中', delivering: '派送中', signed: '已签收', returned: '退回',
};
const STATUS = Object.keys(STATUS_LABEL);
const SHIP = Object.keys(SHIP_LABEL);

const normStatus = (s) => {
  const v = String(s || '').trim();
  if (STATUS.includes(v)) return v;
  const hit = Object.entries(STATUS_LABEL).find(([, label]) => label === v);
  return hit ? hit[0] : '';
};
const normShip = (s) => {
  const v = String(s || '').trim();
  if (SHIP.includes(v)) return v;
  const hit = Object.entries(SHIP_LABEL).find(([, label]) => label === v);
  return hit ? hit[0] : '';
};

function nextOrderNo(setId) {
  const row = get('SELECT COUNT(*) AS n FROM orders WHERE set_id = ?', setId);
  return `SO${String(new Date().getFullYear()).slice(2)}${String(Number(row.n) + 1).padStart(5, '0')}`;
}

function logEvent(orderId, type, fromV, toV, note, user, at) {
  run(`INSERT INTO order_events (order_id, type, from_v, to_v, note, effective_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, orderId, type, String(fromV || ''), String(toV || ''),
  String(note || ''), String(at || now()), String(user || ''), now());
}

function recompute(orderId) {
  const items = all('SELECT * FROM order_items WHERE order_id = ?', orderId);
  const amount = money(items.reduce((s, it) => s + Number(it.amount || 0), 0));
  const cost = money(items.reduce((s, it) => s + Number(it.cost || 0), 0));
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  const net = money(Math.max(0, amount - Number(o.discount || 0)));
  run('UPDATE orders SET amount = ?, cost = ?, updated_at = ? WHERE id = ?', amount, cost, now(), orderId);
  return { amount, cost, net };
}

/* ---------------- 订单 ---------------- */

export function createOrder(setId, data = {}, user = '') {
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) return fail('订单至少要有一条明细');
  for (const [i, it] of items.entries()) {
    if (!(Number(it.qty) > 0)) return fail(`第 ${i + 1} 行数量必须大于 0`);
    if (!(Number(it.unit_price) >= 0)) return fail(`第 ${i + 1} 行单价不能为负`);
  }
  const orderNo = String(data.order_no || '').trim() || nextOrderNo(setId);
  if (get('SELECT 1 FROM orders WHERE set_id = ? AND order_no = ?', setId, orderNo)) return fail(`订单号 ${orderNo} 已存在`);
  const date = String(data.order_date || new Date().toLocaleDateString('sv-SE')).slice(0, 10);
  const info = run(`INSERT INTO orders (set_id, order_no, customer, channel, status, amount, discount, cost, order_date, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', 0, ?, 0, ?, ?, ?, ?)`,
  setId, orderNo, String(data.customer || ''), String(data.channel || ''),
  money(data.discount || 0), date, String(data.note || ''), now(), now());
  const id = Number(info.lastInsertRowid);
  for (const it of items) {
    const qty = Number(it.qty);
    const price = money(it.unit_price);
    run(`INSERT INTO order_items (order_id, sku, name, qty, unit_price, amount, returned_qty, cost)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`, id, String(it.sku || ''), String(it.name || ''),
    qty, price, money(qty * price), money(it.cost || 0));
  }
  const t = recompute(id);
  logEvent(id, 'status', '', 'open', '创建订单', user, date);
  return ok({ id, order_no: orderNo, amount: t.net }, `已建单 ${orderNo}，应收 ${t.net} 元`);
}

export function updateStatus(setId, id, status, note = '', user = '') {
  const o = get('SELECT * FROM orders WHERE id = ? AND set_id = ?', Number(id), setId);
  if (!o) return fail('订单不存在');
  const to = normStatus(status);
  if (!to) return fail(`状态应为：${STATUS.map((k) => `${k}=${STATUS_LABEL[k]}`).join('、')}`);
  if (to === o.status) return ok({ id: o.id, status: to }, '状态未变化');
  if (o.status === 'returned' && to !== 'open') return fail('已退货订单不能改回其它状态，除非先退回「进行中」');
  run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', to, now(), Number(id));
  logEvent(Number(id), 'status', o.status, to, note, user, now());
  return ok({ id: Number(id), status: to, label: STATUS_LABEL[to] }, `订单 ${o.order_no} 已改为「${STATUS_LABEL[to]}」`);
}

export function changePrice(setId, id, { item_id, new_price, reason = '' } = {}, user = '') {
  const o = get('SELECT * FROM orders WHERE id = ? AND set_id = ?', Number(id), setId);
  if (!o) return fail('订单不存在');
  const item = get('SELECT * FROM order_items WHERE id = ? AND order_id = ?', Number(item_id), Number(id));
  if (!item) return fail('订单明细不存在');
  if (!(Number(new_price) >= 0)) return fail('新单价不能为负');
  const oldPrice = money(item.unit_price);
  const newP = money(new_price);
  const amount = money(Number(item.qty) * newP);
  run('UPDATE order_items SET unit_price = ?, amount = ? WHERE id = ?', newP, amount, item.id);
  run(`INSERT INTO order_price_changes (order_id, item_id, old_price, new_price, reason, effective_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, Number(id), item.id, oldPrice, newP, String(reason || ''), now(), now());
  logEvent(Number(id), 'price', String(oldPrice), String(newP), reason || '改价', user, now());
  const t = recompute(Number(id));
  const delta = money(newP - oldPrice);
  return ok({ id: Number(id), item_id: item.id, old_price: oldPrice, new_price: newP, amount: t.net },
    `已改价 ${oldPrice} → ${newP}（${delta > 0 ? '+' : ''}${delta} 元），订单金额 ${t.net} 元`);
}

export function returnItems(setId, id, { item_id, qty, reason = '' } = {}, user = '') {
  const o = get('SELECT * FROM orders WHERE id = ? AND set_id = ?', Number(id), setId);
  if (!o) return fail('订单不存在');
  const items = item_id
    ? [get('SELECT * FROM order_items WHERE id = ? AND order_id = ?', Number(item_id), Number(id))].filter(Boolean)
    : all('SELECT * FROM order_items WHERE order_id = ?', Number(id));
  if (!items.length) return fail('订单明细不存在');

  let returned = 0;
  for (const it of items) {
    const remain = Number(it.qty) - Number(it.returned_qty || 0);
    const q = item_id ? Number(qty) : remain;
    if (!(q > 0)) continue;
    if (q > remain + 1e-6) return fail(`退货数量超过可退数量（${it.name} 可退 ${remain}）`);
    run('UPDATE order_items SET returned_qty = COALESCE(returned_qty, 0) + ? WHERE id = ?', q, it.id);
    returned += q;
  }
  if (!returned) return fail('没有可退数量');
  const after = all('SELECT * FROM order_items WHERE order_id = ?', Number(id));
  const allBack = after.every((it) => Number(it.returned_qty || 0) >= Number(it.qty) - 1e-6);
  const status = allBack ? 'returned' : 'returning';
  run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, now(), Number(id));
  logEvent(Number(id), 'return', o.status, status, `${reason || '退货'} 共 ${returned} 件`, user, now());
  return ok({ id: Number(id), returned, status, label: STATUS_LABEL[status] },
    `已登记退货 ${returned} 件，订单状态「${STATUS_LABEL[status]}」`);
}

export function addShipment(setId, id, { carrier = '', tracking_no = '', status = 'pending', note = '', last_event = '' } = {}, user = '') {
  const o = get('SELECT * FROM orders WHERE id = ? AND set_id = ?', Number(id), setId);
  if (!o) return fail('订单不存在');
  const st = normShip(status) || 'pending';
  const last = get('SELECT * FROM order_shipments WHERE order_id = ? ORDER BY id DESC LIMIT 1', Number(id));
  if (last && last.tracking_no && last.tracking_no === String(tracking_no || last.tracking_no)) {
    run(`UPDATE order_shipments SET carrier = ?, status = ?, last_event = ?, last_event_at = ?, note = ?, updated_at = ? WHERE id = ?`,
      String(carrier || last.carrier), st, String(last_event || SHIP_LABEL[st]), now(),
      String(note || last.note), now(), last.id);
    logEvent(Number(id), 'shipment', last.status, st, last_event || SHIP_LABEL[st], user, now());
    return ok({ id: Number(id), shipment_id: last.id, status: st, label: SHIP_LABEL[st] }, `物流已更新为「${SHIP_LABEL[st]}」`);
  }
  const info = run(`INSERT INTO order_shipments (order_id, carrier, tracking_no, status, last_event, last_event_at, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, Number(id), String(carrier), String(tracking_no), st,
  String(last_event || SHIP_LABEL[st]), now(), String(note), now(), now());
  logEvent(Number(id), 'shipment', '', st, `${carrier} ${tracking_no}`.trim(), user, now());
  if (st === 'signed' && ['open', 'partial'].includes(o.status)) {
    run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', 'partial', now(), Number(id));
  }
  return ok({ id: Number(id), shipment_id: Number(info.lastInsertRowid), status: st, label: SHIP_LABEL[st] },
    `已登记物流：${carrier} ${tracking_no}（${SHIP_LABEL[st]}）`);
}

export function listOrders(setId, { status = '', customer = '', channel = '', from = '', to = '', q = '', limit = 50 } = {}) {
  const where = ['set_id = ?'];
  const params = [setId];
  const st = status ? normStatus(status) : '';
  if (st) { where.push('status = ?'); params.push(st); }
  if (customer) { where.push('customer LIKE ?'); params.push(`%${customer}%`); }
  if (channel) { where.push('channel = ?'); params.push(channel); }
  if (from) { where.push('order_date >= ?'); params.push(from); }
  if (to) { where.push('order_date <= ?'); params.push(to); }
  if (q) { where.push('(order_no LIKE ? OR customer LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const rows = all(`SELECT * FROM orders WHERE ${where.join(' AND ')}
    ORDER BY order_date DESC, id DESC LIMIT ?`, ...params, Math.min(500, Number(limit) || 50));
  return ok({
    count: rows.length,
    items: rows.map((o) => ({
      id: o.id, order_no: o.order_no, customer: o.customer, channel: o.channel,
      status: o.status, status_label: STATUS_LABEL[o.status] || o.status,
      amount: money(o.amount), discount: money(o.discount), net: money(Number(o.amount) - Number(o.discount)),
      cost: money(o.cost), order_date: o.order_date,
      shipment: get('SELECT carrier, tracking_no, status, last_event_at FROM order_shipments WHERE order_id = ? ORDER BY id DESC LIMIT 1', o.id) || null,
    })),
  });
}

export function orderDetail(setId, id) {
  const o = get('SELECT * FROM orders WHERE id = ? AND set_id = ?', Number(id), setId);
  if (!o) return fail('订单不存在');
  return ok({
    order: { ...o, status_label: STATUS_LABEL[o.status] || o.status },
    items: all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', Number(id)),
    events: all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', Number(id))
      .map((e) => ({ ...e, label: e.type === 'status' ? `${STATUS_LABEL[e.from_v] || e.from_v || '—'} → ${STATUS_LABEL[e.to_v] || e.to_v}` : e.note })),
    shipments: all('SELECT * FROM order_shipments WHERE order_id = ? ORDER BY id DESC', Number(id))
      .map((s) => ({ ...s, status_label: SHIP_LABEL[s.status] || s.status })),
    price_changes: all('SELECT * FROM order_price_changes WHERE order_id = ? ORDER BY id DESC', Number(id)),
  });
}

/* ---------------- 汇总 ---------------- */

function rangeWhere({ from = '', to = '' } = {}) {
  const w = [];
  const p = [];
  if (from) { w.push('order_date >= ?'); p.push(from); }
  if (to) { w.push('order_date <= ?'); p.push(to); }
  return { sql: w.length ? ` AND ${w.join(' AND ')}` : '', params: p };
}

export function orderSummary(setId, { from = '', to = '', period = '' } = {}) {
  let f = from;
  let t = to;
  if (period && PERIOD_RE.test(period)) {
    f = `${period}-01`;
    t = `${period}-31`;
  }
  const r = rangeWhere({ from: f, to: t });
  const rows = all(`SELECT * FROM orders WHERE set_id = ?${r.sql}`, setId, ...r.params);
  const byStatus = {};
  for (const k of STATUS) byStatus[k] = { count: 0, amount: 0, label: STATUS_LABEL[k] };
  let gross = 0;
  let net = 0;
  let discount = 0;
  let cost = 0;
  const byChannel = new Map();
  const byCustomer = new Map();
  for (const o of rows) {
    const amt = Number(o.amount) || 0;
    const netAmt = amt - (Number(o.discount) || 0);
    byStatus[o.status] = byStatus[o.status] || { count: 0, amount: 0, label: o.status };
    byStatus[o.status].count += 1;
    byStatus[o.status].amount = money(byStatus[o.status].amount + netAmt);
    gross += amt; net += netAmt; discount += Number(o.discount) || 0; cost += Number(o.cost) || 0;
    if (o.channel) {
      const c = byChannel.get(o.channel) || { count: 0, amount: 0 };
      c.count += 1; c.amount = money(c.amount + netAmt);
      byChannel.set(o.channel, c);
    }
    if (o.customer) {
      const c = byCustomer.get(o.customer) || { count: 0, amount: 0 };
      c.count += 1; c.amount = money(c.amount + netAmt);
      byCustomer.set(o.customer, c);
    }
  }
  const returned = rows.filter((o) => ['returned', 'returning'].includes(o.status)).length;
  const openCount = rows.filter((o) => ['open', 'partial'].includes(o.status)).length;
  return ok({
    from: f, to: t, total: rows.length,
    by_status: Object.values(byStatus).filter((x) => x.count > 0),
    open_count: openCount, returned_count: returned,
    return_rate: rows.length ? Number(((returned / rows.length) * 100).toFixed(1)) : 0,
    gross: money(gross), net: money(net), discount: money(discount), cost: money(cost),
    gross_profit: money(net - cost),
    gross_margin: net ? Number((((net - cost) / net) * 100).toFixed(1)) : 0,
    avg_discount: rows.length ? money(discount / rows.length) : 0,
    by_channel: [...byChannel.entries()].map(([k, v]) => ({ channel: k, ...v })).sort((a, b) => b.amount - a.amount),
    top_customers: [...byCustomer.entries()].map(([k, v]) => ({ customer: k, ...v })).sort((a, b) => b.amount - a.amount).slice(0, 10),
  });
}

export function logisticsSummary(setId, { from = '', to = '', period = '', stale_days = 3 } = {}) {
  let f = from;
  let t = to;
  if (period && PERIOD_RE.test(period)) { f = `${period}-01`; t = `${period}-31`; }
  const r = rangeWhere({ from: f, to: t });
  const rows = all(`SELECT o.id, o.order_no, o.customer, o.status AS order_status,
      (SELECT status FROM order_shipments s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1) AS ship_status,
      (SELECT last_event_at FROM order_shipments s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1) AS last_event_at,
      (SELECT carrier FROM order_shipments s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1) AS carrier,
      (SELECT tracking_no FROM order_shipments s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1) AS tracking_no
    FROM orders o WHERE o.set_id = ?${r.sql}`, setId, ...r.params);

  const byShip = {};
  for (const k of SHIP) byShip[k] = { count: 0, label: SHIP_LABEL[k] };
  byShip.none = { count: 0, label: '未登记物流' };
  const stale = [];
  const cutoff = Date.now() - Number(stale_days) * 86400000;
  for (const o of rows) {
    const k = o.ship_status || 'none';
    byShip[k] = byShip[k] || { count: 0, label: k };
    byShip[k].count += 1;
    if (o.ship_status && ['picked', 'transit', 'delivering'].includes(o.ship_status) && o.last_event_at) {
      const ts = new Date(String(o.last_event_at).replace(' ', 'T')).getTime();
      if (Number.isFinite(ts) && ts < cutoff) {
        stale.push({ order_no: o.order_no, customer: o.customer, carrier: o.carrier, tracking_no: o.tracking_no, status: SHIP_LABEL[o.ship_status], last_event_at: o.last_event_at });
      }
    }
  }
  return ok({ total: rows.length, by_status: Object.values(byShip).filter((x) => x.count > 0), stale });
}

/** 支出明细：按期间与科目前缀列出凭证明细，供前端抽屉与导出 */
export function expenseDetail(setId, { period = '', code = '', limit = 200 } = {}) {
  if (!PERIOD_RE.test(period)) return fail('期间格式应为 YYYY-MM');
  const rows = all(`SELECT v.id AS voucher_id, v.date, v.word, v.no, v.status,
      e.summary, e.subject_code, e.subject_name, e.debit, e.credit
    FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
    WHERE v.set_id = ? AND v.period = ? AND v.status != 'void' ${code ? 'AND e.subject_code LIKE ?' : ''}
    ORDER BY v.date, v.id, e.line LIMIT ?`, setId, period, ...(code ? [`${code}%`] : []), Math.min(1000, Number(limit) || 200));
  const total = money(rows.reduce((s, r) => s + Number(r.debit || 0) - Number(r.credit || 0), 0));
  return ok({
    period, code, count: rows.length, total,
    items: rows.map((r) => ({
      date: r.date, voucher: `${r.word}-${r.no}`, summary: r.summary,
      subject: `${r.subject_code} ${r.subject_name}`, debit: money(r.debit), credit: money(r.credit),
      amount: money(Number(r.debit || 0) - Number(r.credit || 0)), status: r.status,
    })),
  });
}
