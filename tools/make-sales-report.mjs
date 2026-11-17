#!/usr/bin/env node
/**
 * 按样板锁死格式生成销售报表（平台口径）。
 *
 *   node tools/make-sales-report.mjs [period]
 *
 * 输出：exports/销售报表_<period>_平台口径.xlsx
 * 版式与「AI；月对比表-日报汇总」一致：
 *   总月对比表：A 品牌（纵向合并）· B 月份 · C 数量 · D 增长比 · E 销售额 · F 增长比
 *               G 退货数量 · H 增长比 · I 退货金额 · J 增长比 · K 毛利润 · L 毛利率
 *               M 销售净利额 · N 销售净利率 · O 总结
 *   品牌月对比表：A 月份 · B 数量 … N 总结
 *   日汇总表：A 渠道 · 每天 4 列（销售数量 / 销售额 / 费比 / 毛利率）
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
const val = (x) => (typeof x === 'object' && x ? Number(x.v || 0) : Number(x || 0));

/* ---------- 数据 ---------- */
const rows = all(`SELECT d.*, c.name AS channel, c.platform,
    substr(d.date,1,7) AS period, substr(d.date,1,4) AS yr, cast(substr(d.date,6,2) as integer) AS mo
  FROM sales_daily d JOIN sales_channels c ON c.id = d.channel_id
  WHERE d.set_id = ? AND d.source = 'platform'`, SET);

const BRAND = (channel) => {
  if (/歌剧/.test(channel)) return '歌剧';
  if (/PF|pf79/i.test(channel)) return 'PF';
  if (/DH|drhauschka|德国世家|世家/i.test(channel)) return 'DH';
  return '其他';
};

const monthAgg = new Map();
for (const r of rows) {
  if (r.yr !== YEAR) continue;
  const k = `${BRAND(r.channel)}|${r.mo}`;
  const a = monthAgg.get(k) || { qty: 0, amount: 0, refundQty: 0, refund: 0, fee: 0 };
  a.qty += Number(r.qty || 0);
  a.amount += Number(r.amount || 0);
  a.refundQty += Number(r.return_qty || 0);
  a.refund += Number(r.return_amount || 0);
  a.fee += Number(r.fee || 0);
  monthAgg.set(k, a);
}
const brandHasData = (b) => [...monthAgg.keys()].some((k) => k.startsWith(`${b}|`));

const daysInMonth = new Date(Number(YEAR), MONTH, 0).getDate();
const dayAgg = new Map();
for (const r of rows) {
  if (r.period !== PERIOD) continue;
  const k = `${r.channel}|${Number(r.date.slice(8, 10))}`;
  const a = dayAgg.get(k) || { qty: 0, amount: 0, refund: 0, fee: 0 };
  a.qty += Number(r.qty || 0);
  a.amount += Number(r.amount || 0);
  a.refund += Number(r.return_amount || 0);
  a.fee += Number(r.fee || 0);
  dayAgg.set(k, a);
}

/* ---------- 单元格包装 ---------- */
// s: 1 标题 2 表头 3 文字 4 金额 5 百分比 6 居中 7 小计文字 8 小计金额 9 小计百分比
const T = (v, s = 3) => (v === '' || v == null ? '' : { v: String(v), s });
const M = (v) => (v === '' || v == null ? '' : { v: r2(v), s: 4, n: true });
const P = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? '' : { v: Number(v), s: 5, n: true });
const SM = (v) => (v === '' || v == null ? '' : { v: r2(v), s: 8, n: true });
const SP = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? '' : { v: Number(v), s: 9, n: true });

const growth = (cur, prev) => (prev ? Math.round((cur / prev - 1) * 10000) / 10000 : '');

