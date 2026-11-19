#!/usr/bin/env node
/**
 * test-wecom —— 企微缓存接入测试（临时库 + 临时缓存目录）
 *
 *   node tools/test-wecom.mjs
 *
 * 覆盖三条硬要求：
 *   1. 同一份报表换个名字/换次保存再发一次（字节不同、事实相同）→ 不能重复入账；
 *   2. 同一份文件原样再扫一遍（字节相同）→ 不能重复入账；
 *   3. 汇总报表与明细累加不一致 → 以汇总为准，月度合计必须回到汇总值。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-wecom-'));
process.env.ZD_DB_PATH = path.join(tmp, 'test.db');

const wecom = await import('../backend/wecom.mjs');
const { all, get, db } = await import('../backend/store.mjs');
const { unzipEntries, zipStore } = await import('../backend/export.mjs');

const SET = 85;
const CACHE = 'C:/Users/zylspc/Documents/WXWork/1688850408297131/Cache/File/2026-11';
const F_JD = path.join(CACHE, '京东多多销售日报表-DH&歌剧（日更）(4).xls');
const F_TM = path.join(CACHE, '歌剧魅影旗舰店日报数据-2026.11.17.xlsx');

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name} — ${e.message}`); process.exitCode = 1; }
};

if (!fs.existsSync(F_JD) || !fs.existsSync(F_TM)) {
  console.log('SKIP 本机企微缓存里没有样例文件，跳过测试');
  process.exit(0);
}

const mkDir = (tag) => { const d = path.join(tmp, tag); fs.mkdirSync(d, { recursive: true }); return d; };
const num = (v) => Number(v) || 0;

/* ---------- 场景 A：京东日更表，含「月MTD」汇总行 ---------- */
const dirA = mkDir('a');
fs.copyFileSync(F_JD, path.join(dirA, path.basename(F_JD)));

let resA;
check('A1 首次落库：日报入账并记录汇总值', () => {
  resA = wecom.syncWecom(SET, { root: dirA, apply: true, actor: 'test' });
  assert.equal(resA.code, 0, resA.message);
  assert.equal(resA.data.accepted, 1);
  assert.ok(resA.data.rows.new > 100, `应写入多行，实际 ${resA.data.rows.new}`);
  const sm = all('SELECT * FROM wecom_summary WHERE set_id = ?', SET);
  assert.ok(sm.length >= 1, '应记录汇总值');
  assert.ok(sm.some((x) => x.month === '2026-11'), '应含 2026-11 汇总');
});

check('A2 内嵌汇总与明细矛盾时只标待复核，绝不改数', () => {
  const adj = get("SELECT COUNT(*) n FROM sales_daily WHERE set_id = ? AND sku = '__SUMADJ__'", SET);
  assert.equal(adj.n, 0, `不应有调整行，实际 ${adj.n}`);
  assert.equal(resA.data.reconcile.adopted.length, 0, '内嵌汇总不应直接采纳');
  const rv = resA.data.reconcile.review;
  assert.ok(rv.length >= 1, '应至少有一项待复核');
  assert.ok(rv.some((x) => x.channel === '歌剧魅影京东自营'), '京东自营 6 月那格应被标出');
});

/* ---------- 场景 B：外部汇总表为准 ---------- */
check('B1 外部汇总表与明细不符时，以汇总为准并补出调整行', () => {
  const ch = get("SELECT id FROM sales_channels WHERE set_id = ? AND name = '歌剧魅影京东自营'", SET);
  assert.ok(ch, '渠道应已创建');
  const before = get(`SELECT ROUND(SUM(amount),2) a FROM sales_daily WHERE set_id = ? AND channel_id = ?
      AND date LIKE '2026-10%' AND sku != '__SUMADJ__'`, SET, ch.id).a;

  // 模拟财务另发的「10 月月度汇总表」：比明细多 5000（例如明细漏了某几天）
  const target = Math.round((num(before) + 5000) * 100) / 100;
  db.prepare('DELETE FROM wecom_summary WHERE set_id = ? AND month = ? AND channel = ?').run(SET, '2026-10', '歌剧魅影京东自营');
  db.prepare(`INSERT INTO wecom_summary (set_id, month, channel, platform, amount, refund, fee, label, scope,
      source_file, created_at, updated_at) VALUES (?, ?, ?, '京东', ?, 0, 0, '10月汇总', 'external', '月度汇总表.xlsx', ?, ?)`)
    .run(SET, '2026-10', '歌剧魅影京东自营', target, '2026-11-17 18:00:00', '2026-11-17 18:00:00');

  // 文件本身已被 sha 跳过，但汇总校准必须仍然执行
  const resB = wecom.syncWecom(SET, { root: dirA, apply: true, actor: 'test' });
  assert.equal(resB.code, 0, resB.message);
  assert.ok(resB.data.reconcile.adopted.length >= 1, '应识别出外部汇总差异');

  const after = get(`SELECT ROUND(SUM(amount),2) a FROM sales_daily WHERE set_id = ? AND channel_id = ?
      AND date LIKE '2026-10%'`, SET, ch.id).a;
  assert.ok(Math.abs(num(after) - target) < 1, `月度合计应等于汇总值 ${target}，实际 ${after}`);

  const adj = get(`SELECT * FROM sales_daily WHERE set_id = ? AND channel_id = ? AND sku = '__SUMADJ__' AND date LIKE '2026-10%'`, SET, ch.id);
  assert.ok(adj, '应写入汇总差异调整行');

  const rec = get('SELECT * FROM wecom_reconcile WHERE set_id = ? AND channel = ? AND month = ?', SET, '歌剧魅影京东自营', '2026-10');
  assert.equal(rec.status, 'adopted', '台账应标为已按汇总调整');
});

