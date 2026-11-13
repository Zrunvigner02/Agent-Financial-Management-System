#!/usr/bin/env node
/**
 * test-recurring —— 固定支出（周期性凭证）单元测试（临时数据库，不碰真实账套）
 *
 *   node tools/test-recurring.mjs
 *
 * 覆盖：模板创建与校验、按月幂等生成、月初提醒只提醒一次、
 *       本月直接调整（含已审核拒绝）、下月提前调整、长期改模板、停用与删除策略。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-recurring-'));
process.env.ZD_DB_PATH = path.join(tmp, 'test.db');

const rec = await import('../backend/recurring.mjs');
const store = await import('../backend/store.mjs');

const SET = 85;
let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name} — ${e.message}`); process.exitCode = 1; }
};

const amountOf = (voucherId) => store.get(
  'SELECT ROUND(SUM(debit), 2) AS a FROM voucher_entries WHERE voucher_id = ?', voucherId).a;

check('按类别+金额建固定支出，自动生成平衡分录', () => {
  const r = rec.saveTemplate(SET, { name: '工资', category: '工资', amount: 20000, day: 5 }, 'tester');
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.amount, 20000);
  const [tpl] = rec.listTemplates(SET);
  assert.equal(tpl.entries.length, 2);
  assert.equal(tpl.day, 5);
  assert.equal(tpl.active, true);
});

check('非法输入被拒：金额为 0、科目不存在、借贷不平衡', () => {
  assert.equal(rec.saveTemplate(SET, { name: '房租', category: '房租', amount: 0 }).code, 1);
  assert.equal(rec.saveTemplate(SET, {
    name: '坏科目',
    entries: [{ subject_code: '9999', debit: 100, credit: 0 }, { subject_code: '1002', debit: 0, credit: 100 }],
  }).code, 1);
  assert.equal(rec.saveTemplate(SET, {
    name: '不平衡',
    entries: [{ subject_code: '6602', debit: 100, credit: 0 }, { subject_code: '1002', debit: 0, credit: 90 }],
  }).code, 1);
});

check('生成当月凭证：草稿、金额正确、只生成一次', () => {
  const first = rec.generateForPeriod(SET, '2026-11', 'tester');
  assert.equal(first.code, 0, first.message);
  assert.equal(first.data.created.length, 1);
  const vid = first.data.created[0].voucher_id;
  const v = store.get('SELECT * FROM vouchers WHERE id = ?', vid);
  assert.equal(v.status, 'draft');
  assert.equal(v.period, '2026-11');
  assert.equal(v.date, '2026-11-05');
  assert.equal(amountOf(vid), 20000);

  const again = rec.generateForPeriod(SET, '2026-11', 'tester');
  assert.equal(again.data.created.length, 0);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM vouchers WHERE period = '2026-11'").n, 1);
});

check('月初提醒：首次提醒、按 mark 置位后不再提醒、文案含金额与选项', () => {
  const r = rec.reminder(SET, '2026-11', { auto: false });
  assert.equal(r.code, 0);
  assert.equal(r.data.shouldNotify, true);
  assert.match(r.data.text, /20,?000\.00/);
  assert.match(r.data.text, /1 不变/);
  assert.equal(r.data.summary.count, 1);
  assert.equal(r.data.summary.generated, 1);

  rec.markNotified(SET, '2026-11');
  assert.equal(rec.reminder(SET, '2026-11', { auto: false }).data.shouldNotify, false);
});

check('本月调整：凭证金额随之变化，仍是草稿，且不会被再次生成覆盖', () => {
  const [tpl] = rec.listTemplates(SET);
  const r = rec.adjustThisMonth(SET, '2026-11', tpl.id, [
    { summary: '计提/发放工资', subject_code: '6602', debit: 21500, credit: 0 },
    { summary: '计提/发放工资', subject_code: '2211', debit: 0, credit: 21500 },
  ], 'tester');
  assert.equal(r.code, 0, r.message);
  assert.equal(amountOf(r.data.voucher_id), 21500);
  assert.equal(store.get('SELECT status FROM vouchers WHERE id = ?', r.data.voucher_id).status, 'draft');

  const gen = rec.generateForPeriod(SET, '2026-11', 'tester');
  assert.equal(gen.data.created.length, 0, '本月已有记录，不应重复生成');
  assert.equal(rec.plan(SET, '2026-11').data.templates[0].amount, 21500);
});

check('已审核凭证不允许直接改本月', () => {
  const tpl = rec.listTemplates(SET)[0];
  const before = rec.plan(SET, '2026-11').data.templates[0].voucher_id;
  store.run("UPDATE vouchers SET status = 'reviewed' WHERE id = ?", before);
  const r = rec.adjustThisMonth(SET, '2026-11', tpl.id, [
    { summary: 'x', subject_code: '6602', debit: 1, credit: 0 },
    { summary: 'x', subject_code: '2211', debit: 0, credit: 1 },
  ], 'tester');
  assert.equal(r.code, 1);
  assert.match(r.message, /已审核/);
  store.run("UPDATE vouchers SET status = 'draft' WHERE id = ?", before);
});

check('下月提前调整：12 月按新金额生成，11 月与模板不受影响', () => {
  const tpl = rec.listTemplates(SET)[0];
  const ov = rec.setOverride(SET, tpl.id, '2026-12', [
    { summary: '计提/发放工资', subject_code: '6602', debit: 23000, credit: 0 },
    { summary: '计提/发放工资', subject_code: '2211', debit: 0, credit: 23000 },
  ], '下月调薪');
  assert.equal(ov.code, 0, ov.message);

  const dec = rec.generateForPeriod(SET, '2026-12', 'tester');
  assert.equal(dec.data.created.length, 1);
  assert.equal(dec.data.created[0].amount, 23000);
  assert.equal(rec.listTemplates(SET)[0].amount, 20000, '模板本身不应被改');
  assert.equal(rec.plan(SET, '2026-12').data.templates[0].overridden, true);
});

check('长期改模板：后续月份用新金额', () => {
  const tpl = rec.listTemplates(SET)[0];
  const r = rec.saveTemplate(SET, {
    id: tpl.id, name: tpl.name, category: tpl.category, day: tpl.day,
    entries: [
      { summary: '计提/发放工资', subject_code: '6602', debit: 25000, credit: 0 },
      { summary: '计提/发放工资', subject_code: '2211', debit: 0, credit: 25000 },
    ],
  }, 'tester');
  assert.equal(r.code, 0, r.message);
  assert.equal(rec.listTemplates(SET)[0].amount, 25000);
  const jan = rec.generateForPeriod(SET, '2027-01', 'tester');
  assert.equal(jan.data.created[0].amount, 25000);
});

check('停用后不再生成，历史凭证保留', () => {
  const tpl = rec.listTemplates(SET)[0];
  assert.equal(rec.setTemplateActive(SET, tpl.id, false).code, 0);
  const feb = rec.generateForPeriod(SET, '2027-02', 'tester');
  assert.equal(feb.data.created.length, 0);
  assert.ok(store.get("SELECT COUNT(*) AS n FROM vouchers WHERE period = '2026-11'").n >= 1);
});

check('删除有生成记录的固定支出 → 转停用而非硬删', () => {
  const tpl = rec.listTemplates(SET)[0];
  const r = rec.removeTemplate(SET, tpl.id);
  assert.equal(r.code, 0);
  assert.equal(r.data.active, false);
  assert.ok(rec.listTemplates(SET).length >= 1);
});

check('账套隔离：其他账套看不到本账套模板', () => {
  assert.equal(rec.listTemplates(86).length, 0);
  const r = rec.generateForPeriod(86, '2026-11', 'tester');
  assert.equal(r.data.created.length, 0);
});

check('提醒在无模板时也给出引导话术', () => {
  const r = rec.reminder(86, '2026-11', { auto: false });
  assert.equal(r.code, 0);
  assert.match(r.data.text, /还没有设置固定支出/);
});

console.log(`\n固定支出测试：${pass} PASS`);