/** 某品牌某月的 12 个指标（C..N；O 总结留空） */
function monthCells(brand, mo) {
  if (mo > MONTH || !brandHasData(brand)) return Array(12).fill('');
  const a = monthAgg.get(`${brand}|${mo}`);
  const prev = monthAgg.get(`${brand}|${mo - 1}`);
  if (!a) return Array(12).fill('');
  const net = a.amount - a.refund;
  const profit = net - a.fee;
  return [
    a.qty || '', prev ? P(growth(a.qty, prev.qty)) : '',
    M(a.amount), prev ? P(growth(a.amount, prev.amount)) : '',
    a.refundQty || '', prev ? P(growth(a.refundQty, prev.refundQty)) : '',
    M(a.refund), prev ? P(growth(a.refund, prev.refund)) : '',
    '', '',
    M(profit), P(a.amount ? profit / a.amount : ''),
  ];
}

function subtotalCells(brand, money = SM, pct = SP) {
  if (!brandHasData(brand)) return Array(12).fill('');
  const acc = { qty: 0, amount: 0, refundQty: 0, refund: 0, profit: 0 };
  for (let m = 1; m <= MONTH; m += 1) {
    const v = monthCells(brand, m);
    acc.qty += val(v[0]); acc.amount += val(v[2]); acc.refundQty += val(v[4]);
    acc.refund += val(v[6]); acc.profit += val(v[10]);
  }
  return [acc.qty || '', '', money(acc.amount), '', acc.refundQty || '', '',
    money(acc.refund), '', '', '', money(acc.profit), pct(acc.amount ? acc.profit / acc.amount : '')];
}

/* ---------- 总月对比表 ---------- */
const BRAND_ORDER = ['歌剧', 'PF', 'DH'];

function sheetTotal() {
  const out = [];
  const merges = [];
  out.push([T('总月对比表', 1)]);
  merges.push('A1:O1');
  out.push(['', '', T('销售数量', 2), '', T('销售额', 2), '', T('退货', 2), '', T('退货金额', 2), '', '', '', '', '', '']);
  merges.push('C2:D2', 'E2:F2', 'G2:H2', 'I2:J2');
  out.push(['', '', T('销售数量', 2), T('增长比', 2), T('销售额', 2), T('增长比', 2),
    T('退货数量', 2), T('增长比', 2), T('退货金额', 2), T('增长比', 2),
    T('毛利润', 2), T('毛利率', 2), T('销售净利额', 2), T('销售净利率', 2), T('总结', 2)]);

  let r = 4;
  for (const brand of BRAND_ORDER) {
    const start = r;
    out.push([T(brand, 3)]);
    for (let m = 1; m <= MONTH; m += 1) {
      out.push(['', T(`${m}月`, 6), ...monthCells(brand, m), '']);
      r += 1;
    }
    out.push(['', T('小计', 7), ...subtotalCells(brand), T('', 7)]);
    r += 1;
    merges.push(`A${start}:A${r - 1}`);
  }
  return { rows: out, merges, widths: [9, 8, 9, 9, 13, 9, 9, 9, 12, 9, 10, 9, 12, 12, 10] };
}

/* ---------- 品牌月对比表 ---------- */
function sheetBrand(brand, title) {
  const out = [];
  const merges = [];
  out.push([T(title, 1)]);
  merges.push('A1:N1');
  out.push(['', T('销售数量', 2), '', T('销售额', 2), '', T('退货', 2), '', T('退货金额', 2), '', '', '', '', '', '']);
  merges.push('B2:C2', 'D2:E2', 'F2:G2', 'H2:I2');
  out.push(['', T('销售数量', 2), T('增长比', 2), T('销售额', 2), T('增长比', 2),
    T('退货数量', 2), T('增长比', 2), T('退货金额', 2), T('增长比', 2),
    T('毛利润', 2), T('毛利率', 2), T('销售净利额', 2), T('销售净利率', 2), T('总结', 2)]);
  for (let m = 1; m <= 12; m += 1) out.push([T(`${m}月`, 6), ...monthCells(brand, m), '']);
  out.push([T('总计', 7), ...subtotalCells(brand), T('', 7)]);
  return { rows: out, merges, widths: [9, 10, 10, 12, 10, 10, 10, 12, 10, 12, 10, 12, 12, 16] };
}

