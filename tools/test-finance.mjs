#!/usr/bin/env node
/**
 * test-finance —— 财务端销售损益表核算测试（临时库）
 *
 *   node tools/test-finance.mjs
 *
 * 覆盖：损益链条、比率分母、期间聚合、导入幂等、实际/估算择优、缺口判断、与销售端隔离。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-fin-'));
process.env.ZD_DB_PATH = path.join(tmp, 'test.db');

const fin = await import('../backend/finance.mjs');
const { all } = await import('../backend/store.mjs');

const SET = 85;
let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name} — ${e.message}`); process.exitCode = 1; }
};

const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps;

/* ---------- 1. 损益链条 ---------- */
check('链条：收入−成本=毛利，毛利−变动=边界利润，边界−人力=净利润', () => {
  const d = fin.derive({
    revenue: 1000, cost: 400, ad_spend: 200, platform_fee: 50, logistics: 30, other_direct: 20,
    labor_direct: 100, labor_shared: 50,
  });
  assert.equal(d.gross_profit, 600);
  assert.equal(d.variable_total, 300);
  assert.equal(d.boundary_profit, 300);
  assert.equal(d.labor_cost, 150);
  assert.equal(d.net_profit, 150);
});

check('比率：分母一律是收入，不是 GMV', () => {
  const d = fin.derive({ revenue: 800, cost: 480, ad_spend: 80, labor: 120 });
  assert.ok(near(d.gross_margin, 0.4), `毛利率 ${d.gross_margin}`);
  assert.ok(near(d.cost_ratio, 0.6));
  assert.ok(near(d.ad_ratio, 0.1));
  assert.ok(near(d.net_margin, (800 - 480 - 80 - 120) / 800));
});

check('人力成本：直接+公摊可拆分，仅有总额时标记未拆分', () => {
  assert.equal(fin.derive({ revenue: 100, labor_direct: 10, labor_shared: 5 }).labor_split, '已拆分');
  const lump = fin.derive({ revenue: 100, labor: 30 });
  assert.equal(lump.labor_cost, 30);
  assert.equal(lump.labor_split, '未拆分');
});

check('亏损：比率照实为负，不取绝对值', () => {
  const d = fin.derive({ revenue: 1000, cost: 600, ad_spend: 500, labor: 100 });
  assert.equal(d.boundary_profit, -100);
  assert.equal(d.net_profit, -200);
  assert.ok(d.net_margin < 0);
});

/* ---------- 2. 期间聚合 ---------- */
check('期间：季度展开为三个月，日粒度归到月', () => {
  assert.deepEqual(fin.periodsOf('2026-Q4'), ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(fin.periodsOf('2026-Q1'), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(fin.periodsOf('2026-10'), ['2026-10']);
  assert.deepEqual(fin.periodsOf('2026-10-15'), ['2026-10']);
  assert.deepEqual(fin.periodsOf('乱写'), []);
});

/* ---------- 3. 写入与幂等 ---------- */
check('写入：非法期间/未知科目被拒绝', () => {
  assert.equal(fin.upsertLines(SET, [{ period: '2026/10', brand: '歌剧', channel: '天猫', item: 'revenue', amount: 1 }]).code, 1);
  assert.equal(fin.upsertLines(SET, [{ period: '2026-10', brand: '歌剧', channel: '天猫', item: '不存在的科目', amount: 1 }]).code, 1);
});

check('写入：同键重复导入只更新不新增（幂等）', () => {
  const lines = [
    { period: '2026-09', brand: '歌剧', channel: '天猫', item: 'revenue', amount: 1000 },
    { period: '2026-09', brand: '歌剧', channel: '天猫', item: 'cost', amount: 400 },
  ];
  fin.upsertLines(SET, lines, { basis: '旺店通' });
  const first = fin.computePnl(SET, { period: '2026-09' }).data.all.total.revenue;
  fin.upsertLines(SET, lines, { basis: '旺店通' });
  const second = fin.computePnl(SET, { period: '2026-09' }).data.all.total.revenue;
  assert.equal(first, 1000);
  assert.equal(second, 1000, '重复写入不应翻倍');
});

check('实际值优先于估算值（不做加权平均）', () => {
  fin.upsertLines(SET, [{ period: '2026-09', brand: '歌剧', channel: '天猫', item: 'ad_spend', amount: 999 }], { basis: '估算' });
  fin.upsertLines(SET, [{ period: '2026-09', brand: '歌剧', channel: '天猫', item: 'ad_spend', amount: 200 }], { basis: '万相台' });
  const cell = fin.computePnl(SET, { period: '2026-09' }).data.brands[0].channels['天猫'];
  assert.equal(cell.ad_spend, 200, `应取实际值，实际 ${cell.ad_spend}`);
});

/* ---------- 4. 汇总口径 ---------- */
check('汇总：全品牌合计等于各品牌之和，比率由合计金额重算', () => {
  fin.upsertLines(SET, [
    { period: '2026-09', brand: '世家', channel: '天猫', item: 'revenue', amount: 500 },
    { period: '2026-09', brand: '世家', channel: '天猫', item: 'cost', amount: 300 },
  ], { basis: '旺店通' });
  const d = fin.computePnl(SET, { period: '2026-09' }).data;
  const sumRev = d.brands.reduce((s, b) => s + b.total.revenue, 0);
  assert.equal(d.all.total.revenue, 1500);
  assert.equal(sumRev, 1500);
  assert.ok(near(d.all.total.gross_margin, d.all.total.gross_profit / d.all.total.revenue, 1e-6));
});

check('季度：只聚合有数据的月份，不补零', () => {
  const d = fin.computePnl(SET, { period: '2026-Q3' }).data;
  assert.equal(d.all.total.revenue, 1500, 'Q3 只有 9 月有数');
});

/* ---------- 5. 缺口与隔离 ---------- */
check('缺口：未取到的科目被列出，为 0 的不算缺失', () => {
  fin.upsertLines(SET, [{ period: '2026-09', brand: '歌剧', channel: '天猫', item: 'platform_fee', amount: 0 }], { basis: '账单' });
  const r = fin.coverage(SET, { period: '2026-09' }).data;
  const cellKey = (x) => `${x.brand}/${x.channel}`;
  assert.ok(r.gaps.some((g) => cellKey(g) === '歌剧/天猫' && g.item === 'logistics'), '应报物流费未取到');
  assert.ok(!r.gaps.some((g) => cellKey(g) === '歌剧/天猫' && g.item === 'platform_fee'), '平台扣点已取到（值为 0）');
  assert.ok(r.zeros.some((z) => cellKey(z) === '歌剧/天猫' && z.item === 'platform_fee'), '值为 0 应单独列出');
  assert.ok(r.gaps.some((g) => cellKey(g) === '世家/天猫' && g.item === 'platform_fee'), '世家未取到平台扣点应报缺');
});

check('隔离：财务模块不写销售端 sales_daily', () => {
  const n = all('SELECT COUNT(*) n FROM sales_daily')[0].n;
  assert.equal(n, 0, `sales_daily 应为空，实际 ${n}`);
});

console.log(`\n===== 财务端测试：${pass} PASS =====`);
