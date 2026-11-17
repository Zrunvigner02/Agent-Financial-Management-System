#!/usr/bin/env node
/**
 * 按样例锁死格式生成销售报表（平台口径）。
 *
 *   node tools/make-sales-report.mjs [period]   默认 2026-11
 *
 * 输出：exports/销售报表_<period>_平台口径.xlsx
 * 工作表：总月对比表 / 歌剧月对比表 / 日汇总表
 * 列定义与样例一致：销售数量·增长比 / 销售额·增长比 / 退货数量·增长比 / 退货金额·增长比 /
 *                  毛利润 / 毛利率 / 销售净利额 / 销售净利率 / 总结
 */
import fs from 'node:fs';
import path from 'node:path';
import { all } from '../backend/store.mjs';
import { zipStore } from '../backend/export.mjs';

const SET = 85;
const PERIOD = process.argv[2] || '2026-11';
const YEAR = PERIOD.slice(0, 4);
const MONTH = Number(PERIOD.slice(5, 7));
const OUT_DIR = path.resolve('exports');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const pct = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : '');

/* ---------- 数据 ---------- */
const rows = all(`SELECT d.*, c.name AS channel, c.platform,
    substr(d.date,1,7) AS period, substr(d.date,1,4) AS yr, cast(substr(d.date,6,2) as integer) AS mo
  FROM sales_daily d JOIN sales_channels c ON c.id = d.channel_id
  WHERE d.set_id = ? AND d.source = 'platform'`, SET);

const brandOf = (channel) => (channel.startsWith('歌剧') ? '歌剧' : channel.startsWith('DH') || /drhauschka|德国世家/.test(channel) ? 'DH' : '其他');

/* 月度汇总：品牌 × 月 */
const monthAgg = new Map();
for (const r of rows) {
  if (r.yr !== YEAR) continue;
  const b = brandOf(r.channel);
  const k = `${b}|${r.mo}`;
  const a = monthAgg.get(k) || { qty: 0, amount: 0, refundQty: 0, refund: 0, fee: 0 };
  a.qty += Number(r.qty || 0);
  a.amount += Number(r.amount || 0);
  a.refundQty += Number(r.return_qty || 0);
  a.refund += Number(r.return_amount || 0);
  a.fee += Number(r.fee || 0);
  monthAgg.set(k, a);
}

/* 日汇总：渠道 × 月内日 */
const daysInMonth = new Date(Number(YEAR), MONTH, 0).getDate();
const dayAgg = new Map();
for (const r of rows) {
  if (r.period !== PERIOD) continue;
  const day = Number(r.date.slice(8, 10));
  const k = `${r.channel}|${day}`;
  const a = dayAgg.get(k) || { qty: 0, amount: 0, refund: 0, fee: 0 };
  a.qty += Number(r.qty || 0);
  a.amount += Number(r.amount || 0);
  a.refund += Number(r.return_amount || 0);
  a.fee += Number(r.fee || 0);
  dayAgg.set(k, a);
}

const growth = (cur, prev) => (prev ? pct(cur / prev - 1) : '');

/* ---------- 月度行（某品牌某月 全部列） ---------- */
const M = (v) => ({ n: r2(v), s: 1 });
const P = (v) => (v === '' || !Number.isFinite(Number(v)) ? '' : { n: Number(v), s: 2 });

function monthRow(brand, mo) {
  const a = monthAgg.get(`${brand}|${mo}`) || { qty: 0, amount: 0, refundQty: 0, refund: 0, fee: 0 };
  const prev = monthAgg.get(`${brand}|${mo - 1}`) || { qty: 0, amount: 0, refundQty: 0, refund: 0, fee: 0 };
  const net = a.amount - a.refund;
  // 平台口径暂无成本：毛利/毛利率留空，净利按「去退成交额 - 推广费」计
  const profit = net - a.fee;
  return [
    a.qty || '', P(growth(a.qty, prev.qty)),
    M(a.amount), P(growth(a.amount, prev.amount)),
    a.refundQty || '', P(growth(a.refundQty, prev.refundQty)),
    M(a.refund), P(growth(a.refund, prev.refund)),
    '', '',
    M(profit), P(a.amount ? profit / a.amount : ''),
    '',
  ];
}

function sumRows(list) {
  const acc = { qty: 0, amount: 0, refundQty: 0, refund: 0, gross: 0, profit: 0 };
  for (const v of list) {
    acc.qty += Number(v[0] || 0);
    acc.amount += Number(v[2] || 0);
    acc.refundQty += Number(v[4] || 0);
    acc.refund += Number(v[6] || 0);
    acc.gross += Number(v[8] || 0);
    acc.profit += Number(v[10] || 0);
  }
  return [acc.qty || '', '', M(acc.amount), '', acc.refundQty || '', '',
    M(acc.refund), '', '', '',
    M(acc.profit), P(acc.amount ? acc.profit / acc.amount : ''), ''];
}

