#!/usr/bin/env node
/**
 * 生命周期（离职 / 品牌停做）回归：历史不删、未来不计
 *
 * 用 ZD_DB_PATH 指向临时库，绝不碰真实账套。
 *
 *   node tools/test-lifecycle.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-life-'));
process.env.ZD_DB_PATH = path.join(TMP, 'life.db');

const { all, get, run, now, DEFAULT_SET_ID } = await import('../backend/store.mjs');
const life = await import('../backend/lifecycle.mjs');
const rec = await import('../backend/recurring.mjs');
const ent = await import('../backend/enterprise.mjs');

const SET = DEFAULT_SET_ID;
let pass = 0;
let fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name}${extra ? ` -> ${extra}` : ''}`); }
};
const money = (v) => Math.round(Number(v || 0) * 100) / 100;

/* ---------- 1. 建立固定支出模板：张三工资 5000 ---------- */
const tpl = rec.saveTemplate(SET, {
  name: '工资-张三', category: '工资', person: '张三', amount: 5000, day: 10,
}, 'test');
check(tpl.code === 0, '建立工资模板', tpl.message);
const tplId = tpl.data?.id;

/* ---------- 2. 正常月份照常生成 ---------- */
const oct = rec.generateForPeriod(SET, '2026-10', 'test');
check(oct.code === 0 && oct.data.created.length === 1, '10 月正常生成 1 张', JSON.stringify(oct.data?.created));
const octAmount = oct.data?.created?.[0]?.amount;
check(money(octAmount) === 5000, '10 月金额 5000', String(octAmount));

/* ---------- 3. 登记离职：最后有效日 2026-11-16 ---------- */
const stop = life.setStatus(SET, {
  type: 'staff', name: '张三', action: 'stop', effective_to: '2026-11-16', reason: '离职', prorate: true,
}, 'test');
check(stop.code === 0 && stop.data.effective_to === '2026-11-16', '登记离职（最后有效日）', stop.message);

/* ---------- 4. 11 月按天折算 ---------- */
const planNov = rec.plan(SET, '2026-11');
const tplNov = (planNov.data?.templates || []).find((t) => t.id === tplId);
check(!!tplNov && tplNov.prorated === true, '11 月标记为按天折算', JSON.stringify(tplNov));
check(money(tplNov?.amount) === money(5000 * 16 / 30), '11 月折算金额 = 5000×16/30', String(tplNov?.amount));

const nov = rec.generateForPeriod(SET, '2026-11', 'test');
const novAmt = nov.data?.created?.[0]?.amount;
check(money(novAmt) === money(5000 * 16 / 30), '11 月生成折算金额', String(novAmt));

const novVoucher = get('SELECT id FROM vouchers WHERE id = ?', nov.data.created[0].voucher_id);
const novEntry = get('SELECT SUM(debit) AS d, SUM(credit) AS c FROM voucher_entries WHERE voucher_id = ?', novVoucher.id);
check(money(novEntry.d) === money(novEntry.c), '折算后借贷仍平衡', `${novEntry.d}/${novEntry.c}`);
const novSummary = all('SELECT summary FROM voucher_entries WHERE voucher_id = ?', novVoucher.id)[0]?.summary || '';
check(/折算/.test(novSummary), '分录摘要写明折算依据', novSummary);

/* ---------- 5. 12 月起不再生成 ---------- */
const dec = rec.generateForPeriod(SET, '2026-12', 'test');
check(dec.code === 0 && dec.data.created.length === 0, '12 月不再生成固定支出', JSON.stringify(dec.data?.skipped));
const planDec = rec.plan(SET, '2026-12');
check((planDec.data?.templates || []).every((t) => t.id !== tplId), '12 月计划里不再出现该项');

