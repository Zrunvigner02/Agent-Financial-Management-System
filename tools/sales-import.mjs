#!/usr/bin/env node
/**
 * 把三份平台销售文件导入 sales_daily（口径：platform，与 sales_dept / wdt 分离）。
 *
 *   node tools/sales-import.mjs
 *
 * 依赖 .local/jd.json（xls 已转 JSON）、.local/xhs.json、.local/tm.json
 * 全部按「日期 + 渠道」落库，product 记「全店」，不拆单品。
 */
import fs from 'node:fs';
import { all, run, get, now } from '../backend/store.mjs';

const SET = 85;

const pad = (n) => String(n).padStart(2, '0');
const fromSerial = (n) => {
  const ms = Date.UTC(1899, 11, 30) + Math.round(Number(n)) * 86400000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

function channelId(name, platform) {
  const row = get('SELECT id FROM sales_channels WHERE set_id = ? AND name = ?', SET, name);
  if (row) return row.id;
  const info = run(`INSERT INTO sales_channels (set_id, name, platform, shop_code, source, active, created_at)
    VALUES (?, ?, ?, '', 'platform', 1, ?)`, SET, name, platform, now());
  return Number(info.lastInsertRowid);
}

const rows = [];

/* ---------- 京东 / 拼多多 ---------- */
if (fs.existsSync('.local/jd.json')) {
  const sheets = JSON.parse(fs.readFileSync('.local/jd.json', 'utf8'));
  for (const s of sheets) {
    if (!/京东|拼多多/.test(s.name)) continue;
    const platform = /拼多多/.test(s.name) ? '拼多多' : '京东';
    const cid = channelId(s.name, platform);
    for (const r of s.grid.slice(1)) {
      const d = r[0];
      if (typeof d !== 'number') continue;               // 跳过「11月MTD」等汇总行
      if (d < 40000) continue;                            // 不是日期序列
      const amount = Number(r[4] || 0);
      const refund = Number(r[7] || 0);
      const fee = Number(r[12] || 0);
      const netAmount = Number(r[9] || (amount - refund));
      if (!amount && !fee && !refund) continue;
      rows.push({ date: fromSerial(d), cid, amount, refund, fee, net: netAmount, platform, name: s.name });
    }
  }
}

/* ---------- 小红书 ---------- */
if (fs.existsSync('.local/xhs.json')) {
  const d = JSON.parse(fs.readFileSync('.local/xhs.json', 'utf8'));
  const cid = channelId('德国世家小红书', '小红书');
  for (const r of d.sheet1 || []) {
    if (r.row < 4) continue;
    const raw = r.cells.A;
    if (typeof raw !== 'string' || !/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(raw)) continue;
    const [y, m, day] = raw.split('/').map(Number);
    const amount = Number(r.cells.B || 0);
    const refund = Number(r.cells.C || 0);
    const fee = Number(r.cells.E || 0);
    rows.push({ date: `${y}-${pad(m)}-${pad(day)}`, cid, amount, refund, fee, net: amount - refund, platform: '小红书', name: '德国世家小红书' });
  }
}

/* ---------- 天猫（drhauschka 海外旗舰店） ---------- */
if (fs.existsSync('.local/tm.json')) {
  const d = JSON.parse(fs.readFileSync('.local/tm.json', 'utf8'));
  const cid = channelId('drhauschka海外旗舰店（天猫）', '天猫');
  for (const r of d.nov || []) {
    if (r.row < 4) continue;
    const serial = r.cells.A;
    if (typeof serial !== 'number' || serial < 40000) continue;
    const amount = Number(r.cells.F || 0);
    if (!amount) continue;
    rows.push({ date: fromSerial(serial), cid, amount, refund: 0, fee: 0, net: amount, platform: '天猫', name: 'drhauschka海外旗舰店（天猫）' });
  }
}

/* ---------- 写库（先清掉旧的 platform 口径数据） ---------- */
run("DELETE FROM sales_daily WHERE set_id = ? AND source = 'platform'", SET);
let n = 0;
for (const r of rows) {
  run(`INSERT INTO sales_daily (set_id, channel_id, date, sku, product, group_name, qty, amount, return_qty, return_amount,
      cost, fee, gross_profit, net_profit, source, batch_id, created_at)
    VALUES (?, ?, ?, '', '全店', ?, 0, ?, 0, ?, 0, ?, ?, ?, 'platform', 0, ?)`,
  SET, r.cid, r.date, r.platform, r.amount, r.refund, r.fee,
  Math.round((r.net - r.fee) * 100) / 100, Math.round((r.net - r.fee) * 100) / 100, now());
  n += 1;
}

const stat = all(`SELECT c.name, c.platform, MIN(d.date) AS d1, MAX(d.date) AS d2,
    COUNT(*) AS n, ROUND(SUM(d.amount),2) AS amt, ROUND(SUM(d.return_amount),2) AS refund, ROUND(SUM(d.fee),2) AS fee
  FROM sales_daily d JOIN sales_channels c ON c.id = d.channel_id
  WHERE d.set_id = ? AND d.source = 'platform' GROUP BY c.id ORDER BY c.id`, SET);
console.log(`导入 ${n} 行`);
for (const s of stat) console.log(`${s.platform} | ${s.name} | ${s.d1}~${s.d2} | ${s.n} 天 | 销售额 ${s.amt} | 退款 ${s.refund} | 推广费 ${s.fee}`);
