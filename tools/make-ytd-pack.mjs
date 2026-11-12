/**
 * 生成「年初至今 / 指定截止月」的财务报表 Excel 合集。
 * 工作表：资产负债表 / 利润表 / 现金流量表 / 月度汇总 / 说明
 *
 * 用法：node tools/make-ytd-pack.mjs [year] [setId] [outDir] [endMonth]
 *   endMonth：1-12，缺省取当年当前月。做前三季度就传 9。
 *   也支持 --end=2026-09 写法。
 * 默认：当年、账套 85、输出到 exports/
 *
 * 数据全部来自后端报表引擎（backend/reports.mjs），与界面、导出中心同源；
 * 本脚本只读库，不写任何业务数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { reportTable, zipStore } from '../backend/export.mjs';

const argv = process.argv.slice(2);
const endFlag = argv.find((a) => a.startsWith('--end='));
const pos = argv.filter((a) => !a.startsWith('--'));

const YEAR = Number(endFlag ? endFlag.slice(6, 10) : (pos[0] || new Date().getFullYear()));
const SET_ID = Number(pos[1] || 85);
const OUT_DIR = pos[2] || path.resolve(process.cwd(), 'exports');

const now = new Date();
const endMonthArg = endFlag ? Number(endFlag.slice(11, 13)) : Number(pos[3] || 0);
const lastMonth = endMonthArg >= 1 && endMonthArg <= 12
  ? endMonthArg
  : (now.getFullYear() === YEAR ? now.getMonth() + 1 : 12);
const PERIODS = Array.from({ length: lastMonth }, (_, i) => `${YEAR}-${String(i + 1).padStart(2, '0')}`);
const END_PERIOD = PERIODS[PERIODS.length - 1];

const xmlEsc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const colName = (i) => {
  let s = '';
  let n = i + 1;
  while (n > 0) { n -= 1; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
};

/** 单表 XML：第 1 行标题、第 2 行表头、第 3 行起数据；数值列套两位小数格式（s=1） */
function sheetXml(table) {
  const rows = [`<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(table.title)}</t></is></c></row>`];
  rows.push(`<row r="2">${table.columns.map((c, i) => (
    `<c r="${colName(i)}2" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.label)}</t></is></c>`
  )).join('')}</row>`);
  table.rows.forEach((r, ri) => {
    const n = ri + 3;
    rows.push(`<row r="${n}">${table.columns.map((c, i) => {
      const ref = `${colName(i)}${n}`;
      const v = r[c.key];
      if (c.type === 'number') return `<c r="${ref}" s="1"><v>${round2(v)}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join('')}</row>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="等线"/><family val="2"/><scheme val="minor"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function buildWorkbook(sheets) {
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
  ];
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml }));
  return zipStore(files);
}

/* ---------- 取数 ---------- */

const balance = reportTable({ kind: 'balance', period: END_PERIOD, setId: SET_ID }).table;

const income = reportTable({ kind: 'income', period: END_PERIOD, setId: SET_ID }).table;
const incomeYtd = {
  title: `利润表（${YEAR} 年 1-${lastMonth} 月）`,
  columns: [
    { key: 'item', label: '项目', type: 'text' },
    { key: 'current', label: `本月（${lastMonth} 月）`, type: 'number' },
    { key: 'ytd', label: `本年累计（1-${lastMonth} 月）`, type: 'number' },
  ],
  rows: income.rows,
};

const cash = reportTable({ kind: 'cash', period: END_PERIOD, setId: SET_ID }).table;
const cashYtd = {
  title: `现金流量表（${YEAR} 年 1-${lastMonth} 月）`,
  columns: [
    { key: 'item', label: '项目', type: 'text' },
    { key: 'current', label: `本月（${lastMonth} 月）`, type: 'number' },
    { key: 'ytd', label: `本年累计（1-${lastMonth} 月）`, type: 'number' },
  ],
  rows: cash.rows,
};

