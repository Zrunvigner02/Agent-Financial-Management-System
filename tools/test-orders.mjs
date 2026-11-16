#!/usr/bin/env node
/**
 * test-orders —— 订单状态流转、退货、改价、物流与汇总（临时库）
 *
 *   node tools/test-orders.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-orders-'));
process.env.ZD_DB_PATH = path.join(tmp, 'test.db');

const ord = await import('../backend/orders.mjs');
const store = await import('../backend/store.mjs');

const SET = 85;
let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name} — ${e.message}`); process.exitCode = 1; }
};

let orderId = 0;
let itemId = 0;

check('建单：金额、应收、明细正确', () => {
  const r = ord.createOrder(SET, {
    customer: '张三', channel: '抖音', order_date: '2026-11-05', discount: 10,
    items: [
      { sku: 'M001', name: '面膜', qty: 2, unit_price: 129, cost: 60 },
      { sku: 'S002', name: '精华', qty: 1, unit_price: 259, cost: 120 },
    ],
  }, 'tester');
  assert.equal(r.code, 0, r.message);
  orderId = r.data.id;
  assert.equal(r.data.amount, 517 - 10);
  const d = ord.orderDetail(SET, orderId).data;
  assert.equal(d.items.length, 2);
  itemId = d.items[0].id;
  assert.equal(d.order.status, 'open');
});

check('状态流转：进行中 → 部分发货 → 已结清，且留时间线', () => {
  assert.equal(ord.updateStatus(SET, orderId, 'partial', '发了面膜', 'tester').code, 0);
  assert.equal(ord.updateStatus(SET, orderId, '已结清', '全款到账', 'tester').code, 0);
  const d = ord.orderDetail(SET, orderId).data;
  assert.equal(d.order.status, 'settled');
  assert.ok(d.events.filter((e) => e.type === 'status').length >= 3);
});

check('改价（低价销售）：记录原价、重算金额', () => {
  const before = ord.orderDetail(SET, orderId).data.order.amount;
  const r = ord.changePrice(SET, orderId, { item_id: itemId, new_price: 99, reason: '清仓' }, 'tester');
  assert.equal(r.code, 0, r.message);
  const after = ord.orderDetail(SET, orderId).data;
  assert.equal(after.order.amount, before - 60);
  assert.equal(after.price_changes[0].old_price, 129);
  assert.equal(after.price_changes[0].new_price, 99);
});

check('退货：部分退 → 退货中；全退 → 已退货', () => {
  assert.equal(ord.returnItems(SET, orderId, { item_id: itemId, qty: 1, reason: '色差' }, 'tester').code, 0);
  assert.equal(ord.orderDetail(SET, orderId).data.order.status, 'returning');
  assert.equal(ord.returnItems(SET, orderId, { reason: '全部退回' }, 'tester').code, 0);
  assert.equal(ord.orderDetail(SET, orderId).data.order.status, 'returned');
});

check('超量退货被拒', () => {
  const r = ord.returnItems(SET, orderId, { item_id: itemId, qty: 5 }, 'tester');
  assert.equal(r.code, 1);
});

check('物流：登记与状态更新', () => {
  const a = ord.addShipment(SET, orderId, { carrier: '顺丰', tracking_no: 'SF123', status: 'picked' }, 'tester');
  assert.equal(a.code, 0, a.message);
  const b = ord.addShipment(SET, orderId, { carrier: '顺丰', tracking_no: 'SF123', status: 'signed' }, 'tester');
  assert.equal(b.code, 0);
  const d = ord.orderDetail(SET, orderId).data;
  assert.equal(d.shipments.length, 1, '同运单号应更新而不是新增');
  assert.equal(d.shipments[0].status, 'signed');
});

check('汇总：状态、退货率、折扣、毛利', () => {
  ord.createOrder(SET, { customer: '李四', channel: '天猫', order_date: '2026-11-08', items: [{ sku: 'M001', name: '面膜', qty: 5, unit_price: 129, cost: 60 }] }, 'tester');
  const s = ord.orderSummary(SET, { period: '2026-11' }).data;
  assert.equal(s.total, 2);
  assert.ok(s.by_status.length >= 2);
  assert.equal(s.returned_count, 1);
  assert.ok(s.return_rate > 0);
  assert.ok(s.gross_margin <= 100);
  assert.ok(s.by_channel.some((c) => c.channel === '抖音'));
});

check('物流汇总：按状态计数', () => {
  const s = ord.logisticsSummary(SET, { period: '2026-11' }).data;
  assert.equal(s.total, 2);
  assert.ok(s.by_status.some((x) => x.label === '已签收'));
  assert.ok(Array.isArray(s.stale));
});

check('支出明细：无凭证时返回空而不报错', () => {
  const r = ord.expenseDetail(SET, { period: '2026-11' });
  assert.equal(r.code, 0);
  assert.equal(r.data.count, 0);
  assert.equal(ord.expenseDetail(SET, { period: '2026-13' }).code, 1);
});

check('明细账时间线：订单与凭证合并、可按关键词过滤', () => {
  const t = ord.ledgerTimeline(SET, { period: '2026-11' });
  assert.equal(t.code, 0);
  assert.ok(t.data.orders >= 2);
  assert.ok(t.data.items.some((x) => x.kind === 'order' && x.ref));
  const f = ord.ledgerTimeline(SET, { period: '2026-11', q: 'SO' });
  assert.ok(f.data.items.every((x) => x.kind === 'order'));
  assert.equal(ord.ledgerTimeline(SET, { period: '2026-13' }).code, 1);
});

console.log(`\n订单测试：${pass} PASS`);
