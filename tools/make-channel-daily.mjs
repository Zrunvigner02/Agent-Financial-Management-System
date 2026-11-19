#!/usr/bin/env node
/**
 * make-channel-daily —— 生成「渠道每日经营数据」日报（照抄天猫 drhauschka 模板）
 *
 * 模板来源：天猫-drhauschka日报_2026-11-18.xlsx
 *   Sheet1「每日经营数据」：标题行(A1:AC1) + 口径行(A2:AC2) + 29 列表头 + 数据行 + 合计/均值行
 *   Sheet2「口径说明」：指标 | 口径说明
 *
 * 用法：
 *   node tools/make-channel-daily.mjs --channel 拼多多 --date 2026-11-19 --empty
 *   node tools/make-channel-daily.mjs --channel 天猫 --from 2026-11-01 --to 2026-11-19
 *   node tools/make-channel-daily.mjs --channel 京东 --date 2026-11-19 --out "D:/x.xlsx"
 *
 * 数据来源：本地 sales_daily（按 group_name = 渠道 + 日期区间）
 * 缺的栏目一律留空并在「口径说明」标注待接入——栏目一个不少。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { zipStore } from '../backend/export.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.ZD_DB_PATH ? path.resolve(process.env.ZD_DB_PATH) : path.join(ROOT, 'backend', 'data', 'jinli.db');
const SET_ID = Number(process.env.ZD_SET_ID || 85);

/** sales_daily 是否已有 brand 列（老库没有，导入旺店通后会补上） */
function detectBrandColumn() {
  try {
    const d = new DatabaseSync(DB_PATH);
    d.exec('PRAGMA query_only = ON');
    const has = d.prepare('PRAGMA table_info(sales_daily)').all().some((c) => c.name === 'brand');
    d.close();
    return has;
  } catch { return false; }
}
const HAS_BRAND = detectBrandColumn();

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const RAW_CHANNEL = arg('channel', '拼多多');
// 支持合并：--channel "淘宝,京东" / "淘宝+京东"
const CHANNELS = RAW_CHANNEL.split(/[,，+＋\/|]/).map((x) => x.trim()).filter(Boolean);
const CHANNEL = CHANNELS.join('+');
const MERGED = CHANNELS.length > 1;
const DATE = arg('date', new Date().toLocaleDateString('sv-SE'));
const FROM = arg('from', '');
const TO = arg('to', DATE);
const EMPTY = flag('empty');
const RAW_BRAND = arg('brand', 'drhauschka');
const SHOP = arg('shop', '');
const OUT = arg('out', '');
const SOURCE = arg('source', '');   // wdt = 旺店通导出

/* ---------------- 品牌档案（旺店通两条货源线） ---------------- */
const BRAND_PROFILES = {
  drhauschka: {
    code: 'drhauschka', name: '德国世家', origin: '跨境进口',
    alias: ['德国世家', '世家', 'dr.hauschka', 'dh', '德世'],
  },
  PF79: {
    code: 'PF79', name: 'PF79', origin: '跨境进口',
    alias: ['pf79', 'pf-79', 'pf'],
  },
  歌剧魅影: {
    code: '歌剧魅影', name: '歌剧魅影', origin: '国内生产',
    alias: ['opera', 'opera魅影', '魅影', 'opera phantom'],
  },
};

function resolveBrand(raw) {
  const k = String(raw || '').trim();
  if (BRAND_PROFILES[k]) return BRAND_PROFILES[k];
  const low = k.toLowerCase();
  for (const p of Object.values(BRAND_PROFILES)) {
    if (p.name.toLowerCase() === low || p.code.toLowerCase() === low) return p;
    if (p.alias.some((a) => a.toLowerCase() === low)) return p;
  }
  return { code: k, name: k, origin: '', alias: [] };
}

const BRAND_PROFILE = resolveBrand(RAW_BRAND);
const BRAND = BRAND_PROFILE.code;
const BRAND_NAME = BRAND_PROFILE.name;

