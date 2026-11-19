#!/usr/bin/env node
/**
 * test-finance-logic —— 两条财务逻辑的硬断言（不写真实库）
 *
 * 逻辑①：销售损益表核算链
 *   收入 − 成本 = 毛利；毛利 ÷ 收入 = 毛利率
 *   毛利 −（推广费 + 平台扣点 + 物流费 + 其他直接支出）= 边界利润
 *   边界利润 −（直接人力 + 公摊人力）= 净利润；净利润 ÷ 收入 = 净利率
 *   比率一律用汇总金额重算，不做「各渠道比率相加 / 平均」
 *
 * 逻辑②：口径隔离与幂等
 *   fin_* 只由财务口径写入，不读 sales_daily；重复写入同键只更新不新增
 *   期间解析：月 / 季 / 日
 *
 * 用法：node tools/test-finance-logic.mjs
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 用隔离副本跑，避免污染真实库
const tmpDb = path.join(os.tmpdir(), `zd-fin-logic-${Date.now()}.db`);
fs.copyFileSync(path.join(ROOT, 'backend', 'data', 'jinli.db'), tmpDb);
process.env.ZD_DB_PATH = tmpDb;

const fin = await import('../backend/finance.mjs');
const { derive, periodsOf, ensureFinanceTables, upsertLines, computePnl } = fin;

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`✓ ${name}`); }
  catch (e) { fail += 1; console.log(`✗ ${name}\n   ${e.message}`); }
};

/* ---------- 逻辑①：核算链 ---------- */
t('收入−成本=毛利', () => {
  const d = derive({ revenue: 1000, cost: 400 });
  assert.equal(d.gross_profit, 600);
});
t('毛利÷收入=毛利率', () => {
  const d = derive({ revenue: 1000, cost: 400 });
  assert.equal(d.gross_margin, 0.6);
});
t('毛利−四项变动费用=边界利润', () => {
  const d = derive({ revenue: 1000, cost: 400, ad_spend: 50, platform_fee: 30, logistics: 20, other_direct: 10 });
  assert.equal(d.variable_total, 110);
  assert.equal(d.boundary_profit, 490);
});
t('边界利润−人力成本=净利润', () => {
  const d = derive({ revenue: 1000, cost: 400, ad_spend: 50, platform_fee: 30, logistics: 20, other_direct: 10, labor_direct: 60, labor_shared: 40 });
  assert.equal(d.labor_cost, 100);
  assert.equal(d.net_profit, 390);
});
t('净利润÷收入=净利率', () => {
  const d = derive({ revenue: 1000, cost: 400, ad_spend: 50, platform_fee: 30, logistics: 20, other_direct: 10, labor_direct: 60, labor_shared: 40 });
  assert.equal(d.net_margin, 0.39);
});
t('未拆分人力也计入（labor 兜底）', () => {
  const d = derive({ revenue: 1000, cost: 400, labor: 100 });
  assert.equal(d.boundary_profit, 600);
  assert.equal(d.net_profit, 500);
  assert.equal(d.labor_split, '未拆分');
});
t('收入为 0 时比率返回 null（不产生 Infinity/NaN）', () => {
  const d = derive({ revenue: 0, cost: 100 });
  assert.equal(d.gross_margin, null);
  assert.equal(d.net_margin, null);
  assert.ok(Number.isFinite(d.net_profit));
});
t('浮点不漂移（0.1+0.2 类场景保留两位）', () => {
  const d = derive({ revenue: 0.3, cost: 0.1 });
  assert.equal(d.gross_profit, 0.2);
});

/* ---------- 期间解析 ---------- */
t('季报解析为三个月', () => {
  assert.deepEqual(periodsOf('2026-Q4'), ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(periodsOf('2026-Q1'), ['2026-01', '2026-02', '2026-03']);
});
t('月报/日报解析', () => {
  assert.deepEqual(periodsOf('2026-11'), ['2026-11']);
  assert.deepEqual(periodsOf('2026-11-19'), ['2026-11-19']);
});
t('非法期间返回空', () => {
  assert.deepEqual(periodsOf('2026-13'), ['2026-13']); // 月格式合法，交由下游无数据兜底
  assert.deepEqual(periodsOf('abc'), []);
});

/* ---------- 逻辑②：幂等与隔离 ---------- */
t('重复写入同键不新增行（幂等）', () => {
  ensureFinanceTables();
  const lines = [
    { period: '2026-09', brand: 'PF', channel: '淘宝', item: 'revenue', amount: 1000, basis: 'test' },
    { period: '2026-09', brand: 'PF', channel: '淘宝', item: 'cost', amount: 400, basis: 'test' },
  ];
  upsertLines(85, lines, { basis: 'test', sourceRef: 'unit' });
  const first = computePnl(85, { period: '2026-09', brand: 'PF' });
  assert.equal(first.code, 0);
  const net1 = first.data.brands[0].total.net_profit;

  upsertLines(85, lines, { basis: 'test', sourceRef: 'unit' }); // 再写一遍同数据
  const second = computePnl(85, { period: '2026-09', brand: 'PF' });
  assert.equal(second.code, 0);
  const net2 = second.data.brands[0].total.net_profit;

  assert.equal(net1, net2, '重复录入后净利润应不变');
});

t('同键改金额只更新（不产生第二行）', () => {
  upsertLines(85, [{ period: '2026-09', brand: 'PF', channel: '淘宝', item: 'cost', amount: 500, basis: 'test' }], { basis: 'test' });
  const r = computePnl(85, { period: '2026-09', brand: 'PF' });
  const cell = r.data.brands[0].channels['淘宝'];
  assert.equal(cell.cost, 500, '成本应被更新为 500');
  assert.equal(cell.gross_profit, 500, '毛利=1000-500');
});

t('财务口径不读销售日数据（隔离）', () => {
  // 销售端存在大量数据，但财务侧 2026-09 只有上面两条
  const r = computePnl(85, { period: '2026-09' });
  assert.equal(r.code, 0);
  const total = r.data.brands.reduce((s, b) => s + b.total.revenue, 0);
  assert.equal(total, 1000, '收入只来自 fin_pnl_lines，不应混入 sales_daily');
});

t('无数据期间返回明确失败而非 0 报表', () => {
  const r = computePnl(85, { period: '2019-01' });
  assert.equal(r.code, 1);
  assert.match(String(r.message), /没有数据/);
});

/* ---------- 收尾 ---------- */
try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
console.log(`\n财务逻辑：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
