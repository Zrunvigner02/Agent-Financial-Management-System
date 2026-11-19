#!/usr/bin/env node
/**
 * 销售数据体检：入库是否完整、有没有遗漏、有没有重复、口径是否可用
 *
 *   node tools/audit-sales.mjs
 *   node tools/audit-sales.mjs --from 2026-11-01 --to 2026-11-30
 *
 * 检查项：
 *   1. 覆盖：最早/最晚日期、天数、按天是否断档
 *   2. 完整：品牌 × 渠道矩阵，哪些组合某天缺数
 *   3. 重复：同 (日期, 渠道, 品牌, 来源) 是否多行
 *   4. 失真空栏：退款、件数、平台费为 0 的占比（数据源本身没有这些列）
 *   5. 异常：成本 > 销售额的行（ERP 成本价可能没维护）
 *   6. 对账：库内合计 vs 原始导出文件合计
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.ZD_DB_PATH || path.join(ROOT, 'backend', 'data', 'jinli.db');
const SET = Number(process.env.ZD_SET_ID || 85);
const argv = process.argv.slice(2);
const val = (f, d = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const db = new DatabaseSync(DB);
db.exec('PRAGMA query_only = ON');
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const money = (n) => Number(n || 0).toFixed(2);

const from = val('--from') || '2026-01-01';
const to = val('--to') || '2030-12-31';

const rows = all(`SELECT * FROM sales_effective
  WHERE set_id = ? AND source = 'wdt' AND date >= ? AND date <= ?
  ORDER BY date`, SET, from, to);

console.log(`库：${DB}`);
console.log(`区间：${from} ~ ${to}`);
console.log(`旺店通有效行：${rows.length}\n`);
if (!rows.length) {
  console.log('没有数据，检查是否还没导入。');
  process.exit(0);
}

/* 1. 覆盖 */
const dates = [...new Set(rows.map((r) => r.date))].sort();
const first = dates[0];
const last = dates[dates.length - 1];
const span = Math.round((Date.parse(last) - Date.parse(first)) / 86400000) + 1;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const missing = [];
for (let d = new Date(`${first}T00:00:00`); d <= new Date(`${last}T00:00:00`); d.setDate(d.getDate() + 1)) {
  const k = ymd(d);   // 不能用 toISOString：UTC 会整体前移一天
  if (!dates.includes(k)) missing.push(k);
}
console.log('【1】覆盖');
console.log(`  ${first} ~ ${last}，有数据 ${dates.length} 天 / 区间 ${span} 天`);
console.log(`  断档：${missing.length ? missing.join(', ') : '无'}`);

/* 2. 品牌 × 渠道矩阵 */
const pairs = new Map();
for (const r of rows) {
  const k = `${r.brand || '(无品牌)'} × ${r.group_name || '(无渠道)'}`;
  const o = pairs.get(k) || { n: 0, days: new Set(), amt: 0, cost: 0, net: 0 };
  o.n += 1;
  o.days.add(r.date);
  o.amt += Number(r.amount || 0);
  o.cost += Number(r.cost || 0);
  o.net += Number(r.net_profit || 0);
  pairs.set(k, o);
}
console.log('\n【2】品牌 × 渠道');
for (const [k, o] of [...pairs.entries()].sort((a, b) => b[1].amt - a[1].amt)) {
  const gap = dates.length - o.days.size;
  console.log(`  ${k.padEnd(22)} ${String(o.days.size).padStart(2)}/${dates.length} 天  销售 ${money(o.amt).padStart(12)}  成本 ${money(o.cost).padStart(12)}${gap > 0 ? `  ⚠ 缺 ${gap} 天` : ''}`);
}

/* 3. 重复 */
const dup = all(`SELECT date, group_name, COALESCE(brand,'') b, COUNT(*) c FROM sales_daily
  WHERE set_id = ? AND source = 'wdt' AND date >= ? AND date <= ?
  GROUP BY 1,2,3 HAVING c > 1`, SET, from, to);
console.log('\n【3】重复');
console.log(`  重复键：${dup.length ? dup.map((d) => `${d.date}/${d.group_name}/${d.b}`).join(', ') : '无'}`);

/* 4. 空栏 */
const zero = (col) => rows.filter((r) => Number(r[col] || 0) === 0).length;
console.log('\n【4】字段填充（0 值视为空）');
for (const [label, col] of [['退款金额', 'return_amount'], ['退款件数', 'return_qty'], ['支付件数', 'qty'], ['平台费', 'fee'], ['成本', 'cost']]) {
  const z = zero(col);
  const pct = Math.round((z / rows.length) * 100);
  console.log(`  ${label.padEnd(6)} 空 ${String(z).padStart(3)}/${rows.length}（${pct}%）${pct === 100 ? '  ← 数据源没有这一列' : ''}`);
}

/* 5. 异常：成本 > 销售额 */
const bad = rows.filter((r) => Number(r.cost || 0) > Number(r.amount || 0));
const badAmt = bad.reduce((a, r) => a + Number(r.amount || 0), 0);
const badCost = bad.reduce((a, r) => a + Number(r.cost || 0), 0);
console.log('\n【5】成本异常（成本 > 销售额）');
console.log(`  ${bad.length} 行，涉及销售 ${money(badAmt)} / 成本 ${money(badCost)}`);
for (const r of bad.slice(0, 5)) {
  console.log(`  ${r.date} ${r.group_name}/${r.brand || '-'}  销售 ${money(r.amount)}  成本 ${money(r.cost)}`);
}

/* 6. 对账：原始导出文件 vs 库 */
const inbox = path.join('D:\\振颜丽舍\\wdt', '已入库');
const files = fs.existsSync(inbox)
  ? fs.readdirSync(inbox).filter((f) => /销售订单.*\.csv$/i.test(f)).sort()
  : [];
if (files.length) {
  const f = path.join(inbox, files[files.length - 1]);
  const text = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
  const iAmt = head.indexOf('付款订单金额');
  const iDay = head.indexOf('日期');
  let sum = 0;
  const fileDates = new Set();
  for (const l of lines.slice(1)) {
    const c = l.replace(/^=/, '').split(',').map((x) => x.replace(/"/g, '').trim());
    if (/^\d{4}-\d{2}-\d{2}$/.test(c[iDay] || '')) {
      sum += Number(c[iAmt] || 0);
      fileDates.add(c[iDay]);
    }
  }
  const dbSum = rows.filter((r) => fileDates.has(r.date)).reduce((a, r) => a + Number(r.amount || 0), 0);
  console.log('\n【6】对账（最近一份导出文件）');
  console.log(`  文件：${files[files.length - 1]}`);
  console.log(`  文件合计 ${money(sum)}　库内同日期合计 ${money(dbSum)}　差额 ${money(dbSum - sum)}`);

  // 逐天比对，定位是哪一天丢的
  const byDay = new Map();
  for (const l of lines.slice(1)) {
    const c = l.replace(/^=/, '').split(',').map((x) => x.replace(/"/g, '').trim());
    const d = c[iDay] || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    byDay.set(d, (byDay.get(d) || 0) + Number(c[iAmt] || 0));
  }
  const dbDay = new Map();
  for (const r of rows) dbDay.set(r.date, (dbDay.get(r.date) || 0) + Number(r.amount || 0));
  console.log('  按日：', [...byDay.entries()].sort().map(([d, v]) => {
    const dv = dbDay.get(d) || 0;
    const diff = Math.round((dv - v) * 100) / 100;
    return `${d.slice(5)} ${money(v)}${diff ? `(差${money(diff)})` : '✓'}`;
  }).join('  '));
}