/* ---------------- 渠道档案 ---------------- */
const PROFILES = {
  天猫: {
    suffix: '海外旗舰店（天猫）',
    source: '数据来源：生意参谋（真实浏览器读取页面数据，每日 6:00 抓前一天）；退款为「完结时间」口径；推广消耗待接入阿里妈妈',
  },
  淘宝: {
    suffix: '官方旗舰店（淘宝）',
    source: '数据来源：生意参谋-淘宝（真实浏览器读取页面数据，每日 6:00 抓前一天）；退款为「完结时间」口径；推广消耗待接入阿里妈妈',
  },
  京东: {
    suffix: '京东自营旗舰店（京东）',
    source: '数据来源：京东商智（每日 6:00 抓前一天）；退款为「完成时间」口径；推广消耗待接入京准通',
  },
  拼多多: {
    suffix: '官方旗舰店（拼多多）',
    source: '数据来源：拼多多商家后台 · 数据中心（每日 6:00 抓前一天）；退款为「退款成功时间」口径；推广消耗待接入多多推广',
  },
  抖音: {
    suffix: '官方旗舰店（抖音）',
    source: '数据来源：抖音电商罗盘（每日 6:00 抓前一天）；退款为「售后完成时间」口径；推广消耗待接入巨量千川',
  },
};
const base = PROFILES[CHANNELS[0]] || { suffix: `官方旗舰店（${CHANNELS[0]}）`, source: `数据来源：${CHANNELS[0]}商家后台（每日 6:00 抓前一天）；退款按退款成功时间统计；推广消耗待接入` };

function mergedSource() {
  const srcs = CHANNELS.map((c) => (PROFILES[c] && PROFILES[c].source) || `${c}商家后台`);
  const who = CHANNELS.map((c) => `「${c}」`).join(' + ');
  return `数据来源：${who} 合并口径 —— 按日汇总各渠道销售额 / 退款金额 / 件数；退款率与退后销售额按合计值重算；推广消耗待接入`;
}

const WDT_SOURCE = '数据来源：旺店通ERP导出（销售订单明细，按支付时间统计）；退款按退款完成时间；推广消耗待接入万相台/千川/京准通';
// 跨境进口 → 海外旗舰店；国内生产 → 官方旗舰店
const shopSuffix = (suffix) => (BRAND_PROFILE.origin === '国内生产'
  ? String(suffix).replace('海外旗舰店', '官方旗舰店')
  : suffix);
const profile = MERGED
  ? { shop: SHOP || `${BRAND}（${CHANNEL}）`, source: SOURCE === 'wdt' ? `${WDT_SOURCE}（合并口径：${CHANNEL}）` : mergedSource() }
  : { shop: SHOP || `${BRAND}${shopSuffix(base.suffix)}`, source: SOURCE === 'wdt' ? WDT_SOURCE : base.source };

/* ---------------- 栏目定义（与模板逐列一致，顺序不可改） ---------------- */
// type: date | money | pct | int；agg: sum | avg
const COLS = [
  ['date', '日期', 'date', ''],
  ['amount', '销售额', 'money', 'sum'],
  ['refund', '退款金额', 'money', 'sum'],
  ['netAmount', '退后销售额', 'money', 'sum'],
  ['refundRate', '退款率', 'pct', 'avg'],
  ['buyers', '买家数', 'int', 'sum'],
  ['qty', '支付件数', 'int', 'sum'],
  ['subOrders', '支付子订单数', 'int', 'sum'],
  ['aov', '客单价', 'money', 'avg'],
  ['convRate', '支付转化率', 'pct', 'avg'],
  ['uv', '访客数(UV)', 'int', 'sum'],
  ['pv', '浏览量(PV)', 'int', 'sum'],
  ['uvValue', 'UV价值', 'money', 'avg'],
  ['fav', '收藏人数', 'int', 'sum'],
  ['cartUsers', '加购人数', 'int', 'sum'],
  ['cartQty', '加购件数', 'int', 'sum'],
  ['follow', '关注店铺人数', 'int', 'sum'],
  ['oldBuyers', '老买家数', 'int', 'sum'],
  ['newBuyers', '新买家数', 'int', 'sum'],
  ['oldRate', '老客占比', 'pct', 'avg'],
  ['newVisitors', '新访客数', 'int', 'sum'],
  ['videoVisitors', '短视频访客数', 'int', 'sum'],
  ['newMembers', '新增会员数', 'int', 'sum'],
  ['memberBuyers', '会员成交人数', 'int', 'sum'],
  ['memberAmount', '会员成交金额', 'money', 'sum'],
  ['repeatMembers', '复购会员数', 'int', 'sum'],
  ['adCost', '推广消耗', 'money', 'sum'],
  ['feeRate', '费比', 'pct', 'avg'],
  ['feeRateNet', '费比(退后)', 'pct', 'avg'],
];
const WIDTHS = [12, 11, 11, 12, 9, 8, 9, 12, 9, 10, 11, 12, 9, 9, 9, 9, 12, 9, 9, 9, 9, 12, 10, 12, 12, 10, 10, 8, 10];

