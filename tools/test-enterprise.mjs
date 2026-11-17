#!/usr/bin/env node
/**
 * test-enterprise —— 企业助手扩展骨架测试（临时库）
 *
 *   node tools/test-enterprise.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-ent-'));
process.env.ZD_DB_PATH = path.join(tmp, 'test.db');

const ent = await import('../backend/enterprise.mjs');
const { pickToolNames } = await import('../backend/toolrouter.mjs');

const SET = 85;
let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name} — ${e.message}`); process.exitCode = 1; }
};

check('渠道：新增与列表（区分两种口径）', () => {
  assert.equal(ent.saveChannel(SET, { name: '天猫旗舰店', platform: '天猫', source: 'wdt' }).code, 0);
  assert.equal(ent.saveChannel(SET, { name: '抖音小店', platform: '抖音' }).code, 0);
  assert.equal(ent.saveChannel(SET, { name: '' }).code, 1);
  const r = ent.listChannels(SET);
  assert.equal(r.data.count, 2);
  assert.ok(r.data.items.some((x) => x.source === 'wdt'));
});

check('销售导入：合法行入库、非法行报错但不中断', () => {
  const r = ent.importSales(SET, {
    source: 'sales_dept',
    rows: [
      { date: '2026-11-15', product: '歌剧', qty: 12, amount: 3600, return_qty: 1, return_amount: 300 },
      { date: 'bad-date', product: '三色', qty: 1, amount: 100 },
      { product: '缺日期', qty: 1, amount: 100 },
    ],
  });
  assert.equal(r.code, 0);
  assert.equal(r.data.inserted, 1);
  assert.equal(r.data.errors.length, 2);
  const list = ent.listSales(SET, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(list.data.count, 1);
  assert.equal(list.data.total.amount, 3600);
});

check('销售导入：空行被拒', () => {
  assert.equal(ent.importSales(SET, { rows: [] }).code, 1);
});

check('运营与分销：空数据返回 0 而不是报错', () => {
  assert.equal(ent.listOpsSpend(SET).data.count, 0);
  assert.equal(ent.listDistribution(SET).data.count, 0);
});

check('工作汇报：写入与按人按日查询', () => {
  assert.equal(ent.addWorkReport(SET, { author: '小周', dept: '运营', period: '2026-11-16', content: '完成双十一复盘' }).code, 0);
  assert.equal(ent.addWorkReport(SET, { author: '', content: 'x' }).code, 1);
  const list = ent.listWorkReports(SET, { period: '2026-11-16' });
  assert.equal(list.data.count, 1);
  assert.equal(list.data.items[0].author, '小周');
});

check('文档：入库分块并按关键词检索，带出处', () => {
  assert.equal(ent.addDoc(SET, {
    title: '差旅报销制度',
    category: '财务制度',
    effective_from: '2026-01-01',
    content: '第一条 出差需提前申请。\n\n第二条 住宿标准：一线城市每晚不超过 600 元。\n\n第三条 交通费凭票报销。',
  }).code, 0);
  const r = ent.searchDocs(SET, { q: '住宿标准' });
  assert.equal(r.code, 0);
  assert.equal(r.data.count, 1);
  assert.match(r.data.items[0].snippet, /600/);
  assert.match(r.data.items[0].ref, /差旅报销制度/);
  assert.equal(ent.searchDocs(SET, { q: '不存在的词' }).data.count, 0);
});

check('文档重复入库会更新并重建分块', () => {
  ent.addDoc(SET, { title: '差旅报销制度', content: '更新后的内容：住宿 800 元。' });
  const r = ent.searchDocs(SET, { q: '800' });
  assert.equal(r.data.count, 1);
  const docs = ent.listDocs(SET);
  assert.equal(docs.data.count, 1);
});

check('意图路由：销售与知识库类提问命中对应组', () => {
  const all = ['list_sales', 'import_sales', 'search_docs', 'add_work_report', 'get_report', 'list_orders'];
  const s = pickToolNames('把昨天的销售数据导进来', { allTools: all });
  assert.ok(s.groups.includes('sales'));
  assert.ok(s.names.has('import_sales'));
  const k = pickToolNames('查一下差旅报销制度怎么规定的', { allTools: all });
  assert.ok(k.groups.includes('kb'));
  assert.ok(k.names.has('search_docs'));
});

console.log(`\n企业助手骨架测试：${pass} PASS`);