/* ---------- 6. 历史一分不少 ---------- */
const octStill = get(`SELECT v.id, v.status FROM vouchers v WHERE v.id = ?`, oct.data.created[0].voucher_id);
check(!!octStill, '10 月历史凭证仍在');
const octSum = get('SELECT SUM(debit) AS d FROM voucher_entries WHERE voucher_id = ?', octStill.id)?.d;
check(money(octSum) === 5000, '历史凭证金额未被改写', String(octSum));
const runs = all('SELECT period, amount FROM recurring_runs WHERE template_id = ? ORDER BY period', tplId);
check(runs.length === 2, 'recurring_runs 保留 10、11 两期', JSON.stringify(runs));

/* ---------- 7. 业绩：停用后的销售不计入本人 ---------- */
ent.listSales(SET, { limit: 1 });   // 触发扩展列补齐（staff / group_name）
const ins = (staff, date, amount) => run(`INSERT INTO sales_daily
  (set_id, channel_id, date, sku, product, qty, amount, return_qty, return_amount, cost, staff, source, batch_id, created_at)
  VALUES (?, 0, ?, '', '全店', 0, ?, 0, 0, 0, ?, 'wecom', 0, ?)`, SET, date, amount, staff, now());
ins('张三', '2026-10-05', 1000);
ins('张三', '2026-11-20', 2000);   // 离职之后，不应计入
ins('李四', '2026-11-20', 500);

const sum = ent.staffSummary(SET).data.items;
const zhangsan = sum.find((x) => x.staff === '张三');
const lisi = sum.find((x) => x.staff === '李四');
check(money(zhangsan?.amount) === 1000, '张三业绩只算到停用日（1000）', JSON.stringify(zhangsan));
check(money(lisi?.amount) === 500, '李四业绩不受影响', JSON.stringify(lisi));
const rawRows = get(`SELECT COUNT(*) AS n FROM sales_daily WHERE set_id = ? AND staff = '张三'`, SET)?.n;
check(Number(rawRows) === 2, '原始销售行一条未删（2 行仍在库）', String(rawRows));

/* ---------- 8. 恢复：重新启用后又能生成 ---------- */
const resume = life.setStatus(SET, { type: 'staff', name: '张三', action: 'resume' }, 'test');
check(resume.code === 0, '恢复启用', resume.message);
const dec2 = rec.generateForPeriod(SET, '2026-12', 'test');
check(dec2.data?.created?.length === 1, '恢复后 12 月重新生成', JSON.stringify(dec2.data?.created));

/* ---------- 9. 品牌停用：日期判定 + 不改历史 ---------- */
const brandStop = life.setStatus(SET, {
  type: 'brand', name: '世家', action: 'stop', effective_to: '2026-11-30', reason: '品牌不做了',
}, 'test');
check(brandStop.code === 0, '登记品牌停用', brandStop.message);
const brandOk = life.dayFilter(SET, 'brand');
check(brandOk('世家', '2026-11-30') === true, '品牌停用日当天仍算');
check(brandOk('世家', '2026-12-01') === false, '品牌停用次日起不算');
check(brandOk('PF79', '2026-12-01') === true, '其它品牌不受影响');

/* ---------- 10. 只给月份 → 按月末 ---------- */
life.setStatus(SET, { type: 'staff', name: '王五', action: 'stop', effective_to: '2026-11' }, 'test');
check(life.statusOf(SET, 'staff', '王五')?.effective_to === '2026-11-30', '只给月份按月末算');

/* ---------- 11. 留痕 & 幂等 ---------- */
const logs = life.listStatus(SET).data.logs.filter((l) => l.name === '张三');
check(logs.length >= 2, '停用/恢复均有日志留痕', String(logs.length));
const dup = life.setStatus(SET, { type: 'staff', name: '王五', action: 'stop', effective_to: '2026-11' }, 'test');
check(dup.code === 0 && life.listStatus(SET).data.items.filter((x) => x.name === '王五').length === 1, '重复停用不产生重复行');

console.log(`\n===== 生命周期回归：${pass} PASS / ${fail} FAIL =====`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