/* ---------------- 取数 ---------------- */
function loadRows() {
  if (EMPTY || !fs.existsSync(DB_PATH)) return [];
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const where = ['set_id = ?', `group_name IN (${CHANNELS.map(() => '?').join(',')})`];
    const params = [SET_ID, ...CHANNELS];
    const from = FROM || DATE;
    where.push('date >= ?', 'date <= ?');
    params.push(from, TO);
    // 品牌维度：库里一旦有品牌标记（旺店通导入后会写），就按品牌过滤；
    // 老数据没有品牌列/全为空时保持整渠道口径，避免突然查不到数。
    if (HAS_BRAND) {
      const marked = db.prepare(`SELECT COUNT(*) AS n FROM sales_daily
        WHERE set_id = ? AND group_name IN (${CHANNELS.map(() => '?').join(',')}) AND COALESCE(brand,'') <> ''`)
        .get(SET_ID, ...CHANNELS)?.n || 0;
      if (marked > 0) { where.push('COALESCE(brand, ?) = ?'); params.push('', BRAND); }
    }
    const rows = db.prepare(`SELECT date, SUM(amount) amount, SUM(return_amount) refund, SUM(qty) qty
      FROM sales_effective WHERE ${where.join(' AND ')} GROUP BY date ORDER BY date`).all(...params);
    return rows.map((r) => {
      const amount = Number(r.amount || 0);
      const refund = Number(r.refund || 0);
      return {
        date: r.date,
        amount,
        refund,
        netAmount: Math.round((amount - refund) * 100) / 100,
        refundRate: amount ? refund / amount : '',
        qty: Number(r.qty || 0) || '',
        // 其余栏目数据源未接入 → 留空
        buyers: '', subOrders: '', aov: '', convRate: '', uv: '', pv: '', uvValue: '',
        fav: '', cartUsers: '', cartQty: '', follow: '', oldBuyers: '', newBuyers: '', oldRate: '',
        newVisitors: '', videoVisitors: '', newMembers: '', memberBuyers: '', memberAmount: '',
        repeatMembers: '', adCost: '', feeRate: '', feeRateNet: '',
      };
    });
  } finally {
    db.close();
  }
}

/* ---------------- OOXML 细节 ---------------- */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = '', n = i + 1; while (n > 0) { n -= 1; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };

