#!/usr/bin/env node
/**
 * 月度汇总（品牌 × 渠道）—— 标准表①「月对比表-日报汇总」的底层数据
 *
 *   node tools/monthly-summary.mjs                  # 上个月
 *   node tools/monthly-summary.mjs 2026-11
 *   node tools/monthly-summary.mjs 2026-11 --out "D:\振颜丽舍\报表\月报\2026-11"
 *
 * 输出：xlsx（品牌渠道月汇总 + 数据齐备度）+ 控制台摘要
 * 口径：sales_effective（同日期同渠道 wdt 优先），不重复计入企微旧口径
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { zipStore } from '../backend/export.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const prevMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const positional = argv.find((a) => /^\d{4}-\d{2}$/.test(a));
const PERIOD = arg('--period', positional || prevMonth());
const FROM = arg('--from', PERIOD);
const TO = arg('--to', PERIOD);
const LABEL = arg('--label', FROM === TO ? PERIOD : `${FROM}_${TO}`);
const SPAN = FROM === TO ? FROM : `${FROM} ~ ${TO}`;
const OUTDIR = arg('--out', `D:/振颜丽舍/报表/月报/${LABEL}`);
const DB = process.env.ZD_DB_PATH || path.join(ROOT, 'backend', 'data', 'jinli.db');
const SET = Number(process.env.ZD_SET_ID || 85);

const db = new DatabaseSync(DB);
db.exec('PRAGMA query_only = ON');

const rows = db.prepare(`SELECT COALESCE(brand,'') b, COALESCE(group_name,'') c,
    COUNT(DISTINCT date) days, ROUND(SUM(amount),2) amount, ROUND(SUM(return_amount),2) ret,
    ROUND(SUM(cost),2) cost, ROUND(SUM(fee),2) fee, ROUND(SUM(net_profit),2) net
  FROM sales_effective
  WHERE set_id = ? AND source = 'wdt' AND substr(date,1,7) >= ? AND substr(date,1,7) <= ?
  GROUP BY 1,2 ORDER BY amount DESC`).all(SET, FROM, TO);

const total = rows.reduce((a, r) => ({
  days: Math.max(a.days, r.days), amount: a.amount + r.amount, ret: a.ret + r.ret,
  cost: a.cost + r.cost, fee: a.fee + r.fee, net: a.net + r.net,
}), { days: 0, amount: 0, ret: 0, cost: 0, fee: 0, net: 0 });

const money = (n) => Number(n || 0).toFixed(2);
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function sheet(head, data, widths = []) {
  const h = head.map((x, i) => `<c r="${col(i + 1)}1" t="inlineStr" s="1"><is><t>${esc(x)}</t></is></c>`).join('');
  const body = data.map((row, ri) => {
    const rn = ri + 2;
    return `<row r="${rn}">${row.map((v, ci) => (typeof v === 'number'
      ? `<c r="${col(ci + 1)}${rn}"><v>${v}</v></c>`
      : `<c r="${col(ci + 1)}${rn}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('')}</row>`;
  }).join('');
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}
<sheetData><row r="1">${h}</row>${body}</sheetData></worksheet>`;
}

const HEAD = ['品牌', '渠道', '有数据天数', '销售额', '退款', '净销售', '营业成本', '平台费', '净利润', '净利率', '成本率', '齐备度'];
const data = rows.map((r) => [
  r.b || '(未标品牌)', r.c || '(未分渠道)', r.days, r.amount, r.ret, r.amount - r.ret,
  r.cost, r.fee, r.net, pct(r.net, r.amount - r.ret), pct(r.cost, r.amount),
  r.ret > 0 ? '含退款' : '缺退款',
]);
data.push(['合计', '', total.days, total.amount, total.ret, total.amount - total.ret,
  total.cost, total.fee, total.net, pct(total.net, total.amount - total.ret),
  pct(total.cost, total.amount), '']);

const NOTES = [
  ['期间', SPAN],
  ['数据来源', '旺店通导出（sales_effective，同日期同渠道 wdt 优先）'],
  ['缺项', '退款/件数/平台费：旺店通「销售日统计」无这些列，需另导退货单与平台账单'],
  ['标准表', '本表是「月对比表-日报汇总」的底层汇总；单品维度需订单明细（含 SKU）'],
  ['生成时间', new Date().toLocaleString('zh-CN')],
];

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="宋体"/></font><font><b/><sz val="11"/><name val="宋体"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8F1EC"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`;

const sheets = [
  { name: '品牌渠道月汇总', xml: sheet(HEAD, data, [14, 12, 12, 14, 12, 14, 14, 12, 14, 10, 10, 12]) },
  { name: '说明', xml: sheet(['项', '内容'], NOTES, [12, 80]) },
];

const files = [
  {
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
  },
  {
    name: '_rels/.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  },
  {
    name: 'xl/workbook.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="品牌渠道月汇总" sheetId="1" r:id="rId1"/><sheet name="说明" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  },
  {
    name: 'xl/_rels/workbook.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  },
  { name: 'xl/styles.xml', data: STYLES },
  { name: 'xl/worksheets/sheet1.xml', data: sheets[0].xml },
  { name: 'xl/worksheets/sheet2.xml', data: sheets[1].xml },
];

fs.mkdirSync(OUTDIR, { recursive: true });
const out = path.join(OUTDIR, `品牌渠道汇总-${LABEL}.xlsx`);
fs.writeFileSync(out, zipStore(files));

console.log(`期间 ${SPAN}｜${rows.length} 个品牌×渠道组合｜合计销售 ${money(total.amount)}｜净利 ${money(total.net)}`);
console.log(`输出：${out}`);