/* ---------- 日汇总表 ---------- */
function sheetDaily() {
  const chans = [...new Set(rows.filter((x) => x.period === PERIOD).map((x) => x.channel))];
  const orderKey = (n) => (/天猫/.test(n) ? 1 : /抖音/.test(n) ? 2 : /小红书/.test(n) ? 3
    : /京东/.test(n) ? 4 : /拼多多/.test(n) ? 5 : /分销/.test(n) ? 6 : 9);
  chans.sort((a, b) => orderKey(a) - orderKey(b) || a.localeCompare(b));

  const out = [];
  const merges = [];
  out.push([T('日汇总表', 1)]);
  merges.push(`A1:${colName(daysInMonth * 4)}1`);

  const dayRow = [''];
  const subRow = [''];
  for (let d = 1; d <= daysInMonth; d += 1) {
    dayRow.push(T(`${d}日`, 2), '', '', '');
    subRow.push(T('销售数量', 2), T('销售额', 2), T('费比', 2), T('毛利率', 2));
    merges.push(`${colName(1 + (d - 1) * 4)}2:${colName(1 + (d - 1) * 4 + 3)}2`);
  }
  out.push(dayRow, subRow);

  const totals = Array.from({ length: daysInMonth }, () => ({ amount: 0, fee: 0 }));
  for (const ch of chans) {
    const line = [T(ch, 3)];
    for (let d = 1; d <= daysInMonth; d += 1) {
      const a = dayAgg.get(`${ch}|${d}`);
      const amount = a ? a.amount : 0;
      const fee = a ? a.fee : 0;
      totals[d - 1].amount += amount;
      totals[d - 1].fee += fee;
      line.push(a && a.qty ? a.qty : '', amount ? M(amount) : '', amount ? P(fee / amount) : '', '');
    }
    out.push(line);
  }
  const totalLine = [T('总计', 7)];
  for (let d = 1; d <= daysInMonth; d += 1) {
    totalLine.push('', totals[d - 1].amount ? SM(totals[d - 1].amount) : '',
      totals[d - 1].amount ? SP(totals[d - 1].fee / totals[d - 1].amount) : '', '');
  }
  out.push(totalLine);
  const widths = [20];
  for (let d = 0; d < daysInMonth * 4; d += 1) widths.push(d % 4 === 1 ? 11 : 8);
  return { rows: out, merges, widths };
}

/* ---------- XLSX 序列化 ---------- */
function colName(i) {
  let s = ''; let n = i + 1;
  while (n > 0) { n -= 1; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sheetXml(sheet) {
  const body = sheet.rows.map((row, ri) => {
    const cells = row.map((cell, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      if (cell === '' || cell == null) return '';
      if (typeof cell === 'object') {
        const s = cell.s || 3;
        if (cell.n) return `<c r="${ref}" s="${s}"><v>${Math.round(Number(cell.v) * 10000) / 10000}</v></c>`;
        return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
      }
      return `<c r="${ref}" s="3" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  const cols = `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  const merges = sheet.merges.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData>${merges}</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="宋体"/></font><font><b/><sz val="11"/><name val="宋体"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="165" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
</cellXfs></styleSheet>`;

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
    { name: 'xl/styles.xml', data: STYLES },
  ];
  list.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
  return zipStore(files);
}

const sheets = [
  { name: '总月对比表', ...sheetTotal() },
  { name: '歌剧月对比表', ...sheetBrand('歌剧', '歌剧月对比表') },
  { name: 'PF月对比表', ...sheetBrand('PF', 'PF月对比表') },
  { name: 'DH月对比表', ...sheetBrand('DH', 'DH月对比表') },
  { name: '日汇总表', ...sheetDaily() },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `销售报表_${PERIOD}_平台口径.xlsx`);
fs.writeFileSync(out, buildWorkbook(sheets));

const scope = rows.filter((x) => x.period === PERIOD);
console.log(JSON.stringify({
  file: out, bytes: fs.statSync(out).size, period: PERIOD, sheets: sheets.map((s) => s.name),
  month: {
    amount: r2(scope.reduce((s, x) => s + Number(x.amount || 0), 0)),
    refund: r2(scope.reduce((s, x) => s + Number(x.return_amount || 0), 0)),
    fee: r2(scope.reduce((s, x) => s + Number(x.fee || 0), 0)),
  },
}, null, 2));