/* ---------- 工作表构建 ---------- */
const HEAD1 = ['', '', '销售数量', '', '销售额', '', '退货 ', '', '退货金额', '', '', '', '', '', ''];
const HEAD2 = ['', '', '销售数量', '增长比', '销售额', '增长比', '退货数量', '增长比', '退货金额', '增长比',
  '毛利润', '毛利率', '销售净利额', '销售净利率', '总结'];

function sheetTotal() {
  const data = [['总月对比表'], [], HEAD1, HEAD2];
  for (const [brand, label] of [['歌剧', '歌剧'], ['DH', 'DH']]) {
    data.push([label, ...Array(13).fill('')]);
    const months = [];
    for (let m = 1; m <= 12; m += 1) {
      const row = monthRow(brand, m);
      months.push(row);
      data.push(['', `${m}月`, ...row]);
    }
    data.push(['', '小计', ...sumRows(months)]);
    data.push([]);
  }
  return data;
}

function sheetBrand(brand, title) {
  const data = [[title], [], ['', '销售数量', '', '销售额', '', '退货 ', '', '退货金额', ''], HEAD2];
  const months = [];
  for (let m = 1; m <= 12; m += 1) {
    const row = monthRow(brand, m);
    months.push(row);
    data.push([`${m}月`, ...row]);
  }
  data.push(['总计', ...sumRows(months)]);
  return data;
}

function sheetDaily() {
  const channels = [...new Set(rows.filter((r) => r.period === PERIOD).map((r) => r.channel))];
  const order = ['天猫', '抖音', '小红书', '京东', '拼多多', '分销'];
  channels.sort((a, b) => {
    const ia = order.findIndex((o) => a.includes(o) || (o === '京东' && /京东/.test(a)));
    const ib = order.findIndex((o) => b.includes(o) || (o === '京东' && /京东/.test(b)));
    return (ia + 1 || 99) - (ib + 1 || 99);
  });
  const dayHead = ['', ...Array.from({ length: daysInMonth }, () => ['', '', '', '']).flat().map((x, i) => (i % 4 === 0 ? `${i / 4 + 1}日` : ''))];
  const subHead = ['', ...Array(daysInMonth).fill(['销售数量', '销售额', '费比', '毛利率']).flat()];
  const data = [['日汇总表'], [], dayHead, subHead];
  const totals = new Array(daysInMonth).fill(0).map(() => ({ amount: 0, fee: 0 }));
  for (const ch of channels) {
    const line = [ch];
    for (let d = 1; d <= daysInMonth; d += 1) {
      const a = dayAgg.get(`${ch}|${d}`);
      const amount = a ? a.amount : 0;
      const fee = a ? a.fee : 0;
      const net = a ? a.amount - a.refund : 0;
      totals[d - 1].amount += amount;
      totals[d - 1].fee += fee;
      line.push(a && a.qty ? a.qty : '', amount ? M(amount) : '', amount ? P(fee / amount) : '', '');
    }
    data.push(line);
  }
  const total = ['总计'];
  for (let d = 1; d <= daysInMonth; d += 1) {
    total.push('', totals[d - 1].amount ? M(totals[d - 1].amount) : '',
      totals[d - 1].amount ? P(totals[d - 1].fee / totals[d - 1].amount) : '', '');
  }
  data.push(total);
  return data;
}

/* ---------- XLSX 序列化 ---------- */
const colName = (i) => {
  let s = ''; let n = i + 1;
  while (n > 0) { n -= 1; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sheetXml(rowsArr) {
  const xml = rowsArr.map((row, ri) => {
    const cells = row.map((v, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      if (v === '' || v == null) return '';
      if (typeof v === 'object' && v && typeof v.n === 'number') {
        return `<c r="${ref}" s="${v.s || 0}"><v>${Math.round(v.n * 10000) / 10000}</v></c>`;
      }
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xml}</sheetData></worksheet>`;
}

const sheets = [
  { name: '总月对比表', rows: sheetTotal() },
  { name: '歌剧月对比表', rows: sheetBrand('歌剧', '歌剧月对比表') },
  { name: 'DH月对比表', rows: sheetBrand('DH', 'DH月对比表') },
  { name: '日汇总表', rows: sheetDaily() },
];

function buildWorkbook(list) {
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts><fonts count="1"><font><sz val="11"/><name val="微软雅黑"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>` },
  ];
  list.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) }));
  return zipStore(files);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `销售报表_${PERIOD}_平台口径.xlsx`);
fs.writeFileSync(out, buildWorkbook(sheets));

const totalAmount = r2(rows.filter((r) => r.period === PERIOD).reduce((s, r) => s + Number(r.amount || 0), 0));
const totalRefund = r2(rows.filter((r) => r.period === PERIOD).reduce((s, r) => s + Number(r.return_amount || 0), 0));
const totalFee = r2(rows.filter((r) => r.period === PERIOD).reduce((s, r) => s + Number(r.fee || 0), 0));
console.log(JSON.stringify({
  file: out, bytes: fs.statSync(out).size, period: PERIOD,
  sheets: sheets.map((s) => s.name),
  rows: rows.length, month_amount: totalAmount, month_refund: totalRefund, month_fee: totalFee,
}, null, 2));