// 样式索引：见 stylesXml 中 cellXfs 顺序
const S = { title: 1, sub: 2, head: 3, date: 4, text: 5, money: 6, pct: 7, int: 8, totalLabel: 9, totalMoney: 10, totalPct: 11, totalInt: 12 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.00%"/><numFmt numFmtId="166" formatCode="#,##0"/></numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="13"/><name val="Calibri"/></font>
<font><sz val="9"/><color rgb="FF808080"/><name val="Calibri"/></font>
<font><b/><sz val="10"/><name val="Calibri"/></font>
<font><b/><sz val="10"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDAE3F3"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="middle" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="middle"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="middle"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="middle"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="middle"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="middle"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="middle"/></xf>
<xf numFmtId="164" fontId="4" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="middle"/></xf>
<xf numFmtId="165" fontId="4" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="middle"/></xf>
<xf numFmtId="166" fontId="4" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="middle"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(ref, value, styleIdx, formula) {
  if (formula) return `<c r="${ref}" s="${styleIdx}"><f>${esc(formula)}</f></c>`;
  if (value === '' || value == null) return `<c r="${ref}" s="${styleIdx}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}" s="${styleIdx}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${styleIdx}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function buildDailySheet(rows) {
  const lastCol = colName(COLS.length - 1);
  const headCells = COLS.map(([, label], i) => cellXml(`${colName(i)}3`, label, S.head)).join('');
  const dataRowsXml = rows.map((r, ri) => {
    const rn = 4 + ri;
    const cells = COLS.map(([key, , type], ci) => {
      const ref = `${colName(ci)}${rn}`;
      const v = r[key];
      if (type === 'date') return cellXml(ref, v, S.date);
      if (type === 'money') return cellXml(ref, v, S.money);
      if (type === 'pct') return cellXml(ref, v, S.pct);
      return cellXml(ref, v, S.int);
    }).join('');
    return `<row r="${rn}">${cells}</row>`;
  }).join('');

  // 合计/均值行：即便无数据也保留（公式区间按实际行数，空数据时给 0 行区间则留空值）
  const totalRow = 4 + rows.length;
  let totalCells;
  if (rows.length) {
    const first = 4;
    const last = 3 + rows.length;
    totalCells = COLS.map(([key, , type, agg], ci) => {
      const ref = `${colName(ci)}${totalRow}`;
      if (type === 'date') return cellXml(ref, '合计/均值', S.totalLabel);
      const range = `${colName(ci)}${first}:${colName(ci)}${last}`;
      if (agg === 'avg') return cellXml(ref, '', S.totalPct, `IFERROR(AVERAGE(${range}),"")`);
      const st = type === 'money' ? S.totalMoney : type === 'pct' ? S.totalPct : S.totalInt;
      return cellXml(ref, '', st, `SUM(${range})`);
    }).join('');
  } else {
    totalCells = COLS.map(([key, , type], ci) => {
      const ref = `${colName(ci)}${totalRow}`;
      if (type === 'date') return cellXml(ref, '合计/均值', S.totalLabel);
      const st = type === 'money' ? S.totalMoney : type === 'pct' ? S.totalPct : S.totalInt;
      return cellXml(ref, '', st, '0');
    }).join('');
  }

  const cols = WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="3" topLeftCell="B4" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>
<row r="1" ht="22" customHeight="1"><c r="A1" s="${S.title}" t="inlineStr"><is><t xml:space="preserve">${esc(`${profile.shop}${MERGED ? '合并' : ''}每日经营数据 · 自动抓取`)}</t></is></c></row>
<row r="2"><c r="A2" s="${S.sub}" t="inlineStr"><is><t xml:space="preserve">${esc(profile.source)}</t></is></c></row>
<row r="3">${headCells}</row>
${dataRowsXml}
<row r="${totalRow}">${totalCells}</row>
</sheetData>
<mergeCells count="2"><mergeCell ref="A1:${lastCol}1"/><mergeCell ref="A2:${lastCol}2"/></mergeCells>
</worksheet>`;
}

function buildNoteSheet() {
  const notes = [
    ['指标', '口径说明'],
    ['销售额', `支付金额（支付时间），${CHANNEL}口径`],
    ['退款金额', '退款金额（退款成功时间）；与「支付时间」口径会有差异'],
    ['退款率', '退款金额 ÷ 销售额'],
    ['退后销售额', '销售额 − 退款金额'],
    ['买家数/件数', '支付买家数 / 支付件数（含数量）'],
    ['支付子订单数', '支付子订单数，与支付件数不同（一件多件商品时两者不等）'],
    ['客单价/转化率', `${CHANNEL}「客单价」「支付转化率」`],
    ['UV/PV', '访客数 / 浏览量'],
    ['收藏/加购/关注', '商品收藏人数 / 加购人数、加购件数 / 关注店铺人数'],
    ['老新买家', '支付老买家数、支付新买家数（按店铺是否首单划分）'],
    ['会员', '新增会员数、会员成交人数、会员成交金额、复购会员数'],
    ['推广消耗', `待接入（${CHANNEL}推广后台）`],
    ['抓取时间', '每天 6:00 抓前一天数据；7:00 推送'],
    ['说明', '本表由本地系统按标准模板生成；空缺栏目表示数据源未接入，不代表为 0'],
  ];
  const rowsXml = notes.map((row, ri) => {
    const rn = ri + 1;
    const s = ri === 0 ? S.head : S.text;
    return `<row r="${rn}">${cellXml(`A${rn}`, row[0], s)}${cellXml(`B${rn}`, row[1], s)}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="70" customWidth="1"/></cols>
<sheetData>${rowsXml}</sheetData>
</worksheet>`;
}

/* ---------------- 打包 ---------------- */
function buildXlsx(rows) {
  return zipStore([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="每日经营数据" sheetId="1" r:id="rId1"/><sheet name="口径说明" sheetId="2" r:id="rId2"/></sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: buildDailySheet(rows) },
    { name: 'xl/worksheets/sheet2.xml', data: buildNoteSheet() },
  ]);
}

/* ---------------- 主流程 ---------------- */
const rows = loadRows();
const buf = buildXlsx(rows);
const endDate = rows.length ? rows[rows.length - 1].date : (TO || DATE);
const outPath = OUT || path.join(ROOT, 'exports', `${CHANNEL}-${BRAND}日报_${endDate}.xlsx`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buf);

console.log(`已生成：${outPath}`);
console.log(`品牌：${BRAND}｜渠道：${CHANNEL}${MERGED ? '（合并）' : ''}｜标题：${profile.shop}${MERGED ? '合并' : ''}每日经营数据`);
console.log(`数据行：${rows.length} 行${EMPTY ? '（空数据测试）' : ''}｜栏目：${COLS.length} 列（与模板一致）`);
console.log(`合计行：第 ${4 + rows.length} 行（SUM / IFERROR(AVERAGE) 公式）`);
