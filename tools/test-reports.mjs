#!/usr/bin/env node
/**
 * test-reports —— 三大报表引擎的单元测试（内存库，不碰真实账套）
 *
 *   node tools/test-reports.mjs
 *
 * 覆盖：取数口径、行间引用、借贷方向、公式安全校验、重分类、模板读写与重置、导出表结构。
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as rpt from '../backend/reports.mjs';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE subjects (code TEXT PRIMARY KEY, direction TEXT, set_id INTEGER);
  CREATE TABLE vouchers (id INTEGER PRIMARY KEY, set_id INTEGER, period TEXT, status TEXT);
  CREATE TABLE voucher_entries (id INTEGER PRIMARY KEY, voucher_id INTEGER, subject_code TEXT, debit REAL, credit REAL);
  CREATE TABLE report_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, set_id INTEGER, type TEXT, side TEXT, code TEXT,
    name TEXT, kind TEXT, level INTEGER, formula TEXT, formula2 TEXT, sort INTEGER, updated_at TEXT);
  CREATE TABLE report_settings (set_id INTEGER, key TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (set_id, key));
`);

const subjects = [
  ['1001', '借'], ['1002', '借'], ['1122', '借'], ['1123', '借'], ['1231', '贷'],
  ['2202', '贷'], ['2203', '贷'], ['4001', '贷'], ['4103', '贷'],
  ['6001', '贷'], ['6401', '借'], ['6602', '借'],
];
for (const [code, dir] of subjects) {
  db.prepare('INSERT INTO subjects (code, direction, set_id) VALUES (?, ?, 85)').run(code, dir);
}

// 2025-12：年初前，实收资本 1000
db.prepare('INSERT INTO vouchers (id, set_id, period, status) VALUES (1, 85, ?, ?)').run('2025-12', 'posted');
db.prepare('INSERT INTO voucher_entries (voucher_id, subject_code, debit, credit) VALUES (?, ?, ?, ?)').run(1, '1002', 1000, 0);
db.prepare('INSERT INTO voucher_entries (voucher_id, subject_code, debit, credit) VALUES (?, ?, ?, ?)').run(1, '4001', 0, 1000);

// 2026-11：收款 300、确认收入 300；成本 100
db.prepare('INSERT INTO vouchers (id, set_id, period, status) VALUES (2, 85, ?, ?)').run('2026-11', 'posted');
db.prepare('INSERT INTO voucher_entries (voucher_id, subject_code, debit, credit) VALUES (?, ?, ?, ?)').run(2, '1002', 300, 0);
db.prepare('INSERT INTO voucher_entries (voucher_id, subject_code, debit, credit) VALUES (?, ?, ?, ?)').run(2, '6001', 0, 300);
db.prepare('INSERT INTO voucher_entries (voucher_id, subject_code, debit, credit) VALUES (?, ?, ?, ?)').run(2, '6401', 100, 0);
db.prepare('INSERT INTO voucher_entries (voucher_id, subject_code, debit, credit) VALUES (?, ?, ?, ?)').run(2, '1002', 0, 100);

const PERIOD = '2026-11';
let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name} — ${e.message}`); process.exitCode = 1; }
};
const row = (rows, code) => rows.find((r) => r.code === code);

check('资产负债表：货币资金期末 1200 / 年初 1000', () => {
  const { rows } = rpt.computeReport(db, 85, 'balance', PERIOD);
  const r = row(rows, 'A01');
  assert.equal(r.v1, 1200);
  assert.equal(r.v2, 1000);
});

check('资产负债表：资产总计 = 负债和所有者权益总计', () => {
  const { rows } = rpt.computeReport(db, 85, 'balance', PERIOD);
  assert.equal(row(rows, 'Z1').v1, 1200);
  assert.equal(row(rows, 'Z2').v1, 1200);
  assert.equal(row(rows, 'E01').v1, 1000);
  assert.equal(row(rows, 'E04').v1, 200);
});

check('利润表：收入 300 / 成本 100 / 净利润 200', () => {
  const { rows } = rpt.computeReport(db, 85, 'income', PERIOD);
  assert.equal(row(rows, 'I01').v1, 300);
  assert.equal(row(rows, 'I02').v1, 100);
  assert.equal(row(rows, 'I13').v1, 200);
});

check('现金流量表：本期净增加 200，期末余额 1200', () => {
  const { rows } = rpt.computeReport(db, 85, 'cash', PERIOD);
  assert.equal(row(rows, 'C04').v1, 200);
  assert.equal(row(rows, 'C06').v1, 1200);
});

check('行间引用：流动资产合计 = 明细之和', () => {
  const { rows } = rpt.computeReport(db, 85, 'balance', PERIOD);
  const sum = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08']
    .map((c) => row(rows, c)?.v1 || 0).reduce((a, b) => a + b, 0);
  assert.equal(row(rows, 'A09').v1, sum);
});

check('公式安全：拒绝 eval / 未知函数 / 非法科目', () => {
  assert.ok(rpt.validateFormula('eval(1)'));
  assert.ok(rpt.validateFormula('QM(abc)'));
  assert.ok(rpt.validateFormula('QM(1002'));
  assert.ok(rpt.validateFormula('1+'.repeat(400)));
  assert.equal(rpt.validateFormula('QM(1002)+QC(1001)'), '');
});

check('除零不崩溃，返回 0', () => {
  const v = rpt.evalFormula('QM(1002)/0', { pick: () => 0 });
  assert.equal(v, 0);
});

check('模板读写 + 非法公式被拒 + 重置回默认', () => {
  const custom = [
    { code: 'X1', name: '现金', kind: 'item', side: 'left', level: 1, formula: 'QM(1001)+QM(1002)' },
  ];
  rpt.saveTemplates(db, 85, 'balance', custom);
  const loaded = rpt.loadTemplates(db, 85, 'balance');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, '现金');
  assert.throws(() => rpt.saveTemplates(db, 85, 'balance', [{ name: '坏行', formula: 'eval(1)' }]), /未知函数|非法/);
  const n = rpt.resetTemplates(db, 85, 'balance');
  assert.equal(n, 1);
  assert.equal(rpt.loadTemplates(db, 85, 'balance').length, rpt.defaultTemplates('balance').length);
});

check('重分类：应收贷方余额转入预收，应付借方余额转入预付', () => {
  const db2 = new DatabaseSync(':memory:');
  db2.exec(`
    CREATE TABLE subjects (code TEXT PRIMARY KEY, direction TEXT, set_id INTEGER);
    CREATE TABLE vouchers (id INTEGER PRIMARY KEY, set_id INTEGER, period TEXT, status TEXT);
    CREATE TABLE voucher_entries (id INTEGER PRIMARY KEY, voucher_id INTEGER, subject_code TEXT, debit REAL, credit REAL);
    CREATE TABLE report_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, set_id INTEGER, type TEXT, side TEXT, code TEXT,
      name TEXT, kind TEXT, level INTEGER, formula TEXT, formula2 TEXT, sort INTEGER, updated_at TEXT);
    CREATE TABLE report_settings (set_id INTEGER, key TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (set_id, key));
  `);
  for (const [code, dir] of [['1122', '借'], ['2202', '贷'], ['2203', '贷'], ['1123', '借'], ['1002', '借']]) {
    db2.prepare('INSERT INTO subjects (code, direction, set_id) VALUES (?, ?, 85)').run(code, dir);
  }
  db2.prepare('INSERT INTO vouchers (id, set_id, period, status) VALUES (1, 85, ?, ?)').run(PERIOD, 'posted');
  // 应收 1122 贷方 50（预收性质）、应付 2202 借方 30（预付性质）
  db2.prepare('INSERT INTO voucher_entries (voucher_id, subject_code, debit, credit) VALUES (1, ?, ?, ?)').run('1122', 0, 50);
  db2.prepare('INSERT INTO voucher_entries (voucher_id, subject_code, debit, credit) VALUES (1, ?, ?, ?)').run('2202', 30, 0);
  db2.prepare('INSERT INTO voucher_entries (voucher_id, subject_code, debit, credit) VALUES (1, ?, ?, ?)').run('1002', 0, 20);

  const off = rpt.computeReport(db2, 85, 'balance', PERIOD).rows;
  assert.equal(row(off, 'A04').v1, -50);
  rpt.setReclass(db2, 85, true);
  const on = rpt.computeReport(db2, 85, 'balance', PERIOD).rows;
  assert.equal(row(on, 'A04').v1, 0);
  assert.equal(row(on, 'L04').v1, 50);
  assert.equal(row(on, 'L03').v1, 0);
  assert.equal(row(on, 'A05').v1, 30);
});

check('导出表结构：资产/负债各三列，利润表三列', () => {
  const bal = rpt.reportTable(db, 85, 'balance', PERIOD);
  assert.equal(bal.columns.length, 6);
  assert.ok(bal.rows.length > 10);
  const inc = rpt.reportTable(db, 85, 'income', PERIOD);
  assert.deepEqual(inc.columns.map((c) => c.key), ['item', 'current', 'ytd']);
});

check('非法期间与类型被拒', () => {
  assert.throws(() => rpt.computeReport(db, 85, 'balance', '2026-13'));
  assert.throws(() => rpt.computeReport(db, 85, 'nope', PERIOD));
});

console.log(`\n${pass} 项通过`);
db.close();
