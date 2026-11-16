/**
 * 妆点管账 · 报表导出中心
 *  - 内置生成 CSV / XLSX / JSON / Markdown / HTML（零第三方依赖，XLSX 为手写 OOXML zip）
 *  - Filee（外部 CLI，进程级集成）负责把导出文件再转换成 PDF / DOCX / ODS / 图片等任意格式
 *  - 所有产物落在 .local/exports/，文件名与参数均做白名单校验，spawn 不用 shell
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { reportTable as buildStatementTable } from './reports.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, 'backend', 'data', 'jinli.db');
export const EXPORT_DIR = path.join(ROOT, '.local', 'exports');
const CONVERTED_DIR = path.join(EXPORT_DIR, 'converted');

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const EXT_RE = /^[a-z0-9]{1,10}$/;
// 允许中文文件名，但禁止路径分隔符、空字节与上级目录跳转
const safeName = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200
  && !/[\\/\x00]/.test(v) && !v.includes('..');

export const BUILTIN_FORMATS = ['csv', 'xlsx', 'json', 'md', 'html'];
export const REPORTS = [
  { key: 'vouchers', label: '凭证清单' },
  { key: 'ledger', label: '科目余额表' },
  { key: 'dashboard', label: '经营概览' },
  { key: 'subjects', label: '会计科目表' },
];

/**
 * 外部目标格式清单。本机没有 .NET / LibreOffice，真 Filee（C#）跑不起来，
 * 因此用「Filee CLI 协议兼容」的本地零依赖转换桥 tools/filee-bridge.mjs 承接。
 * 清单必须与桥的 EXTRA_RENDERERS 保持一致；完整清单可用 `filee formats` 查看。
 * 已移除真实无法产出的 xls（BIFF）、xlsx（内置已有）等项，避免列出假格式。
 */
export const EXTRA_FORMATS = [
  'pdf', 'docx', 'ods', 'odt', 'rtf', 'txt', 'tsv', 'xml', 'svg',
  'png', 'jpg', 'jpeg', 'webp',
];
export const FILEE_TARGETS = EXTRA_FORMATS;

const MIME = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  epub: 'application/epub+zip',
  rtf: 'application/rtf',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

export function mimeFor(name) {
  return MIME[String(name).toLowerCase().split('.').pop()] || 'application/octet-stream';
}

const xmlEsc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const htmlEsc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const num = (v) => Number(v ?? 0) || 0;
const money = (v) => num(v).toFixed(2);

function openDb() {
  return new DatabaseSync(DB_PATH);
}

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

/* ---------------- 报表数据 ---------------- */

function queryVouchers(db, setId, period) {
  const rows = db.prepare(`
    SELECT v.date, v.word, v.no, v.status, e.line, e.summary,
           e.subject_code, e.subject_name, e.debit, e.credit
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
    WHERE v.set_id = ? AND v.period = ?
    ORDER BY v.date, v.no, e.line`).all(setId, period);
  return {
    title: '凭证清单',
    columns: [
      { key: 'date', label: '日期' }, { key: 'word', label: '凭证字' },
      { key: 'no', label: '凭证号', type: 'number' }, { key: 'status', label: '状态' },
      { key: 'line', label: '行号', type: 'number' }, { key: 'summary', label: '摘要' },
      { key: 'subject_code', label: '科目编码' }, { key: 'subject_name', label: '科目名称' },
      { key: 'debit', label: '借方金额', type: 'number' },
      { key: 'credit', label: '贷方金额', type: 'number' },
    ],
    rows,
  };
}

function queryLedger(db, setId, period) {
  const rows = db.prepare(`
    SELECT e.subject_code, e.subject_name,
           SUM(e.debit) AS debit, SUM(e.credit) AS credit
    FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
    WHERE v.set_id = ? AND v.period = ? AND v.status = 'posted'
    GROUP BY e.subject_code, e.subject_name
    ORDER BY e.subject_code`).all(setId, period);
  return {
    title: '科目余额表',
    columns: [
      { key: 'subject_code', label: '科目编码' }, { key: 'subject_name', label: '科目名称' },
      { key: 'opening', label: '期初余额' },
      { key: 'debit', label: '本期借方', type: 'number' },
      { key: 'credit', label: '本期贷方', type: 'number' },
      { key: 'ending', label: '期末余额' },
    ],
    rows: rows.map((r) => ({ ...r, opening: '0.00', ending: money(num(r.debit) - num(r.credit)) })),
  };
}

