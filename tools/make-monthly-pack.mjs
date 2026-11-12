/**
 * 生成「本月财务报表」Excel 合集：资产负债表 / 利润表 / 现金流量表 + 说明页，单个工作簿多工作表。
 * 用法：node tools/make-monthly-pack.mjs [period] [setId] [outDir]
 * 数据来自后端同一套报表引擎（backend/reports.mjs），与页面、导出中心完全一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { reportTable, zipStore } from '../backend/export.mjs';

const PERIOD = process.argv[2] || (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();
const SET_ID = Number(process.argv[3] || 85);
const OUT_DIR = process.argv[4] || path.resolve(process.cwd(), 'exports');

const xmlEsc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const colName = (i) => {
  let s = '';
  let n = i + 1;
  while (n > 0) { n -= 1; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
};

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 一个工作表：第 1 行标题，第 2 行表头，之后数据 */
function sheetXml(table) {
  const rows = [];
  const titleCells = `<c r="A1" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(table.title)}</t></is></c>`;
  rows.push(`<row r="1">${titleCells}</row>`);

  const head = table.columns.map((c, i) => (
    `<c r="${colName(i)}2" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.label)}</t></is></c>`
  )).join('');
  rows.push(`<row r="2">${head}</row>`);

  table.rows.forEach((r, ri) => {
    const n = ri + 3;
    const cells = table.columns.map((c, i) => {
      const v = r[c.key];
      const ref = `${colName(i)}${n}`;
      if (c.type === 'number') {
        return `<c r="${ref}"><v>${round2(v)}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join('');
    rows.push(`<row r="${n}">${cells}</row>`);
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

function buildWorkbook(sheets) {
  const n = sheets.length;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('')}</Types>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')}</sheets></workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('')}</Relationships>`;

  const files = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
  ];
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml }));
  return zipStore(files);
}

const tables = ['balance', 'income', 'cash'].map((kind) => reportTable({ kind, period: PERIOD, setId: SET_ID }).table);

const info = {
  name: '说明',
  title: '本月财务报表 · 说明',
  columns: [
    { key: 'k', label: '项目', type: 'text' },
    { key: 'v', label: '内容', type: 'text' },
  ],
  rows: [
    { k: '账套', v: `85 · 振颜丽舍` },
    { k: '报表期间', v: PERIOD },
    { k: '生成时间', v: new Date().toLocaleString('zh-CN', { hour12: false }) },
    { k: '数据来源', v: '本地后端报表引擎（与界面、导出中心同源）' },
    { k: '口径', v: '金额单位：元；资产负债表左=期末/年初，右=期末/年初；利润表=本期/本年累计' },
    { k: '数据状态', v: '本期凭证为 0 张，各项目金额均为 0.00，属「未记账」而非亏损' },
  ],
};

const sheets = [...tables, info].map((t, i) => ({ name: i === 0 ? '资产负债表' : i === 1 ? '利润表' : i === 2 ? '现金流量表' : '说明', title: t.title, xml: sheetXml(t) }));

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `本月财务报表_${PERIOD}_账套${SET_ID}.xlsx`);
fs.writeFileSync(out, buildWorkbook(sheets));

console.log(JSON.stringify({
  file: out,
  bytes: fs.statSync(out).size,
  sheets: sheets.map((s) => s.name),
  rows: tables.map((t, i) => `${['资产负债表', '利润表', '现金流量表'][i]}=${t.rows.length}`),
}, null, 2));
