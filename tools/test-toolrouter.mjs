#!/usr/bin/env node
/**
 * test-toolrouter —— 意图路由测试：真实说法必须命中正确工具组。
 *
 *   node tools/test-toolrouter.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pickToolNames, matchGroups, needsFullRetry, TOOL_GROUPS } from '../backend/toolrouter.mjs';

const src = fs.readFileSync(new URL('../backend/index.mjs', import.meta.url), 'utf8');
const ALL = [...src.match(/const TOOL_NAMES = \[([\s\S]*?)\];/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name} — ${e.message}`); process.exitCode = 1; }
};

const cases = [
  ['这单退一盒', 'order', 'return_order_items'],
  ['本月赚了多少', 'report', 'get_report'],
  ['应收账款多少', 'report', 'get_report'],
  ['这个月还剩几单没发', 'order', 'list_orders'],
  ['顺丰签收了吗', 'order', 'add_shipment'],
  ['订单号 SO2600001 现在什么状态', 'order', 'list_orders'],
  ['客户王五的欠款', 'order', 'list_orders'],
  ['把张三工资改成 9000', 'recurring', 'adjust_recurring'],
  ['房租这月涨到 6500', 'recurring', 'adjust_recurring'],
  ['帮我记一笔房租', 'voucher', 'create_voucher'],
  ['这张发票识别一下', 'file', 'ocr_file'],
  ['把对账单转成 Excel', 'file', 'convert_file'],
  ['上个月的报表', 'report', 'get_report'],
  ['给这单标钱货两讫', 'tag', 'save_tag'],
  ['把李四设成管理员', 'account', 'list_sets'],
];

for (const [text, group, tool] of cases) {
  check(`「${text}」→ ${group} / ${tool}`, () => {
    const r = pickToolNames(text, { allTools: ALL });
    assert.equal(r.matched, true, '应命中业务组');
    assert.ok(r.groups.includes(group), `命中组应含 ${group}，实际 ${r.groups.join(',') || '无'}`);
    assert.ok(r.names.has(tool), `工具集应含 ${tool}`);
  });
}

check('无业务关键词时给中等集合（订单 + 报表），不漏核心工具', () => {
  const r = pickToolNames('你好', { allTools: ALL });
  assert.equal(r.level, 'medium');
  assert.equal(r.matched, false);
  for (const t of ['list_orders', 'get_report', 'list_sets']) assert.ok(r.names.has(t), `应含 ${t}`);
  assert.ok(r.names.size < ALL.length, '不应等于全量');
});

check('full=true 返回全量工具', () => {
  const r = pickToolNames('随便', { full: true, allTools: ALL });
  assert.equal(r.names.size, ALL.length);
});

check('命中多组时取并集（订单 + 文件）', () => {
  const r = pickToolNames('把这单发票转成 PDF', { allTools: ALL });
  assert.ok(r.groups.includes('order'));
  assert.ok(r.groups.includes('file'));
  assert.ok(r.names.has('convert_file'));
});

check('能力边界提示：明确说做不到且没调工具时才重试', () => {
  assert.equal(needsFullRetry('抱歉，我无法查询该数据', false), true);
  assert.equal(needsFullRetry('抱歉，我无法查询该数据', true), false);
  assert.equal(needsFullRetry('本月利润为 0 元', false), false);
});

check('分组工具名全部存在（防止拼写漂移）', () => {
  for (const [g, list] of Object.entries(TOOL_GROUPS)) {
    for (const n of list) assert.ok(ALL.includes(n), `${g} 组的 ${n} 不在 TOOL_NAMES 中`);
  }
});

console.log(`\n意图路由测试：${pass} PASS`);