/** 月度汇总：逐月取经营概览的六项指标 */
const METRICS = ['营业收入', '成本', '费用', '利润', '税金', '净利率'];
const monthlyRows = PERIODS.map((p) => {
  const t = reportTable({ kind: 'dashboard', period: p, setId: SET_ID }).table;
  const map = new Map(t.rows.map((r) => [r.item, Number(r.value) || 0]));
  const row = { month: `${Number(p.slice(5, 7))} 月` };
  for (const m of METRICS) row[m] = map.get(m) ?? 0;
  return row;
});
const total = { month: '合计' };
for (const m of METRICS) {
  if (m === '净利率') {
    const rev = monthlyRows.reduce((s, r) => s + r['营业收入'], 0);
    const profit = monthlyRows.reduce((s, r) => s + r['利润'], 0);
    total[m] = rev ? round2((profit / rev) * 100) : 0;
  } else {
    total[m] = monthlyRows.reduce((s, r) => s + r[m], 0);
  }
}

const monthly = {
  title: `${YEAR} 年月度经营汇总（金额单位：元，净利率单位：%）`,
  columns: [
    { key: 'month', label: '月份', type: 'text' },
    { key: '营业收入', label: '营业收入', type: 'number' },
    { key: '成本', label: '成本', type: 'number' },
    { key: '费用', label: '费用', type: 'number' },
    { key: '利润', label: '利润', type: 'number' },
    { key: '税金', label: '税金', type: 'number' },
    { key: '净利率', label: '净利率(%)', type: 'number' },
  ],
  rows: [...monthlyRows, total],
};

const voucherCount = (() => {
  try {
    const t = reportTable({ kind: 'vouchers', period: '', setId: SET_ID }).table;
    return t.rows.length;
  } catch { return null; }
})();

const info = {
  title: `年初至今财务报表 · 说明（${YEAR} 年 1-${lastMonth} 月）`,
  columns: [
    { key: 'k', label: '项目', type: 'text' },
    { key: 'v', label: '内容', type: 'text' },
  ],
  rows: [
    { k: '账套', v: `${SET_ID} · 振颜丽舍` },
    { k: '报表口径期间', v: `${YEAR}-01 ~ ${END_PERIOD}（共 ${lastMonth} 个月）` },
    { k: '生成时间', v: now.toLocaleString('zh-CN', { hour12: false }) },
    { k: '数据来源', v: '本地后端报表引擎（与界面、导出中心同源）' },
    { k: '资产负债表', v: '左列为期末余额（截至 ' + END_PERIOD + '），右列为年初余额（' + YEAR + '-01-01）' },
    { k: '利润表 / 现金流量表', v: '本期列为当月发生额，本年累计列为 1 月至当月的累计数' },
    { k: '月度汇总', v: '逐月营业收入、成本、费用、利润、税金与净利率，末行为合计' },
    { k: '凭证总数', v: voucherCount == null ? '（未取到）' : `${voucherCount} 张（全期间）` },
  ],
};

const sheets = [
  { name: '资产负债表', xml: sheetXml(balance) },
  { name: '利润表', xml: sheetXml(incomeYtd) },
  { name: '现金流量表', xml: sheetXml(cashYtd) },
  { name: '月度汇总', xml: sheetXml(monthly) },
  { name: '说明', xml: sheetXml(info) },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
const label = lastMonth === 3 ? `${YEAR}年一季度` : lastMonth === 6 ? `${YEAR}年上半年` : lastMonth === 9 ? `${YEAR}年前三季度` : `${YEAR}年1-${lastMonth}月`;
const out = path.join(OUT_DIR, `财务报表_${label}_账套${SET_ID}.xlsx`);
fs.writeFileSync(out, buildWorkbook(sheets));

console.log(JSON.stringify({
  file: out,
  bytes: fs.statSync(out).size,
  period: `${YEAR}-01 ~ ${END_PERIOD}`,
  label,
  sheets: sheets.map((s) => s.name),
  rows: { balance: balance.rows.length, income: incomeYtd.rows.length, cash: cashYtd.rows.length, monthly: monthly.rows.length },
}, null, 2));