function querySubjects(db, setId) {
  const rows = db.prepare(`
    SELECT code, name, category, type, direction FROM subjects
    WHERE set_id = ? ORDER BY code`).all(setId);
  return {
    title: '会计科目表',
    columns: [
      { key: 'code', label: '科目编码' }, { key: 'name', label: '科目名称' },
      { key: 'category', label: '科目类别' }, { key: 'type', label: '科目类型' },
      { key: 'direction', label: '余额方向' },
    ],
    rows,
  };
}

function queryDashboard(db, setId, period) {
  const rows = db.prepare(`
    SELECT e.subject_code, SUM(e.debit) AS debit, SUM(e.credit) AS credit
    FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
    WHERE v.set_id = ? AND v.period = ? AND v.status = 'posted'
    GROUP BY e.subject_code`).all(setId, period);
  const m = { revenue: 0, cost: 0, expense: 0, capital: 0, ar: 0, ap: 0, tax: 0 };
  for (const r of rows) {
    const c = r.subject_code || '';
    const net = num(r.debit) - num(r.credit);
    if (/^(6001|6041|6051|6101|6111|6115|6117|6301)/.test(c)) m.revenue += num(r.credit) - num(r.debit);
    else if (/^64/.test(c)) m.cost += net;
    else if (/^(66|68)/.test(c)) m.expense += net;
    if (/^(1001|1002|1012)/.test(c)) m.capital += net;
    if (/^(1121|1122)/.test(c)) m.ar += net;
    if (/^2202/.test(c)) m.ap += -net;
    if (/^2221/.test(c)) m.tax += -net;
  }
  m.profit = m.revenue - m.cost - m.expense;
  const items = [
    ['资金总额', m.capital], ['营业收入', m.revenue], ['成本', m.cost],
    ['费用', m.expense], ['利润', m.profit], ['应收账款', m.ar],
    ['应付账款', m.ap], ['税金', m.tax],
    ['净利率', m.revenue ? Number((m.profit / m.revenue * 100).toFixed(2)) : 0],
  ];
  return {
    title: '经营概览',
    columns: [{ key: 'item', label: '指标' }, { key: 'value', label: '金额（元）/ 比率（%）' }],
    rows: items.map(([item, value]) => ({ item, value: money(value) })),
  };
}

/** 订单列表（供导出中心与智能体出 Excel） */
function queryOrders(db, setId, period) {
  const where = period ? " AND substr(o.order_date,1,7) = ?" : '';
  const params = period ? [setId, period] : [setId];
  const rows = db.prepare(`SELECT o.*, 
      (SELECT carrier FROM order_shipments s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1) AS carrier,
      (SELECT tracking_no FROM order_shipments s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1) AS tracking_no,
      (SELECT status FROM order_shipments s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1) AS ship_status
    FROM orders o WHERE o.set_id = ?${where} ORDER BY o.order_date DESC, o.id DESC`).all(...params);
  const LABEL = { open: '进行中', partial: '部分发货', settled: '已结清', returning: '退货中', returned: '已退货', cancelled: '已取消' };
  const SHIP = { pending: '待发货', picked: '已揽收', transit: '运输中', delivering: '派送中', signed: '已签收', returned: '退回' };
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  return {
    title: '销售订单',
    columns: [
      { key: 'order_no', label: '订单号' }, { key: 'order_date', label: '日期' },
      { key: 'customer', label: '客户' }, { key: 'channel', label: '渠道' },
      { key: 'status', label: '状态' },
      { key: 'amount', label: '金额', type: 'number' }, { key: 'discount', label: '折扣', type: 'number' },
      { key: 'net', label: '应收', type: 'number' }, { key: 'cost', label: '成本', type: 'number' },
      { key: 'profit', label: '毛利', type: 'number' },
      { key: 'ship', label: '物流状态' }, { key: 'tracking', label: '运单号' },
    ],
    rows: rows.map((o) => ({
      order_no: o.order_no, order_date: o.order_date, customer: o.customer, channel: o.channel,
      status: LABEL[o.status] || o.status,
      amount: r2(o.amount), discount: r2(o.discount),
      net: r2(Number(o.amount) - Number(o.discount)), cost: r2(o.cost),
      profit: r2(Number(o.amount) - Number(o.discount) - Number(o.cost)),
      ship: o.ship_status ? (SHIP[o.ship_status] || o.ship_status) : '未登记',
      tracking: o.tracking_no || '',
    })),
  };
}

