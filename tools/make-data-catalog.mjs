#!/usr/bin/env node
/**
 * 生成 AGENT 数据目录表（可填写的空表 + 现状标注）
 *
 *   node tools/make-data-catalog.mjs
 *   node tools/make-data-catalog.mjs --out "D:\振颜丽舍\数据目录\AGENT目录表.xlsx"
 *
 * 三张表：
 *   销售端  —— 3 个品牌 × 11 个平台，标注当前是否已接
 *   财务端  —— 旺店通 / 用友 / 借贷金融
 *   口径对照 —— 两张标准表各自需要哪些数据
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipStore } from '../backend/export.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const OUT = arg('--out', 'D:\\振颜丽舍\\数据目录\\AGENT目录表.xlsx');

/* ---------------- 数据 ---------------- */

const BRANDS = ['歌剧', 'PF79', '德国世家'];
const PLATFORMS = ['天猫', '抖音', '小红书', '快手', '视频号', '拼多多', '京东', '达播BD', 'PR', '私域', '分销'];

// 当前已接入情况（按实际进度维护：改这里，重跑即可更新表）
const STATUS = (brand, plat) => {
  if (brand === '歌剧' && ['天猫', '抖音', '小红书', '拼多多'].includes(plat)) return '已接（部分）';
  if (brand === '德国世家' && ['天猫', '小红书'].includes(plat)) return '已接（部分）';
  if (brand === 'PF79' && plat === '天猫') return '已接（数据极少）';
  return '未接入';
};
const SOURCE = (brand, plat) => {
  if (STATUS(brand, plat).startsWith('已接')) return '旺店通导出（销售日统计）';
  return '';
};

const SALES_HEAD = ['品牌', '平台', '平台账号', '账号密码', '日报（每日8点）', '月报（次月1日8点）',
  '季报（次季次月1日8点）', '半年报（次月1日8点）', '年报（次年1月1日8点）',
  '当前状态', '现有数据来源', '缺口/备注'];

const salesRows = [];
for (const b of BRANDS) {
  for (const p of PLATFORMS) {
    const st = STATUS(b, p);
    salesRows.push([
      b, p, '', '', '', '', '', '', '',
      st,
      SOURCE(b, p),
      st === '已接（部分）' ? '仅有销售额/成本，缺访客、转化、收藏加购、退款' : '',
    ]);
  }
}

const FIN_HEAD = ['类别', '数据项', '来源系统', '频率', '当前状态', '说明'];
const finRows = [
  ['旺店通', '快递 / 物流费', '旺店通', '月', '未接入', '导出「发货明细」或物流账单；日报的「邮资」列只含预估'],
  ['旺店通', '仓库物料费用 / 耗材', '旺店通', '月', '未接入', '物料领用单'],
  ['旺店通', '仓内费用', '旺店通', '月', '未接入', '仓储服务费、操作费'],
  ['用友', '订单采进销存退', '用友', '月', '未接入', '进销存台账，用于核成本与库存'],
  ['用友', '现金流量表', '用友', '月/季/年', '未接入', '经营/投资/筹资三类现金流'],
  ['借贷金融', '借款 / 还款 / 利息', '银行 / 借贷平台', '月', '未接入', '利息计入财务费用'],
  ['平台', '平台扣点 / 佣金', '支付宝账单 / 京东月结', '月', '未接入', '日报里「平台费」目前为空'],
  ['平台', '退款金额 / 退款件数', '各平台后台', '日', '未接入', '旺店通导出表没有退款列'],
  ['人力', '工资表 / 社保公积金', '人事', '月', '未接入', '自动生成固定支出凭证'],
];

const MAP_HEAD = ['标准表', '工作表', '需要的底层数据', '当前是否齐备'];
const mapRows = [
  ['① 月对比表-日报汇总（品牌维度）', '总月报表', '各品牌 × 各渠道 月度销售额、退款、件数', '部分（仅 3 品牌 × 5 渠道）'],
  ['① 月对比表-日报汇总（品牌维度）', '歌剧 / PF 月对比表', '品牌内各渠道逐月销售额与增长比', '部分'],
  ['① 月对比表-日报汇总（品牌维度）', '日汇总', '逐日销售额、退款、件数', '部分（缺退款/件数）'],
  ['① 月对比表-日报汇总（品牌维度）', '主打单品分析各渠道', 'SKU 级销量与金额', '未接入（现只有「全店」）'],
  ['② 年度经营报表（渠道维度）', '总月报表', '各渠道月度汇总', '部分'],
  ['② 年度经营报表（渠道维度）', '天猫 / 京东 / 拼多多 月对比表', '渠道内逐月数据与增长比', '部分'],
  ['② 年度经营报表（渠道维度）', '日汇总表', '逐日数据', '部分'],
  ['② 年度经营报表（渠道维度）', '主打单品分析各渠道', 'SKU 级数据', '未接入'],
];

/* ---------------- xlsx 生成 ---------------- */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(head, rows, widths = []) {
  const headCells = head.map((h, i) => `<c r="${colName(i + 1)}1" t="inlineStr" s="1"><is><t>${esc(h)}</t></is></c>`).join('');
  const body = rows.map((row, ri) => {
    const rn = ri + 2;
    const cells = row.map((v, ci) => `<c r="${colName(ci + 1)}${rn}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('');
    return `<row r="${rn}">${cells}</row>`;
  }).join('');
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}
<sheetData><row r="1">${headCells}</row>${body}</sheetData></worksheet>`;
}

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
  { name: '销售端', xml: sheetXml(SALES_HEAD, salesRows, [10, 10, 16, 16, 16, 18, 20, 18, 20, 14, 22, 34]) },
  { name: '财务端', xml: sheetXml(FIN_HEAD, finRows, [12, 24, 22, 10, 12, 46]) },
  { name: '口径对照', xml: sheetXml(MAP_HEAD, mapRows, [30, 26, 40, 26]) },
  { name: '填表说明', xml: sheetXml(['项', '说明'], [
    ['用途', '把「平台账号/账号密码/报表获取时间」补齐后，系统按标准模板自动取数出表'],
    ['日报时间', '各平台后台日报通常在次日 8 点后可取；系统 9:00 汇总'],
    ['状态含义', '已接=旺店通导出已有该品牌该渠道；未接入=需要补数据源'],
    ['密码怎么填', '建议只填「是否已有子账号」，密码另存密码管理器，不要明文放共享表'],
    ['两张标准表', '① 月对比表-日报汇总（品牌维度）② 年度经营报表（渠道维度）'],
  ], [16, 90]) },
];

const sheetOverrides = sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
const sheetEntries = sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
const relEntries = sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');

const files = [
  {
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheetOverrides}</Types>`,
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
<sheets>${sheetEntries}</sheets></workbook>`,
  },
  {
    name: 'xl/_rels/workbook.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relEntries}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  },
  { name: 'xl/styles.xml', data: STYLES },
  ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml })),
];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zipStore(files));
console.log(`已生成：${OUT}`);
console.log(`工作表：${sheets.map((s) => s.name).join(' / ')}`);
console.log(`销售端 ${salesRows.length} 行（${BRANDS.length} 品牌 × ${PLATFORMS.length} 平台）｜财务端 ${finRows.length} 行`);