check('B2 汇总改正后，调整行随之收敛（不会叠加）', () => {
  const ch = get("SELECT id FROM sales_channels WHERE set_id = ? AND name = '歌剧魅影京东自营'", SET);
  const detail = get(`SELECT ROUND(SUM(amount),2) a FROM sales_daily WHERE set_id = ? AND channel_id = ?
      AND date LIKE '2026-10%' AND sku != '__SUMADJ__'`, SET, ch.id).a;
  db.prepare('UPDATE wecom_summary SET amount = ? WHERE set_id = ? AND month = ? AND channel = ?')
    .run(detail, SET, '2026-10', '歌剧魅影京东自营');
  wecom.syncWecom(SET, { root: dirA, apply: true, actor: 'test' });
  const after = get(`SELECT ROUND(SUM(amount),2) a FROM sales_daily WHERE set_id = ? AND channel_id = ?
      AND date LIKE '2026-10%'`, SET, ch.id).a;
  assert.ok(Math.abs(num(after) - num(detail)) < 1, `汇总改为明细值后应回到 ${detail}，实际 ${after}`);
  const adjCount = get(`SELECT COUNT(*) n FROM sales_daily WHERE set_id = ? AND channel_id = ?
      AND sku = '__SUMADJ__' AND date LIKE '2026-10%'`, SET, ch.id).n;
  assert.equal(adjCount, 0, '差异归零后调整行应被清除，不留尾巴');
});

/* ---------- 场景 C：字节不同、事实相同 → 判重 ---------- */
const dirC1 = mkDir('c1');
const dirC2 = mkDir('c2');
fs.copyFileSync(F_TM, path.join(dirC1, path.basename(F_TM)));

// 重建一份 xlsx：只改一个标题文字，数值一字不动 → 字节不同，内容指纹相同
const rebuilt = path.join(dirC2, '歌剧魅影旗舰店日报数据-2026.11.17（运营群转发）.xlsx');
{
  const files = unzipEntries(fs.readFileSync(F_TM));
  const entries = Object.entries(files).map(([name, data]) => {
    if (name === 'xl/sharedStrings.xml') {
      const s = data.toString('utf8').replace('歌剧魅影旗舰店--11月份销售日报', '歌剧魅影旗舰店--11月销售日报（转发）');
      return { name, data: Buffer.from(s, 'utf8') };
    }
    return { name, data };
  });
  fs.writeFileSync(rebuilt, zipStore(entries));
}
const sha1 = fs.statSync(F_TM).size;
const sha2 = fs.statSync(rebuilt).size;

check('C1 两份文件确实不同（字节/名字都不同）', () => {
  assert.equal(fs.statSync(F_TM).size === sha2 && path.basename(F_TM) === path.basename(rebuilt), false);
});

let resC1;
check('C2 第一份正常入账', () => {
  resC1 = wecom.syncWecom(SET, { root: dirC1, apply: true, actor: 'test' });
  assert.equal(resC1.code, 0, resC1.message);
  assert.equal(resC1.data.accepted, 1, '应入账 1 份');
});

check('C3 另一会话转发的同内容报表被判重，不重复入账', () => {
  const before = get("SELECT COUNT(*) n FROM sales_daily WHERE set_id = ? AND source = 'wecom'", SET).n;
  const resC2 = wecom.syncWecom(SET, { root: dirC2, apply: true, actor: 'test' });
  assert.equal(resC2.code, 0, resC2.message);
  assert.equal(resC2.data.accepted, 0, '不应再入账');
  assert.equal(resC2.data.duplicates, 1, '应识别出 1 份重复');
  const after = get("SELECT COUNT(*) n FROM sales_daily WHERE set_id = ? AND source = 'wecom'", SET).n;
  assert.equal(after, before, '数据行数不应变化');
  const dup = get("SELECT * FROM wecom_files WHERE set_id = ? AND status = 'duplicate'", SET);
  assert.ok(dup, '台账应留一条 duplicate 记录');
});

check('C4 同一文件原样再扫一遍也不重复入账', () => {
  const before = get("SELECT COUNT(*) n FROM sales_daily WHERE set_id = ? AND source = 'wecom'", SET).n;
  const res = wecom.syncWecom(SET, { root: dirC1, apply: true, actor: 'test' });
  assert.equal(res.data.accepted, 0);
  const after = get("SELECT COUNT(*) n FROM sales_daily WHERE set_id = ? AND source = 'wecom'", SET).n;
  assert.equal(after, before);
});

check('C5 预览模式零写入', () => {
  const before = get("SELECT COUNT(*) n FROM sales_daily WHERE set_id = ? AND source = 'wecom'", SET).n;
  const beforeLedger = get('SELECT COUNT(*) n FROM wecom_files WHERE set_id = ?', SET).n;
  wecom.syncWecom(SET, { root: dirA, apply: false, actor: 'test' });
  const after = get("SELECT COUNT(*) n FROM sales_daily WHERE set_id = ? AND source = 'wecom'", SET).n;
  const afterLedger = get('SELECT COUNT(*) n FROM wecom_files WHERE set_id = ?', SET).n;
  assert.equal(after, before, '预览不应改数据');
  assert.equal(afterLedger, beforeLedger, '预览不应改台账');
});

check('C6 核对：无重复自然键', () => {
  const v = wecom.verifyWecom(SET);
  assert.equal(v.code, 0, v.message);
  assert.equal(v.data.duplicate.length, 0, `发现重复自然键 ${v.data.duplicate.length} 组`);
});

console.log(`\n===== 企微接入测试：${pass} PASS =====`);