/** 支出明细（凭证明细） */
function queryExpenses(db, setId, period) {
  const rows = db.prepare(`SELECT v.date, v.word, v.no, e.summary, e.subject_code, e.subject_name, e.debit, e.credit
    FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
    WHERE v.set_id = ? AND v.period = ? AND v.status != 'void'
    ORDER BY v.date, v.id, e.line`).all(setId, period);
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  return {
    title: '支出明细',
    columns: [
      { key: 'date', label: '日期' }, { key: 'voucher', label: '凭证号' },
      { key: 'summary', label: '摘要' }, { key: 'subject', label: '科目' },
      { key: 'debit', label: '借方', type: 'number' }, { key: 'credit', label: '贷方', type: 'number' },
      { key: 'amount', label: '净额', type: 'number' },
    ],
    rows: rows.map((r) => ({
      date: r.date, voucher: `${r.word}-${r.no}`, summary: r.summary,
      subject: `${r.subject_code} ${r.subject_name}`,
      debit: r2(r.debit), credit: r2(r.credit), amount: r2(Number(r.debit) - Number(r.credit)),
    })),
  };
}

const BUILDERS = {
  vouchers: queryVouchers, ledger: queryLedger,
  dashboard: queryDashboard, subjects: querySubjects,
  // 三大报表：与 /api/reports/{type} 共用同一套计算引擎，保证页面与导出完全一致
  balance: (db, setId, period) => buildStatementTable(db, setId, 'balance', period),
  income: (db, setId, period) => buildStatementTable(db, setId, 'income', period),
  cash: (db, setId, period) => buildStatementTable(db, setId, 'cash', period),
  orders: queryOrders,
  expenses: queryExpenses,
};

/* ---------------- 渲染 ---------------- */

function csvCell(v, type) {
  let s = String(v ?? '');
  if (type !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防 CSV 公式注入
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function renderCsv(table) {
  const head = table.columns.map((c) => csvCell(c.label, 'text')).join(',');
  const body = table.rows.map((r) => table.columns
    .map((c) => csvCell(r[c.key], c.type)).join(',')).join('\r\n');
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(`${head}\r\n${body}\r\n`, 'utf8')]);
}

function renderJson(table, meta) {
  return Buffer.from(JSON.stringify({
    report: meta.kind, title: table.title, period: meta.period,
    generated_at: new Date().toISOString(),
    columns: table.columns.map((c) => c.label), rows: table.rows,
  }, null, 2), 'utf8');
}

function renderMd(table, meta) {
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const head = '| ' + table.columns.map((c) => esc(c.label)).join(' | ') + ' |';
  const sep = '| ' + table.columns.map(() => '---').join(' | ') + ' |';
  const body = table.rows.map((r) => '| ' + table.columns
    .map((c) => esc(r[c.key])).join(' | ') + ' |').join('\n');
  return Buffer.from(`# ${table.title}\n\n账套：振颜丽舍 ｜ 期间：${meta.period} ｜ 生成时间：${new Date().toLocaleString('zh-CN')}\n\n${head}\n${sep}\n${body}\n`, 'utf8');
}

