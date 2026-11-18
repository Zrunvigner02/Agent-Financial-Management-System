#!/usr/bin/env node
/**
 * 按样板锁死格式生成销售报表（口径隔离，默认 platform）。
 *
 *   node tools/make-sales-report.mjs [period] [--source=platform|wecom|sales_dept|wdt]
 *
 * 版式标准：rules/report-template/标准样板_月对比表-日报汇总26年11月7日.xlsx
 *   —— 字体、边框、填充、列宽、合并、表头层级全部直接复用样板自带的 styles.xml 与 theme1.xml，
 *      不再自造样式；只有数值单元格追加了数字格式（样板是空模板，本身没有数值格式）。
 *
 * 表结构（照样板 7 张，世家按同样式追加 3 张）：
 *   1 总月报表{年}年{月}月   2 歌剧月对比表   3 歌剧日汇总   4 歌剧主打单品分析各渠道
 *   5 PF月对比表            6 PF 日汇总表   7 PF主打单品渠道分析表
 *   8 世家月对比表          9 世家日汇总  10 世家主打单品分析
 */
import fs from 'node:fs';
import path from 'node:path';
import { all } from '../backend/store.mjs';
import { zipStore, unzipEntries } from '../backend/export.mjs';

const SET = 85;
const ARGS = process.argv.slice(2);
const argVal = (n, d = '') => {
  const hit = ARGS.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SOURCE = argVal('source', 'platform');
const SOURCE_LABEL = { platform: '平台口径', wecom: '企微缓存口径', sales_dept: '销售部口径', wdt: '旺店通口径' }[SOURCE] || SOURCE;
const PERIOD = ARGS.find((a) => !a.startsWith('--')) || argVal('period', '2026-11');
const YEAR = PERIOD.slice(0, 4);
const MONTH = Number(PERIOD.slice(5, 7));
const OUT_DIR = path.resolve('exports');
const TEMPLATE = path.resolve('rules/report-template/标准样板_月对比表-日报汇总26年11月7日.xlsx');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/* ---------- 数据 ---------- */
const rows = all(`SELECT d.*, c.name AS channel, c.platform,
    substr(d.date,1,7) AS period, substr(d.date,1,4) AS yr, cast(substr(d.date,6,2) as integer) AS mo
  FROM sales_daily d JOIN sales_channels c ON c.id = d.channel_id
  WHERE d.set_id = ? AND d.source = ?`, SET, SOURCE);

const BRAND = (channel) => {
  if (/歌剧/.test(channel)) return '歌剧';
  if (/PF|pf79/i.test(channel)) return 'PF';
  if (/DH|drhauschka|德国世家|世家/i.test(channel)) return '世家';
  return '其他';
};
/** 日汇总/单品分析按「渠道大类」归并（京东自营+京东POP 合成京东，与样板一致） */
const BIG = (channel) => {
  if (/天猫/.test(channel)) return '天猫';
  if (/抖音/.test(channel)) return '抖音';
  if (/小红书/.test(channel)) return '小红书';
  if (/京东/.test(channel)) return '京东';
  if (/拼多多/.test(channel)) return '拼多多';
  if (/分销/.test(channel)) return '分销';
  return channel;
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
const KNOWN = ['歌剧', 'PF', '世家'];
const detected = [...new Set(rows.map((r) => BRAND(r.channel)))].filter((b) => b && b !== '其他');
const BRANDS = [...KNOWN, ...detected.filter((b) => !KNOWN.includes(b)).sort()];

const daysInMonth = new Date(Number(YEAR), MONTH, 0).getDate();
const dayAgg = new Map();   // `${brand}|${day}|${bigChannel}`
for (const r of rows) {
  if (r.period !== PERIOD) continue;
  const k = `${BRAND(r.channel)}|${Number(r.date.slice(8, 10))}|${BIG(r.channel)}`;
  const a = dayAgg.get(k) || { qty: 0, amount: 0, refund: 0, fee: 0 };
  a.qty += Number(r.qty || 0);
  a.amount += Number(r.amount || 0);
  a.refund += Number(r.return_amount || 0);
  a.fee += Number(r.fee || 0);
  dayAgg.set(k, a);
}
const CHANNELS = ['天猫', '抖音', '小红书', '京东', '拼多多', '分销'];
const channelsWithData = (b) => CHANNELS.filter((ch) => [...dayAgg.keys()].some((k) => k.startsWith(`${b}|`) && k.endsWith(`|${ch}`)));

/* ---------- 样板样式（直接复用） ---------- */
function templateAssets() {
  if (!fs.existsSync(TEMPLATE)) throw new Error(`找不到版式样板：${TEMPLATE}`);
  const files = unzipEntries(fs.readFileSync(TEMPLATE));
  const styles = files['xl/styles.xml']?.toString('utf8') || '';
  const theme = files['xl/theme/theme1.xml']?.toString('utf8') || '';
  if (!styles) throw new Error('样板缺少 styles.xml');
  return { styles, theme };
}

/** 在样板 styles.xml 上追加数字格式与数值样式，返回 { xml, S } */
function buildStyles(base) {
  const EXTRA_FMT = '<numFmt numFmtId="164" formatCode="#,##0.00"/>'
    + '<numFmt numFmtId="165" formatCode="0.0%"/>'
    + '<numFmt numFmtId="166" formatCode="#,##0"/>';
  let xml = base;
  if (/<numFmts count="(\d+)">/.test(xml)) {
    xml = xml.replace(/<numFmts count="(\d+)">/, (m, c) => `<numFmts count="${Number(c) + 3}">${EXTRA_FMT}`);
  } else {
    xml = xml.replace('<fonts ', `<numFmts count="3">${EXTRA_FMT}</numFmts><fonts `);
  }

  const BORD = 4;      // 样板：四边细边框
  const F_SUB = 2;     // 样板：小计底色（theme6 tint .8）
  const F_TOT = 4;     // 样板：总计底色（theme0）
  const FONT_B = 14;   // 样板：加粗 11
  const add = [];
  const push = (numFmt, fontId, fillId, align = 'right') => {
    add.push(`<xf numFmtId="${numFmt}" fontId="${fontId}" fillId="${fillId}" borderId="${BORD}" xfId="0"`
      + `${numFmt ? ' applyNumberFormat="1"' : ''} applyBorder="1"${fillId ? ' applyFill="1"' : ''}`
      + ` applyAlignment="1"><alignment horizontal="${align}" vertical="center"/></xf>`);
    return 19 + add.length;   // 样板 cellXfs 已有 0..19
  };

  const S = {
    TITLE_TOTAL: 13, TITLE_BRAND: 9, TITLE_DAILY: 5, TITLE_SKU: 1,
    GROUP: 5, HEAD: 4, MONTH: 4, SUB_LABEL: 7, TOT_LABEL: 19,
    AMT: push(164, 0, 0),
    PCT: push(165, 0, 0),
    INT: push(166, 0, 0),
    SUB_AMT: push(164, FONT_B, F_SUB),
    SUB_PCT: push(165, FONT_B, F_SUB),
    SUB_INT: push(166, FONT_B, F_SUB),
    TOT_AMT: push(164, FONT_B, F_TOT),
    TOT_PCT: push(165, FONT_B, F_TOT),
    TOT_INT: push(166, FONT_B, F_TOT),
  };

  xml = xml.replace('</cellXfs>', `${add.join('')}</cellXfs>`);
  xml = xml.replace(/<cellXfs count="(\d+)">/, (m, c) => `<cellXfs count="${Number(c) + add.length}">`);
  return { xml, S };
}

const { styles: BASE_STYLES, theme: THEME } = templateAssets();
const { xml: STYLES, S } = buildStyles(BASE_STYLES);

/* ---------- 单元格 ---------- */
const T = (v, s) => (v === '' || v == null ? '' : { v: String(v), s });
const M = (v, s) => (v === '' || v == null ? '' : { v: r2(v), s, n: true });
const PC = (v, s) => (v === '' || v == null || !Number.isFinite(Number(v)) ? '' : { v: Number(v), s, n: true });
const growth = (cur, prev) => (prev ? Math.round((cur / prev - 1) * 10000) / 10000 : '');

/** 某品牌某月的 12 个指标（C..N；O 总结留空） */
function monthCells(brand, mo, st) {
  const a = monthAgg.get(`${brand}|${mo}`);
  const prev = monthAgg.get(`${brand}|${mo - 1}`);
  if (!a) return Array(12).fill('');
  const net = a.amount - a.refund;
  const profit = net - a.fee;
  return [
    M(a.qty || '', st.INT), prev ? PC(growth(a.qty, prev.qty), st.PCT) : '',
    M(a.amount, st.AMT), prev ? PC(growth(a.amount, prev.amount), st.PCT) : '',
    M(a.refundQty || '', st.INT), prev ? PC(growth(a.refundQty, prev.refundQty), st.PCT) : '',
    M(a.refund, st.AMT), prev ? PC(growth(a.refund, prev.refund), st.PCT) : '',
    '', '',
    M(profit, st.AMT), PC(a.amount ? profit / a.amount : '', st.PCT),
  ];
}

function sumBrand(year, brand) {
  const acc = { qty: 0, amount: 0, refundQty: 0, refund: 0, fee: 0 };
  for (let m = 1; m <= 12; m += 1) {
    const a = monthAgg.get(`${brand}|${m}`);
    if (!a) continue;
    acc.qty += a.qty; acc.amount += a.amount; acc.refundQty += a.refundQty;
    acc.refund += a.refund; acc.fee += a.fee;
  }
  return acc;
}

/* ---------- 各表 ---------- */
/** 总月报表：3 品牌块（1..11 月 + 小计）+ 总计，与样板行列位置一致 */
function sheetTotal() {
  const list = [];
  const merges = ['A1:O1', 'C2:D2', 'E2:F2', 'G2:H2', 'I2:J2', 'A2:A16'];
  const ST = { ...S };

  // 行1 标题
  list.push([T('总月对比表', S.TITLE_TOTAL)]);
  // 行2-3 表头（属于第一个品牌块，与样板一致）
  list.push([T('歌剧', 14), '', T('销售数量', S.GROUP), '', T('销售额', S.GROUP), '',
    T('退货', S.GROUP), '', T('退货金额', S.GROUP), '', '', '', '', '', '']);
  list.push(['', '',
    T('销售数量', S.HEAD), T('增长比', S.HEAD), T('销售额', S.HEAD), T('增长比', S.HEAD),
    T('退货数量', S.HEAD), T('增长比', S.HEAD), T('退货金额', S.HEAD), T('增长比', S.HEAD),
    T('毛利润', S.HEAD), T('毛利率', S.HEAD), T('销售净利额', S.HEAD), T('销售净利率', S.HEAD), T('总结', S.HEAD)]);

  // 1..12 月：12 月照列（未到月份数据留空，不填 0）
  for (let m = 1; m <= 12; m += 1) {
    const line = ['', T(`${m}月`, S.MONTH), ...monthCells('歌剧', m, ST), ''];
    list.push(line);
  }
  list.push(['', T('小计', S.SUB_LABEL), ...subCells('歌剧', ST), '']);

  for (const brand of BRANDS.filter((b) => b !== '歌剧')) {
    const startRow = list.length + 1;
    for (let m = 1; m <= 12; m += 1) {
      const line = [m === 1 ? T(brand, 14) : '', T(`${m}月`, S.MONTH), ...monthCells(brand, m, ST), ''];
      list.push(line);
    }
    list.push(['', T('小计', S.SUB_LABEL), ...subCells(brand, ST), '']);
    merges.push(`A${startRow}:A${startRow + 12}`);
  }

  // 总计
  const tot = { qty: 0, amount: 0, refundQty: 0, refund: 0, fee: 0 };
  for (const b of BRANDS) {
    const a = sumBrand(YEAR, b);
    tot.qty += a.qty; tot.amount += a.amount; tot.refundQty += a.refundQty;
    tot.refund += a.refund; tot.fee += a.fee;
  }
  const profit = tot.amount - tot.refund - tot.fee;
  list.push([T('总计', S.TOT_LABEL), '',
    M(tot.qty || '', S.TOT_INT), '', M(tot.amount, S.TOT_AMT), '', M(tot.refundQty || '', S.TOT_INT), '',
    M(tot.refund, S.TOT_AMT), '', '', '', M(profit, S.TOT_AMT), PC(tot.amount ? profit / tot.amount : '', S.TOT_PCT), '']);

  const widths = Array(15).fill(8.43);
  widths[12] = 11.8; widths[13] = 11.8;
  return { name: `总月报表${YEAR}年${MONTH}月`, rows: list, merges, widths };
}

/** 品牌月对比表：12 个月 + 总计（与样板 sheet2 一致） */
function sheetBrand(brand) {
  const list = [];
  const merges = ['A1:N1', 'B2:C2', 'D2:E2', 'F2:G2', 'H2:I2'];
  const ST = { ...S };
  list.push([T(`${brand}月对比表`, S.TITLE_BRAND)]);
  list.push(['', T('销售数量', S.GROUP), '', T('销售额', S.GROUP), '', T('退货', S.GROUP), '',
    T('退货金额', S.GROUP), '', '', '', '', '', '']);
  list.push(['', T('销售数量', S.HEAD), T('增长比', S.HEAD), T('销售额', S.HEAD), T('增长比', S.HEAD),
    T('退货数量', S.HEAD), T('增长比', S.HEAD), T('退货金额', S.HEAD), T('增长比', S.HEAD),
    T('毛利润', S.HEAD), T('毛利率', S.HEAD), T('销售净利额', S.HEAD), T('销售净利率', S.HEAD), T('总结', S.HEAD)]);
  for (let m = 1; m <= 12; m += 1) list.push([T(`${m}月`, S.MONTH), ...monthCells(brand, m, ST), '']);
  list.push([T('总计', S.HEAD), ...subCells(brand, ST), '']);
  const widths = Array(14).fill(8.43);
  widths[11] = 11.8; widths[12] = 11.8;
  return { name: `${brand}月对比表`, rows: list, merges, widths };
}

function subCells(brand, st) {
  if (!brandHasData(brand)) return Array(12).fill('');
  const a = sumBrand(YEAR, brand);
  const net = a.amount - a.refund;
  const profit = net - a.fee;
  return [
    M(a.qty || '', st.SUB_INT), '',
    M(a.amount, st.SUB_AMT), '',
    M(a.refundQty || '', st.SUB_INT), '',
    M(a.refund, st.SUB_AMT), '',
    '', '',
    M(profit, st.SUB_AMT), PC(a.amount ? profit / a.amount : '', st.SUB_PCT),
  ];
}

/** 品牌日汇总：渠道 × 当月每天（销售数量/销售额/费比/毛利率） */
function sheetDaily(brand) {
  const chs = channelsWithData(brand);
  const rowsOut = [];
  const merges = [];
  const days = daysInMonth;

  const title = ['日汇总表'];
  for (let i = 1; i < days * 4 + 1; i += 1) title.push('');
  rowsOut.push([T('日汇总表', S.TITLE_DAILY), ...Array(days * 4).fill('')]);
  merges.push(`A1:${colName(days * 4)}1`);

  const dayLine = ['', ...Array(days * 4).fill('')];
  const subLine = [''];
  for (let d = 1; d <= days; d += 1) {
    dayLine[(d - 1) * 4 + 1] = T(`${d}日`, S.GROUP);
    merges.push(`${colName((d - 1) * 4 + 1)}2:${colName((d - 1) * 4 + 4)}2`);
    subLine.push(T('销售数量', S.HEAD), T('销售额', S.HEAD), T('费比', S.HEAD), T('毛利率', S.HEAD));
  }
  rowsOut.push(dayLine);
  rowsOut.push(subLine);

  const tot = { qty: 0, amount: 0, refund: 0, fee: 0 };
  for (const ch of chs) {
    const line = [T(ch, S.MONTH)];
    for (let d = 1; d <= days; d += 1) {
      const a = dayAgg.get(`${brand}|${d}|${ch}`);
      if (!a) { line.push('', '', '', ''); continue; }
      tot.qty += a.qty; tot.amount += a.amount; tot.refund += a.refund; tot.fee += a.fee;
      line.push(
        M(a.qty || '', S.INT),
        M(a.amount, S.AMT),
        PC(a.amount ? a.fee / a.amount : '', S.PCT),
        ' ',
      );
    }
    rowsOut.push(line);
  }
  const totLine = [T('总计', S.HEAD)];
  for (let d = 1; d <= days; d += 1) {
    let q = 0, amt = 0, fee = 0;
    for (const ch of chs) {
      const a = dayAgg.get(`${brand}|${d}|${ch}`);
      if (a) { q += a.qty; amt += a.amount; fee += a.fee; }
    }
    totLine.push(M(q || '', S.SUB_INT), M(amt, S.SUB_AMT), PC(amt ? fee / amt : '', S.SUB_PCT), ' ');
  }
  rowsOut.push(totLine);

  const widths = Array(days * 4 + 1).fill(8.43);
  for (let d = 0; d < days; d += 1) widths[(d * 4) + 2] = 8.7;
  return { name: `${brand}日汇总`, rows: rowsOut, merges, widths };
}

/** 品牌主打单品分析：样板结构（每天 3 列：销售数量/销售额/毛利率）。当前无 SKU 明细，只出表头与总计 */
function sheetSku(brand) {
  const days = daysInMonth;
  const merges = [`A1:${colName(days * 3)}1`];
  const rowsOut = [[T(`${brand}主打单品分析各渠道`, S.TITLE_SKU), ...Array(days * 3).fill('')]];
  const dayLine = ['', ...Array(days * 3).fill('')];
  const subLine = [T('主打品/增长品', S.HEAD)];
  for (let d = 1; d <= days; d += 1) {
    dayLine[d * 3 - 2] = T(`${d}日`, S.GROUP);
    merges.push(`${colName(d * 3 - 2)}2:${colName(d * 3)}2`);
    subLine.push(T('销售数量', S.HEAD), T('销售额', S.HEAD), T('毛利率', S.HEAD));
  }
  rowsOut.push(dayLine, subLine);
  rowsOut.push([T('（单品明细待接入旺店通后填充）', S.MONTH)]);
  rowsOut.push([T('总计', S.HEAD)]);
  const widths = Array(days * 3 + 1).fill(8.43);
  widths[0] = 11.8;
  return { name: `${brand}主打单品分析`, rows: rowsOut, merges, widths };
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
        const st = cell.s ?? S.HEAD;
        if (cell.n) return `<c r="${ref}" s="${st}"><v>${Math.round(Number(cell.v) * 10000) / 10000}</v></c>`;
        if (cell.v === ' ') return `<c r="${ref}" s="${st}"/>`;
        return `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
      }
      return `<c r="${ref}" s="${S.HEAD}" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`;
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

function buildWorkbook(list) {
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${list.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
  ];
  if (THEME) files.push({ name: 'xl/theme/theme1.xml', data: THEME });
  list.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
  return zipStore(files);
}

const sheets = [
  sheetTotal(),
  sheetBrand('歌剧'), sheetDaily('歌剧'), sheetSku('歌剧'),
  sheetBrand('PF'), sheetDaily('PF'), sheetSku('PF'),
  ...(brandHasData('世家') ? [sheetBrand('世家'), sheetDaily('世家'), sheetSku('世家')] : []),
];

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `销售报表_${PERIOD}_${SOURCE_LABEL}.xlsx`);
fs.writeFileSync(out, buildWorkbook(sheets));

const scope = rows.filter((x) => x.period === PERIOD);
console.log(JSON.stringify({
  file: out,
  bytes: fs.statSync(out).size,
  period: PERIOD,
  sheets: sheets.map((s) => s.name),
  month: {
    amount: r2(scope.reduce((s, x) => s + Number(x.amount || 0), 0)),
    refund: r2(scope.reduce((s, x) => s + Number(x.return_amount || 0), 0)),
    fee: r2(scope.reduce((s, x) => s + Number(x.fee || 0), 0)),
  },
}, null, 2));