function renderHtml(table, meta) {
  const head = table.columns.map((c) => `<th>${htmlEsc(c.label)}</th>`).join('');
  const body = table.rows.map((r) => '<tr>' + table.columns
    .map((c) => `<td${c.type === 'number' ? ' class="n"' : ''}>${htmlEsc(r[c.key])}</td>`).join('') + '</tr>').join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${htmlEsc(table.title)}-${meta.period}</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:36px;background:#fff8fa;color:#4a2438;font-family:"Microsoft YaHei","Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #e6b7cd;padding-bottom:18px;margin-bottom:24px}
.logo{width:46px;height:46px;border-radius:13px;background:linear-gradient(135deg,#fccddc,#742a54);color:#fff;font-size:26px;font-weight:700;display:flex;align-items:center;justify-content:center}
h1{font-size:22px;margin:0;letter-spacing:2px}.meta{color:#96667e;font-size:13px;margin-top:6px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(116,42,84,.08)}
th{background:#f8e7ef;color:#742a54;text-align:left;padding:11px 14px;font-size:13px;letter-spacing:1px}
td{padding:10px 14px;border-top:1px solid #f4e5ec;font-size:13px}td.n{text-align:right;font-variant-numeric:tabular-nums}
tr:nth-child(even) td{background:#fffbfd}footer{margin-top:20px;color:#a98498;font-size:12px}
@media print{body{background:#fff;padding:12px}table{box-shadow:none}}
</style></head><body>
<header><div class="logo">&yen;</div><div><h1>${htmlEsc(table.title)}</h1><div class="meta">振颜丽舍 · 妆点管账 ｜ 期间 ${htmlEsc(meta.period)} ｜ ${new Date().toLocaleString('zh-CN')}</div></div></header>
<table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${table.columns.length}">本期暂无数据</td></tr>`}</tbody></table>
<footer>本报表由妆点管账本地端生成，数据仅保存在本机。</footer></body></html>`;
  return Buffer.from(html, 'utf8');
}

/* --- 极简 ZIP(store) + OOXML，生成真正的 .xlsx --- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function zipStore(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    offset += lh.length + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

function colName(i) {
  let s = '', n = i + 1;
  while (n > 0) { n--; s = String.fromCharCode(65 + n % 26) + s; n = Math.floor(n / 26); }
  return s;
}

function renderXlsx(table) {
  const cell = (ref, v, type) => type === 'number'
    ? `<c r="${ref}"><v>${num(v)}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  const head = `<row r="1">${table.columns.map((c, i) => cell(`${colName(i)}1`, c.label, 'text')).join('')}</row>`;
  const body = table.rows.map((r, ri) => `<row r="${ri + 2}">${table.columns
    .map((c, i) => cell(`${colName(i)}${ri + 2}`, r[c.key], c.type)).join('')}</row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${head}${body}</sheetData></worksheet>`;
  return zipStore([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(table.title)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

const RENDERERS = { csv: renderCsv, xlsx: renderXlsx, json: renderJson, md: renderMd, html: renderHtml };

/* ---------------- 对外接口 ---------------- */

/**
 * 生成报表的结构化数据（columns + rows），供 MCP get_report 等程序化调用方消费。
 * buildReport 与它共用同一份真实查询，避免「文件里有数据、接口返回空 rows」。
 */
export function reportTable({ kind = 'vouchers', period = '', setId = 85 } = {}) {
  if (!BUILDERS[kind]) throw new Error(`不支持的报表类型：${kind}`);
  const p = period || currentPeriod();
  if (!PERIOD_RE.test(p)) throw new Error('期间格式应为 YYYY-MM');
  const db = openDb();
  try {
    return { table: BUILDERS[kind](db, Number(setId) || 85, p), period: p, kind, setId: Number(setId) || 85 };
  } finally {
    db.close();
  }
}

export function buildReport({ kind = 'vouchers', period = '', format = 'csv', setId = 85 } = {}) {
  if (!BUILTIN_FORMATS.includes(format)) throw new Error(`不支持的导出格式：${format}`);
  const { table, period: p } = reportTable({ kind, period, setId });
  const meta = { kind, period: p, format, setId };
  const content = RENDERERS[format](table, meta);
  const filename = `妆点管账_${table.title}_${p}.${format}`;
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const saved = path.join(EXPORT_DIR, filename);
  fs.writeFileSync(saved, content);
  return { filename, mime: MIME[format], content, saved, rows: table.rows.length, title: table.title };
}

/* ---------------- 内置格式转换（零第三方依赖，不依赖 Filee） ----------------
 * Filee 只负责 PDF/DOCX/ODS/图片等外部格式；常见的表格格式互转在这里本地完成，
 * 这样未安装 Filee 时「手动改文件格式」依然完整可用。
 */

export const PARSE_EXTS = ['csv', 'tsv', 'txt', 'json', 'md', 'markdown', 'html', 'htm', 'xlsx'];
const UPLOAD_MAX = 5 * 1024 * 1024;

const decodeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const stripTags = (s) => decodeXml(String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')).trim();

function makeTable(headers, rows, title = '格式转换结果') {
  const seen = new Set();
  const columns = headers.map((h, i) => {
    const label = String(h ?? '').trim() || `列 ${i + 1}`;
    let key = label, n = 1;
    while (seen.has(key)) { n += 1; key = `${label}_${n}`; }
    seen.add(key);
    return { key, label, type: 'text' };
  });
  const data = rows.filter(Array.isArray).map((r) => {
    const o = {};
    columns.forEach((c, i) => { o[c.key] = String(r[i] ?? ''); });
    return o;
  });
  return { title, columns, rows: data };
}

function splitDelimited(text, sep) {
  const rows = [];
  let row = [], cur = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function parseCsv(buf, sep = ',') {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = splitDelimited(text, sep);
  if (!rows.length) throw new Error('文件里没有可解析的表格数据');
  return makeTable(rows[0], rows.slice(1));
}

function parseJson(buf) {
  let j;
  try { j = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('JSON 解析失败，请确认是导出中心生成的 JSON 或对象数组'); }
  if (Array.isArray(j)) {
    const keys = j.length && j[0] && typeof j[0] === 'object' ? Object.keys(j[0]) : ['value'];
    return makeTable(keys, j.map((x) => keys.map((k) => (x && typeof x === 'object' ? x[k] : x))));
  }
  const labels = Array.isArray(j.columns) ? j.columns.map(String) : [];
  const rows = Array.isArray(j.rows) ? j.rows : [];
  if (!labels.length && rows.length && rows[0] && typeof rows[0] === 'object') {
    Object.keys(rows[0]).forEach((k) => labels.push(k));
  }
  const data = rows.map((r) => labels.map((k, i) => {
    if (Array.isArray(r)) return r[i];
    if (r && typeof r === 'object') return r[k] ?? Object.values(r)[i] ?? '';
    return r;
  }));
  if (!labels.length) throw new Error('JSON 里没有列定义或数据行');
  return makeTable(labels, data, String(j.title || '格式转换结果'));
}

function parseMd(buf) {
  const rows = buf.toString('utf8').split(/\r?\n/)
    .filter((l) => /^\s*\|.*\|\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|')
      .map((c) => c.trim().replace(/\\\|/g, '|')))
    .filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
  if (!rows.length) throw new Error('Markdown 中没有表格');
  return makeTable(rows[0], rows.slice(1));
}

function parseHtml(buf) {
  const t = /<table[\s\S]*?<\/table>/i.exec(buf.toString('utf8'));
  if (!t) throw new Error('HTML 中没有 <table>');
  const rows = [...t[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((tr) => [...tr[1].matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map((c) => stripTags(c[2])))
    .filter((r) => r.length);
  if (!rows.length) throw new Error('HTML 表格为空');
  return makeTable(rows[0], rows.slice(1));
}

/** 读取 ZIP 中央目录，兼容 store(0) 与 deflate(8) 两种 xlsx 压缩方式 */
export function unzipEntries(buf) {
  const out = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（未找到 ZIP 结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.slice(start, start + csize);
    try { out[name] = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : Buffer.alloc(0); }
    catch { out[name] = Buffer.alloc(0); }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const colIndex = (letters) => letters.split('')
  .reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

function parseXlsx(buf) {
  const files = unzipEntries(buf);
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    for (const m of files['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join(''));
    }
  }
  const sheet = files['xl/worksheets/sheet1.xml'];
  if (!sheet) throw new Error('xlsx 缺少 sheet1.xml（仅支持第一个工作表）');
  const rows = [];
  for (const rm of sheet.toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || '', inner = cm[2] || '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const idx = ref ? colIndex(ref) : cells.length;
      const t = /t="([^"]+)"/.exec(attrs)?.[1] || '';
      let val = '';
      if (t === 'inlineStr') {
        val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join('');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
        val = t === 's' ? (shared[Number(v)] ?? '') : v;
      }
      cells[idx] = val;
    }
    rows.push(Array.from(cells, (c) => c ?? ''));
  }
  if (!rows.length) throw new Error('xlsx 表格为空');
  return makeTable(rows[0], rows.slice(1));
}

export function parseTable(buf, ext, name) {
  const title = path.basename(name, path.extname(name));
  let table;
  if (ext === 'csv') table = parseCsv(buf);
  else if (ext === 'tsv' || ext === 'txt') table = parseCsv(buf, '\t');
  else if (ext === 'json') table = parseJson(buf);
  else if (ext === 'md' || ext === 'markdown') table = parseMd(buf);
  else if (ext === 'html' || ext === 'htm') table = parseHtml(buf);
  else if (ext === 'xlsx') table = parseXlsx(buf);
  else throw new Error(`不支持的源格式 .${ext}`);
  return { ...table, title: title || table.title };
}

/** 上传用户本地文件到导出目录（base64，5MB 上限，文件名白名单） */
export function upload({ name = '', content = '' } = {}) {
  if (!safeName(name)) throw new Error('非法文件名');
  const ext = path.extname(name).toLowerCase().slice(1);
  if (!PARSE_EXTS.includes(ext)) {
    throw new Error(`不支持的源格式 .${ext}；当前支持：${PARSE_EXTS.join(' / ')}`);
  }
  let buf;
  try { buf = Buffer.from(String(content), 'base64'); }
  catch { throw new Error('文件内容编码错误'); }
  if (!buf.length || buf.length > UPLOAD_MAX) throw new Error('文件为空或超过 5MB');
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const saved = path.join(EXPORT_DIR, path.basename(name));
  fs.writeFileSync(saved, buf);
  return { ok: true, name: path.basename(name), size: buf.length, ext };
}

function convertBuiltin(src, to, from) {
  if (!PARSE_EXTS.includes(from)) {
    throw new Error(`不支持把 .${from} 作为源格式；支持：${PARSE_EXTS.join(' / ')}`);
  }
  const table = parseTable(fs.readFileSync(src), from, src);
  const meta = { kind: 'convert', period: new Date().toISOString().slice(0, 7), setId: 85 };
  const out = `${path.basename(src, path.extname(src))}.${to}`;
  fs.mkdirSync(CONVERTED_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONVERTED_DIR, out), RENDERERS[to](table, meta));
  return {
    ok: true, engine: 'builtin', output: out, rows: table.rows.length,
    download: `/api/export/download?dir=converted&file=${encodeURIComponent(out)}`,
    message: `已用内置转换器生成 ${out}（${table.rows.length} 行，无需 Filee）`,
  };
}

/* ---------------- Filee 进程级集成 ---------------- */

function readFileeCli() {
  const fromEnv = (process.env.FILEE_CLI || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const line = env.split(/\r?\n/).find((l) => /^\s*FILEE_CLI\s*=/.test(l));
    if (line) return line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
  } catch { /* .env 不存在时按未配置处理 */ }
  return '';
}

export function fileeStatus() {
  const raw = readFileeCli();
  const looksLikePath = raw && (path.isAbsolute(raw) || /[\\/]/.test(raw));
  // .env 里写相对路径（如 tools/filee-bridge.mjs）时按项目根解析
  const cli = looksLikePath ? path.resolve(ROOT, raw) : raw;
  const exists = looksLikePath ? fs.existsSync(cli) : null;
  const script = Boolean(cli && /\.(mjs|js)$/i.test(cli));
  return {
    configured: Boolean(cli) && exists !== false,
    cli: cli || null,
    exists,
    engine: script ? 'local-bridge' : (cli ? 'external-cli' : 'none'),
    integration: 'process',   // 通过 spawn 调用 CLI，不是源码嵌入
    hint: !cli
      ? '未配置：请在 .env 设置 FILEE_CLI（本地桥 tools/filee-bridge.mjs 或官方 filee-cli.exe）'
      : exists === false ? `配置的 FILEE_CLI 路径不存在：${cli}`
        : script ? '本地 Filee 兼容转换桥已就绪（零外部依赖），可用 `filee formats` 查看格式清单'
          : '外部 Filee CLI 已配置，可用 `filee formats` 查看实时格式清单',
  };
}

export function formats() {
  return {
    reports: REPORTS,
    builtin: BUILTIN_FORMATS,
    fileeTargets: FILEE_TARGETS,
    filee: fileeStatus(),
    convertFrom: PARSE_EXTS,
    convertToBuiltin: BUILTIN_FORMATS,
    uploadMaxMB: UPLOAD_MAX / 1024 / 1024,
    note: 'CSV/XLSX/JSON/MD/HTML 由内置转换器完成；PDF/DOCX/ODS/ODT/RTF/图片等由本地 Filee 兼容转换桥生成，零外部依赖、无需 .NET',
  };
}

export function listFiles() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  return fs.readdirSync(EXPORT_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && safeName(e.name))
    .map((e) => {
      const st = fs.statSync(path.join(EXPORT_DIR, e.name));
      return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export async function convert({ file = '', to = '' } = {}) {
  if (!safeName(file)) throw new Error('非法文件名');
  const src = path.join(EXPORT_DIR, path.basename(file));
  if (!fs.existsSync(src)) throw new Error('待转换文件不存在，请先生成报表');
  const ext = String(to).toLowerCase().replace(/^\./, '');
  if (!EXT_RE.test(ext)) throw new Error('目标格式不合法');

  // 目标格式属于内置 5 种时，直接本地互转，不依赖 Filee
  if (BUILTIN_FORMATS.includes(ext)) {
    const from = path.extname(src).toLowerCase().slice(1);
    try {
      return convertBuiltin(src, ext, from);
    } catch (e) {
      return { ok: false, engine: 'builtin', message: `内置转换失败：${e.message}` };
    }
  }

  const status = fileeStatus();
  if (!status.configured) {
    return { ok: false, message: `目标格式 .${ext} 需要转换桥（当前未配置或路径不存在）。内置转换器可直接转出 ${BUILTIN_FORMATS.join(' / ')}；请在 .env 设置 FILEE_CLI=tools/filee-bridge.mjs。` };
  }
  if (!EXTRA_FORMATS.includes(ext) && !BUILTIN_FORMATS.includes(ext)) {
    return { ok: false, message: `暂不支持目标格式 .${ext}；支持：${[...BUILTIN_FORMATS, ...EXTRA_FORMATS].join(' / ')}` };
  }
  if (status.exists === false) {
    return { ok: false, message: `Filee CLI 不存在：${status.cli}` };
  }

  fs.mkdirSync(CONVERTED_DIR, { recursive: true });
  const before = new Set(fs.readdirSync(CONVERTED_DIR));
  const startedAt = Date.now();
  const cliArgs = ['convert', src, '--to', ext, '-o', CONVERTED_DIR, '--overwrite'];
  // .mjs/.js 脚本不是可执行文件：用当前 Node 解释器启动，仍保持「不用 shell、参数白名单」
  const isScript = /\.(mjs|js)$/i.test(status.cli);
  const command = isScript ? process.execPath : status.cli;
  const args = isScript ? [status.cli, ...cliArgs] : cliArgs;

  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, cwd: ROOT });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, message: `无法启动 Filee CLI：${e.message}`, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const created = fs.readdirSync(CONVERTED_DIR).filter((f) => !before.has(f));
      // 重复转换同一文件会 --overwrite 覆盖同名产物，不能只靠「新增文件」判定，
      // 否则第二次转换会被误报成失败。优先读桥的 JSON 输出，再退回新增文件/预期名+mtime。
      let declared = null;
      try {
        const j = JSON.parse(stdout.trim());
        if (j?.ok && typeof j.output === 'string' && safeName(j.output)
            && path.basename(j.output) === j.output) declared = j.output;
      } catch { /* 外部 CLI 输出非 JSON 时忽略 */ }
      const expected = `${path.basename(src, path.extname(src))}.${ext}`;
      const fresh = (f) => {
        if (!f || !safeName(f) || path.basename(f) !== f) return false;
        const fp = path.join(CONVERTED_DIR, f);
        return fs.existsSync(fp) && fs.statSync(fp).mtimeMs >= startedAt - 2000;
      };
      const output = [declared, ...created, expected].find(fresh) || null;
      const ok = !timedOut && code === 0 && Boolean(output);
      resolve({
        ok, code, timedOut, output,
        download: output
          ? `/api/export/download?dir=converted&file=${encodeURIComponent(output)}` : null,
        outputs: created, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000),
        message: timedOut ? '转换超时（120s），可检查转换引擎是否就绪'
          : ok ? `已生成 ${output}` : `转换未产出文件（exit=${code}）`,
      });
    });
  });
}
