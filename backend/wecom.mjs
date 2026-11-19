/**
 * 企业微信本地缓存接入（v1.9.0）
 *
 * 目标：把企微 PC 端缓存目录里的日报文件解析进 sales_daily，口径独立为 source='wecom'，
 *      与 platform / sales_dept / wdt 三套口径完全隔离，互不混算。
 *
 * 三重防重（本模块的核心约束）：
 *   1. 文件级：sha256 台账 wecom_files，同一份文件重复扫描直接跳过，不再解析、不再写入；
 *   2. 系列级：同一系列的历史副本（如日更表的 (1)(2)…）按「覆盖日期最全 → 行数最多」择优，
 *      其余标记 superseded 不入库，避免旧版本覆盖新数据；
 *   3. 行级：自然键 (set_id, source, channel_id, date, product='全店', sku='') 比对，
 *      已存在且金额一致 → 跳过；金额不一致 → 视为「日更表修正」更新并留痕；不存在 → 新增。
 *   另加批次留痕 wecom_batches，任何一次扫描/落库都可追溯。
 *
 * 已知限制（不要在代码里假装绕过）：
 *   - 企微 message.db / file.db 为 SQLCipher 加密库，本模块不读、不解密；
 *   - 缓存文件不带发送人标记，因此 rules/wecom-sync.json 里的 persons 白名单
 *     目前只用于品牌责任人标注，不能反查「这个文件是谁发的」。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, get, all, run, now } from './store.mjs';
import { unzipEntries } from './export.mjs';
import { readXlsBuffer } from './xls.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'rules', 'wecom-sync.json');
const SET_DEFAULT = 85;

const ok = (data, message = '') => ({ code: 0, message, data });
const fail = (message) => ({ code: 1, message, data: null });
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const today = () => new Date().toISOString().slice(0, 10);

/* ---------------- 配置 ---------------- */

export function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const single = (process.env.ZD_WECOM_CACHE || '').trim();
  const roots = single ? [single] : (cfg.cacheRoots || [cfg.cacheRoot || '']);
  // 多账号：企微根目录下每个账号的缓存都纳入（机器人专号 + 主人号都收）
  if (!single) {
    const wxRoot = String(cfg.wxworkRoot || process.env.ZD_WXWORK_ROOT || '').replace(/\\/g, '/');
    if (wxRoot && fs.existsSync(wxRoot)) {
      for (const d of fs.readdirSync(wxRoot, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        for (const sub of ['Cache/File', 'Cache/Image']) {
          const p2 = path.join(wxRoot, d.name, sub).replace(/\\/g, '/');
          if (fs.existsSync(p2) && !roots.includes(p2)) roots.push(p2);
        }
      }
    }
  }
  // 投递箱：人工丢进来的文件也放这里，跟着缓存一起扫描
  if (!single) roots.push(path.join(ROOT, 'data', 'inbox'));
  return {
    ...cfg,
    setId: Number(cfg.setId) || SET_DEFAULT,
    source: cfg.source || 'wecom',
    cacheRoots: roots.filter(Boolean).map((p) => p.replace(/\\/g, '/')),
    brands: cfg.brands || {},
    series: Array.isArray(cfg.series) ? cfg.series : [],
    reportExts: cfg.reportExts || ['xlsx', 'xls'],
    ledgerExts: cfg.ledgerExts || ['xlsx', 'xls', 'pdf', 'jpg', 'jpeg', 'png'],
    maxFileMB: Number(cfg.maxFileMB) || 40,
  };
}

export function brandOf(name, cfg) {
  const s = String(name || '');
  for (const [brand, keys] of Object.entries(cfg.brands)) {
    if (keys.some((k) => s.includes(k))) return brand;
  }
  return '';
}

export function personsOfBrand(brand, cfg) {
  return (cfg.persons || []).filter((p) => (p.brands || []).includes(brand));
}

/* ---------------- 表结构 ---------------- */

export function ensureWecomTables() {
  // 多进程（后端 + 命令行）同时写时宁可等一会儿，也不要直接抛 SQLITE_BUSY
  try { db.exec('PRAGMA busy_timeout = 8000'); } catch { /* 忽略 */ }
  db.exec(`
CREATE TABLE IF NOT EXISTS wecom_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content_sig TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  ext TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  source_path TEXT NOT NULL DEFAULT '',
  series TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  rows_in INTEGER NOT NULL DEFAULT 0,
  rows_new INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  rows_same INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  batch_id INTEGER NOT NULL DEFAULT 0,
  archived_path TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE(set_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_wecom_files_series ON wecom_files(set_id, series, period);

CREATE TABLE IF NOT EXISTS wecom_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'preview',
  actor TEXT NOT NULL DEFAULT '',
  files_seen INTEGER NOT NULL DEFAULT 0,
  files_new INTEGER NOT NULL DEFAULT 0,
  files_skipped INTEGER NOT NULL DEFAULT 0,
  files_failed INTEGER NOT NULL DEFAULT 0,
  rows_new INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  rows_same INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS wecom_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  channel TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  refund REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'embedded',
  src_max_date TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(set_id, month, channel)
);

CREATE TABLE IF NOT EXISTS wecom_reconcile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  channel TEXT NOT NULL,
  summary_amount REAL NOT NULL DEFAULT 0,
  summary_refund REAL NOT NULL DEFAULT 0,
  summary_fee REAL NOT NULL DEFAULT 0,
  detail_amount REAL NOT NULL DEFAULT 0,
  detail_refund REAL NOT NULL DEFAULT 0,
  detail_fee REAL NOT NULL DEFAULT 0,
  diff_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  batch_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(set_id, month, channel)
);
`);

  // 老库升级：补 content_sig 列（SQLite 没有 IF NOT EXISTS 语法，只能查一次）
  const cols = db.prepare('PRAGMA table_info(wecom_files)').all().map((c) => c.name);
  if (!cols.includes('content_sig')) {
    db.exec("ALTER TABLE wecom_files ADD COLUMN content_sig TEXT NOT NULL DEFAULT ''");
  }
  const sumCols = db.prepare('PRAGMA table_info(wecom_summary)').all().map((c) => c.name);
  if (!sumCols.includes('scope')) {
    db.exec("ALTER TABLE wecom_summary ADD COLUMN scope TEXT NOT NULL DEFAULT 'embedded'");
  }
  if (!sumCols.includes('src_max_date')) {
    db.exec("ALTER TABLE wecom_summary ADD COLUMN src_max_date TEXT NOT NULL DEFAULT ''");
  }
}

/* ---------------- 文件扫描 ---------------- */

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function walk(dir, out = []) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name === 'Temp') continue;           // 临时分片不入账
      walk(p, out);
    } else if (d.isFile()) out.push(p);
  }
  return out;
}

function classify(file, cfg) {
  const base = path.basename(file);
  const ext = path.extname(base).toLowerCase().slice(1);
  const hit = cfg.series.find((s) => base.includes(s.match) && (!s.exts || s.exts.includes(ext)));
  const periodMatch = /(20\d{2})[.\-年](\d{1,2})[.\-月](\d{1,2})/.exec(base);
  const monthMatch = /(20\d{2})[.\-年](\d{1,2})月?/.exec(base);
  const period = periodMatch
    ? `${periodMatch[1]}-${pad(periodMatch[2])}-${pad(periodMatch[3])}`
    : monthMatch ? `${monthMatch[1]}-${pad(monthMatch[2])}` : '';
  if (hit) {
    return { kind: 'report', series: hit.id, seriesDef: hit, brand: hit.brand || brandOf(base, cfg), period };
  }
  const kind = cfg.reportExts.includes(ext) ? 'sheet' : /^(jpg|jpeg|png|gif|bmp|webp)$/.test(ext) ? 'image' : ext === 'pdf' ? 'pdf' : 'doc';
  return { kind, series: '', seriesDef: null, brand: brandOf(base, cfg), period };
}

/* ---------------- 表格读取（保留空列，供适配器按列位取值） ---------------- */

const decodeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');

const colIndex = (letters) => letters.split('')
  .reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

/** xlsx → 二维数组（行号 1 基转 0 基，缺列补空串） */
export function xlsxGrid(buf) {
  const files = unzipEntries(buf);
  const shared = [];
  const ss = files['xl/sharedStrings.xml']?.toString('utf8') || '';
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join(''));
  }
  let sheet = files['xl/worksheets/sheet1.xml'];
  if (!sheet) {
    const key = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/sheet(\d+)/)[1]) - Number(b.match(/sheet(\d+)/)[1]))[0];
    sheet = key ? files[key] : null;
  }
  if (!sheet) throw new Error('xlsx 中未找到工作表');
  const grid = [];
  for (const rm of sheet.toString('utf8').matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rn = Number(rm[1]) - 1;
    const cells = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || '', inner = cm[2] || '';
      const L = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const idx = L ? colIndex(L) : cells.length;
      const t = /t="([^"]+)"/.exec(attrs)?.[1] || '';
      let val = '';
      if (t === 'inlineStr') {
        val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join('');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
        val = t === 's' ? (shared[Number(v)] ?? '') : decodeXml(v);
      }
      cells[idx] = val;
    }
    grid[rn] = Array.from(cells, (c) => (c == null ? '' : c));
  }
  for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
  return grid;
}

/** 老式 xls → [{ name, grid }] */
function xlsGrids(buf) {
  return readXlsBuffer(buf).map((s) => ({ name: s.name || '', grid: s.grid || [] }));
}

const fromSerial = (n) => {
  const ms = Date.UTC(1899, 11, 30) + Math.round(Number(n)) * 86400000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

const isSerial = (v) => {
  if (typeof v === 'number') return v > 40000 && v < 60000;
  return /^\d{5}$/.test(String(v || '').trim()) && Number(v) > 40000;
};

const numOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === '-' || s === '/' || s.startsWith('#')) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const findCol = (header, names) => {
  for (const n of names) {
    const i = header.findIndex((h) => String(h || '').replace(/\s/g, '').includes(n));
    if (i >= 0) return i;
  }
  return -1;
};

/* ---------------- 适配器 ---------------- */

/**
 * 天猫旗舰店日报：单工作表，双层表头，字段行在其下一行，再往下逐日一行。
 * 销售额取「销售完成」，退货取「退款金额」，推广费取「总推广费」。
 */
function adaptTmDailySingle(buf) {
  const grid = xlsxGrid(buf);
  const hi = grid.findIndex((row) => row.some((c) => String(c).replace(/\s/g, '') === '销售完成'));
  if (hi < 0) throw new Error('未找到表头行（缺少「销售完成」列）');
  const header = grid[hi].map((c) => String(c).replace(/\s/g, ''));
  const cAmount = findCol(header, ['销售完成']);
  const cRefund = findCol(header, ['退款金额']);
  const cFee = findCol(header, ['总推广费']);
  const cNet = findCol(header, ['退后销售', '去退成交额']);
  const rows = [];
  for (let i = hi + 1; i < grid.length; i++) {
    const r = grid[i] || [];
    if (!isSerial(r[0])) continue;
    const amount = numOrNull(r[cAmount]);
    if (amount === null) continue;
    const refund = cRefund >= 0 ? (numOrNull(r[cRefund]) ?? 0) : 0;
    const fee = cFee >= 0 ? (numOrNull(r[cFee]) ?? 0) : 0;
    const net = cNet >= 0 ? numOrNull(r[cNet]) : null;
    rows.push({ date: fromSerial(r[0]), amount, refund, fee, net: net == null ? money(amount - refund) : net });
  }
  if (!rows.length) throw new Error('未取到任何日数据');
  return rows;
}

/**
 * 京东/拼多多日更表：多工作表，每个工作表一个渠道；首行为表头，
 * 其下有「X月MTD」汇总行（跳过）和逐日行（首列为日期序列）。
 */
function adaptJdPddSheets(buf) {
  const out = [];
  const summary = [];
  for (const { name, grid } of xlsGrids(buf)) {
    if (!/京东|拼多多/.test(name)) continue;
    const hi = grid.findIndex((row) => row.some((c) => String(c).includes('全店日销售额GMV')));
    if (hi < 0) continue;
    const header = grid[hi].map((c) => String(c).replace(/\s/g, ''));
    const cAmount = findCol(header, ['全店日销售额GMV']);
    const cRefund = findCol(header, ['全店退款金额']);
    const cFee = findCol(header, ['全店总推广费']);
    const cNet = findCol(header, ['全店去退成交额']);
    const platform = /拼多多/.test(name) ? '拼多多' : '京东';
    for (let i = hi + 1; i < grid.length; i++) {
      const r = grid[i] || [];
      const first = String(r[0] ?? '').trim();
      // 「X月MTD」是文件自带的汇总行，不当日数据，单独收起来做校验基准
      const mtd = /^(\d{1,2})月MTD$/.exec(first);
      if (mtd) {
        const year = /(\d{4})/.exec(String(r[2] ?? ''))?.[1] || '';
        const amount = numOrNull(r[cAmount]);
        if (year && amount !== null) {
          summary.push({
            channel: name, platform, month: `${year}-${pad(mtd[1])}`,
            amount, refund: cRefund >= 0 ? (numOrNull(r[cRefund]) ?? 0) : 0,
            fee: cFee >= 0 ? (numOrNull(r[cFee]) ?? 0) : 0,
            label: first,
          });
        }
        continue;
      }
      if (!isSerial(r[0])) continue;
      const amount = numOrNull(r[cAmount]);
      if (amount === null) continue;
      const refund = cRefund >= 0 ? (numOrNull(r[cRefund]) ?? 0) : 0;
      const fee = cFee >= 0 ? (numOrNull(r[cFee]) ?? 0) : 0;
      const net = cNet >= 0 ? numOrNull(r[cNet]) : null;
      out.push({
        channel: name, platform, date: fromSerial(r[0]), amount, refund, fee,
        net: net == null ? money(amount - refund) : net,
      });
    }
  }
  if (!out.length) throw new Error('未从任何工作表取到数据');
  return { rows: out, summary };
}

function adapt(seriesDef, buf) {
  if (seriesDef.adapter === 'tm_daily_single') {
    return {
      rows: adaptTmDailySingle(buf).map((r) => ({ ...r, channel: seriesDef.channel, platform: seriesDef.platform })),
      summary: [],
    };
  }
  if (seriesDef.adapter === 'jd_pdd_sheets') return adaptJdPddSheets(buf);
  throw new Error(`适配器 ${seriesDef.adapter} 未实现`);
}

/** 内容指纹：忽略文件名与副本差异，只看「日期+渠道+金额」这组事实是否相同 */
const contentSig = (rows) => crypto.createHash('sha256').update(
  rows.map((r) => `${r.date}|${r.channel || ''}|${money(r.amount)}|${money(r.refund)}|${money(r.fee)}`).sort().join('\n'),
).digest('hex');

/* ---------------- 渠道与落库 ---------------- */

function ensureChannel(setId, name, platform, source) {
  const row = get('SELECT id FROM sales_channels WHERE set_id = ? AND name = ?', setId, name);
  if (row) return row.id;
  const info = run(`INSERT INTO sales_channels (set_id, name, platform, shop_code, source, active, created_at)
    VALUES (?, ?, ?, '', ?, 1, ?)`, setId, name, platform || '', source, now());
  return Number(info.lastInsertRowid);
}

/** 预览用：只查不建，查不到返回 -1（保证预览模式零写入） */
function peekChannel(setId, name) {
  const row = get('SELECT id FROM sales_channels WHERE set_id = ? AND name = ?', setId, name);
  return row ? row.id : -1;
}

const NATURAL_KEY = `set_id = ? AND source = ? AND channel_id = ? AND date = ? AND product = '全店' AND sku = ''`;

function findSale(setId, source, channelId, date) {
  return get(`SELECT id, amount, return_amount, fee FROM sales_daily WHERE ${NATURAL_KEY}`,
    setId, source, channelId, date);
}

const sameMoney = (exist, row) => Math.abs(Number(exist.amount) - money(row.amount)) < 0.01
  && Math.abs(Number(exist.return_amount) - money(row.refund)) < 0.01
  && Math.abs(Number(exist.fee) - money(row.fee)) < 0.01;

/** 按自然键落一行。返回 'new' | 'same' | 'updated'。 */
function upsertSale(setId, source, channelId, row) {
  const exist = findSale(setId, source, channelId, row.date);
  const netProfit = money(row.net - row.fee);
  if (!exist) {
    run(`INSERT INTO sales_daily (set_id, channel_id, date, sku, product, group_name, qty, amount, return_qty,
        return_amount, cost, fee, gross_profit, net_profit, source, batch_id, created_at)
      VALUES (?, ?, ?, '', '全店', ?, 0, ?, 0, ?, 0, ?, ?, ?, ?, 0, ?)`,
    setId, channelId, row.date, row.platform || '', money(row.amount), money(row.refund),
    money(row.fee), netProfit, netProfit, source, now());
    return 'new';
  }
  if (sameMoney(exist, row)) return 'same';
  run('UPDATE sales_daily SET amount = ?, return_amount = ?, fee = ?, gross_profit = ?, net_profit = ? WHERE id = ?',
    money(row.amount), money(row.refund), money(row.fee), netProfit, netProfit, exist.id);
  return 'updated';
}

function archiveFile(file, sha, period, cfg) {
  if (!cfg.archiveReports) return '';
  const ym = (period || '').slice(0, 7) || today().slice(0, 7);
  const dir = path.join(ROOT, cfg.archiveRoot || 'data/wecom', ym);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${sha.slice(0, 10)}_${path.basename(file)}`);
  if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
  return path.relative(ROOT, dest).replace(/\\/g, '/');
}

/**
 * 写汇总值。同一月份+渠道可能被多份快照覆盖，必须取「覆盖日期最新」的那份，
 * 否则会出现旧快照的 MTD 覆盖新快照明细的情况（实测踩过：10 月旧快照把 11 月汇总写成 9,582）。
 */
function saveSummary(setId, one, { fileName, fileMaxDate, scope = 'embedded', force = false }) {
  if (!/^\d{4}-\d{2}$/.test(one.month || '')) return;
  const ex = get('SELECT id, src_max_date, scope FROM wecom_summary WHERE set_id = ? AND month = ? AND channel = ?',
    setId, one.month, one.channel);
  if (ex && !force) {
    // 外部汇总表优先于内嵌汇总；同类型比快照日期
    const rank = (sc) => (sc === 'external' ? 1 : 0);
    const older = String(fileMaxDate || '') < String(ex.src_max_date || '');
    if (rank(scope) < rank(ex.scope)) return;
    if (rank(scope) === rank(ex.scope) && older) return;
  }
  const vals = [money(one.amount), money(one.refund), money(one.fee), one.platform || '', one.label || '',
    scope, String(fileMaxDate || ''), fileName || '', now()];
  if (ex) {
    run(`UPDATE wecom_summary SET amount = ?, refund = ?, fee = ?, platform = ?, label = ?, scope = ?,
        src_max_date = ?, source_file = ?, updated_at = ? WHERE id = ?`, ...vals, ex.id);
  } else {
    run(`INSERT INTO wecom_summary (set_id, month, channel, amount, refund, fee, platform, label, scope,
        src_max_date, source_file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    setId, one.month, one.channel, money(one.amount), money(one.refund), money(one.fee), one.platform || '',
    one.label || '', scope, String(fileMaxDate || ''), fileName || '', now(), now());
  }
}

/* ---------------- 汇总校验：以汇总报表为准 ---------------- */

const monthEnd = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/**
 * 用文件自带的汇总行（如「11月MTD」）校验明细累加是否准确。
 * 口径：汇总报表为准 —— 差异超过容差时，写一条「汇总差异调整」行把月度合计补回汇总值，
 *       并把汇总/明细/差异三组数记进 wecom_reconcile，随时可追溯、可撤销。
 * 调整行标识：sku='__SUMADJ__'、product='汇总差异调整'，与正常日数据天然隔离。
 */
function reconcileOne(sid, cfg, apply, item, s, batchId) {
  const cname = s.channel;
  const cid = apply ? ensureChannel(sid, cname, s.platform, cfg.source) : peekChannel(sid, cname);
  const agg = cid > 0
    ? get(`SELECT ROUND(COALESCE(SUM(amount),0),2) a, ROUND(COALESCE(SUM(return_amount),0),2) r,
          ROUND(COALESCE(SUM(fee),0),2) f, COUNT(*) n FROM sales_daily
        WHERE set_id = ? AND source = ? AND channel_id = ? AND date LIKE ? AND sku != '__SUMADJ__'`,
    sid, cfg.source, cid, `${s.month}%`)
    : { a: 0, r: 0, f: 0, n: 0 };
  const diff = money(s.amount - Number(agg.a || 0));
  const tol = Math.max(1, Math.abs(Number(s.amount) || 0) * 0.001);
  const scope = s.scope || 'embedded';
  // 汇总与明细不符时：
  //   外部汇总表（独立文件/月度汇总）→ 以汇总为准，写调整行；
  //   同文件内嵌汇总（如「X月MTD」行）→ 只记录待复核，绝不覆盖明细，
  //   因为这种矛盾通常说明单元格本身是错的（实测有过 23.6 万的错值）。
  let status = 'ok';
  if (Math.abs(diff) > tol) {
    if (scope === 'external' || cfg.adoptEmbeddedSummary) status = 'adopted';
    else status = 'review';
  }

  if (apply) {
    const exist = get('SELECT id FROM wecom_reconcile WHERE set_id = ? AND month = ? AND channel = ?', sid, s.month, cname);
    const vals = [money(s.amount), money(s.refund), money(s.fee), money(agg.a), money(agg.r), money(agg.f),
      diff, status, item.name, batchId, now()];
    if (exist) {
      run(`UPDATE wecom_reconcile SET summary_amount = ?, summary_refund = ?, summary_fee = ?, detail_amount = ?,
          detail_refund = ?, detail_fee = ?, diff_amount = ?, status = ?, source_file = ?, batch_id = ?, updated_at = ?
        WHERE id = ?`, ...vals, exist.id);
    } else {
      run(`INSERT INTO wecom_reconcile (set_id, month, channel, summary_amount, summary_refund, summary_fee,
          detail_amount, detail_refund, detail_fee, diff_amount, status, source_file, batch_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sid, s.month, cname, ...vals, now());
    }

    // 不需要调整时必须把历史调整行清掉，否则差异会一直挂着
    if (status !== 'adopted' && cid > 0) {
      run("DELETE FROM sales_daily WHERE set_id = ? AND source = ? AND channel_id = ? AND date = ? AND sku = '__SUMADJ__'",
        sid, cfg.source, cid, monthEnd(s.month));
    }
    if (status === 'adopted' && cid > 0) {
      const day = monthEnd(s.month);
      const adj = get(`SELECT id FROM sales_daily WHERE set_id = ? AND source = ? AND channel_id = ?
          AND date = ? AND sku = '__SUMADJ__'`, sid, cfg.source, cid, day);
      if (adj) {
        run('UPDATE sales_daily SET amount = ?, group_name = ? WHERE id = ?', diff, s.platform || '', adj.id);
      } else {
        run(`INSERT INTO sales_daily (set_id, channel_id, date, sku, product, group_name, qty, amount, return_qty,
            return_amount, cost, fee, gross_profit, net_profit, source, batch_id, created_at)
          VALUES (?, ?, ?, '__SUMADJ__', '汇总差异调整', ?, 0, ?, 0, 0, 0, 0, ?, ?, ?, 0, ?)`,
        sid, cid, day, s.platform || '', diff, diff, diff, cfg.source, now());
      }
    }
  }
  return { month: s.month, channel: cname, summary: money(s.amount), detail: money(agg.a), diff, status };
}

/* ---------------- 主流程 ---------------- */

/**
 * 扫描 +（可选）落库。分三遍：先全部解析，再按系列择优，最后统一写库。
 * @param {number} setId
 * @param {{ apply?: boolean, actor?: string, root?: string, only?: string }} opts
 */
export function syncWecom(setId, opts = {}) {
  ensureWecomTables();
  const cfg = loadConfig();
  const sid = Number(setId) || cfg.setId;
  const apply = Boolean(opts.apply);
  const roots = (opts.root ? [opts.root] : cfg.cacheRoots).map((p) => String(p).replace(/\\/g, '/'));
  const alive = roots.filter((r) => fs.existsSync(r));
  if (!alive.length) return fail(`企微缓存目录不存在：${roots.join(' / ')}`);

  const info = run('INSERT INTO wecom_batches (set_id, mode, actor, started_at) VALUES (?, ?, ?, ?)',
    sid, apply ? 'apply' : 'preview', String(opts.actor || 'local'), now());
  const batchId = Number(info.lastInsertRowid);

  let seen = 0, failed = 0, pending = 0, skipped = 0, registered = 0;
  const reconciles = [];
  let rowsNew = 0, rowsUpdated = 0, rowsSame = 0;

  /** 第一遍：扫描 + 分类 + 哈希 + 解析，得到候选 */
  const candidates = [];
  try {
    for (const root of alive) {
      for (const file of walk(root)) {
        const ext = path.extname(file).toLowerCase().slice(1);
        if (!cfg.ledgerExts.includes(ext)) continue;
        seen += 1;
        const meta = classify(file, cfg);
        if (opts.only && meta.series !== opts.only) continue;

        let size = 0, sha = '';
        try {
          size = fs.statSync(file).size;
          if (size > cfg.maxFileMB * 1024 * 1024) { skipped += 1; continue; }
          sha = sha256File(file);
        } catch { failed += 1; continue; }

        const item = {
          file, root, meta, sha, size,
          rel: path.relative(root, file).replace(/\\/g, '/'),
          name: path.basename(file), ext,
          rows: [], maxDate: '', status: '', note: '',
          blank: 0, new: 0, updated: 0, same: 0, stored: false,
        };
        const known = get('SELECT id, status, content_sig FROM wecom_files WHERE set_id = ? AND sha256 = ?', sid, sha);
        item.known = known || null;

        if (meta.kind !== 'report') {
          // 图片 / PDF / 普通表格：只入账备查，不解析
          item.status = 'registered';
          item.note = '非日报系列，仅登记备查';
          registered += 1;
          candidates.push(item);
          continue;
        }
        if (known && (known.status === 'applied' || known.status === 'superseded')) {
          // 同一份文件已入账，直接跳过，不再解析（第一道闸）
          skipped += 1;
          // 老记录没有内容指纹时补算一次，否则跨会话判重会失效；
          // 顺带把文件里内嵌的汇总值（如「X月MTD」）补进汇总表，供后续校准使用
          if (apply && !known.content_sig && meta.kind === 'report' && meta.seriesDef?.adapter && meta.seriesDef.adapter !== 'pending') {
            try {
              const p = adapt(meta.seriesDef, fs.readFileSync(file));
              run('UPDATE wecom_files SET content_sig = ? WHERE id = ?', contentSig(p.rows), known.id);
              const fd = p.rows.reduce((m, r) => (r.date > m ? r.date : m), '');
              for (const one of p.summary || []) {
                saveSummary(sid, one, { fileName: path.basename(file), fileMaxDate: fd, scope: 'embedded' });
              }
            } catch { /* 补算失败不影响主流程 */ }
          }
          if (apply) run('UPDATE wecom_files SET last_seen = ? WHERE id = ?', now(), known.id);
          continue;
        }
        if (meta.seriesDef.adapter === 'pending') {
          item.status = 'pending';
          item.note = '适配器待接入（已登记，不解析）';
          pending += 1;
          candidates.push(item);
          continue;
        }
        try {
          const parsed = adapt(meta.seriesDef, fs.readFileSync(file));
          item.rows = parsed.rows;
          item.summary = parsed.summary || [];
          // 日报文件是「截至当日」的累积快照，文件名日期之后的行是未填的 0，必须截掉
          const fileDate = meta.period.length === 10 ? meta.period : '';
          if (fileDate) item.rows = item.rows.filter((r) => r.date <= fileDate);
          item.maxDate = item.rows.reduce((m, r) => (r.date > m ? r.date : m), '');
        } catch (e) {
          item.status = 'failed';
          item.note = e.message;
          failed += 1;
          candidates.push(item);
          continue;
        }
        if (!item.maxDate) { item.status = 'failed'; item.note = '解析成功但无有效日期'; failed += 1; candidates.push(item); continue; }

        // 跨会话判重：同一个报表可能在多个群/多次转发里出现，文件字节不同（重存、改名）但事实相同。
        // 用内容指纹比对已入账记录，命中即跳过，绝不重复入账。
        item.sig = contentSig(item.rows);
        const twin = get(`SELECT file_name, period FROM wecom_files
            WHERE set_id = ? AND content_sig = ? AND status = 'applied' LIMIT 1`, sid, item.sig);
        if (twin) {
          item.status = 'duplicate';
          item.note = `内容与已入账的「${twin.file_name}」完全相同，跳过`;
          skipped += 1;
        }
        candidates.push(item);
      }
    }

    /**
     * 第二遍：系列级择优。
     * 快照型系列（旗舰店日报按月的累积快照、日更表的历史副本）按「系列 + 月份」分组，
     * 只保留覆盖日期最新、行数最多的一份，其余标 superseded 不入库，
     * 避免旧版本把新数据覆盖成 0。
     */
    const snapshotGroups = new Map();
    for (const c of candidates) {
      if (c.meta.kind !== 'report' || c.status === 'failed' || c.status === 'pending') continue;
      if (c.meta.seriesDef?.dedupe !== 'snapshot') continue;
      const month = (c.meta.period || c.maxDate).slice(0, 7);
      const key = `${c.meta.series}|${month}`;
      if (!snapshotGroups.has(key)) snapshotGroups.set(key, []);
      snapshotGroups.get(key).push(c);
    }
    for (const [, list] of snapshotGroups) {
      if (list.length < 2) continue;
      list.sort((a, b) => (b.maxDate.localeCompare(a.maxDate)) || (b.rows.length - a.rows.length));
      for (const c of list.slice(1)) {
        c.status = 'superseded';
        c.note = `同系列旧快照，已被 ${list[0].name} 覆盖，不入库`;
        c.rows = [];
        skipped += 1;
      }
    }

    /** 第三遍：写库 */
    if (apply) db.exec('BEGIN');
    // 同一份内容可能在多个目录/多个副本里出现（如 沙棘调研.xlsx 与 沙棘调研(1).xlsx），
    // 台账按 sha256 唯一，这里先按哈希去重，避免撞唯一键。
    const writtenSha = new Set();
    for (const c of candidates) {
      const period = c.meta.period || (c.maxDate ? c.maxDate.slice(0, 7) : '');
      if (c.meta.kind !== 'report') {
        if (apply && !c.known && !writtenSha.has(c.sha)) {
          writtenSha.add(c.sha);
          run(`INSERT OR IGNORE INTO wecom_files (set_id, sha256, file_name, ext, size, source_path, series, brand, period,
              kind, status, note, batch_id, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'registered', ?, ?, ?, ?)`,
          sid, c.sha, c.name, c.ext, c.size, c.rel, c.meta.brand, period, c.meta.kind, c.note, batchId, now(), now());
        }
        continue;
      }
      if (c.status === 'pending' || c.status === 'failed') {
        if (apply && !c.known && !writtenSha.has(c.sha)) {
          writtenSha.add(c.sha);
          run(`INSERT OR IGNORE INTO wecom_files (set_id, sha256, file_name, ext, size, source_path, series, brand, period,
              kind, status, note, batch_id, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'report', ?, ?, ?, ?, ?)`,
          sid, c.sha, c.name, c.ext, c.size, c.rel, c.meta.series, c.meta.brand, period,
          c.status, c.note, batchId, now(), now());
        }
        continue;
      }
      if (c.status === 'duplicate') {
        if (apply && !c.known && !writtenSha.has(c.sha)) {
          writtenSha.add(c.sha);
          run(`INSERT OR IGNORE INTO wecom_files (set_id, sha256, content_sig, file_name, ext, size, source_path, series, brand, period,
              kind, status, note, batch_id, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'report', 'duplicate', ?, ?, ?, ?)`,
          sid, c.sha, c.sig || '', c.name, c.ext, c.size, c.rel, c.meta.series, c.meta.brand, period,
          c.note, batchId, now(), now());
        }
        continue;
      }
      if (c.status === 'superseded') {
        if (apply && !c.known && !writtenSha.has(c.sha)) {
          writtenSha.add(c.sha);
          run(`INSERT OR IGNORE INTO wecom_files (set_id, sha256, file_name, ext, size, source_path, series, brand, period,
              kind, status, note, batch_id, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'report', 'superseded', ?, ?, ?, ?)`,
          sid, c.sha, c.name, c.ext, c.size, c.rel, c.meta.series, c.meta.brand, period,
          c.note, batchId, now(), now());
        }
        continue;
      }

      // 只接受「今天及以前」且不早于 2024 年的日期，未来空行一律不写
      const limitDate = today();
      const usable = c.rows.filter((r) => r.date <= limitDate && r.date >= '2024-01-01');
      c.blank = c.rows.length - usable.length;
      const channelCache = new Map();
      for (const r of usable) {
        const cname = r.channel || c.meta.seriesDef?.channel;
        if (!cname) { c.note = '缺少渠道名，跳过'; continue; }
        if (!channelCache.has(cname)) {
          channelCache.set(cname, apply
            ? ensureChannel(sid, cname, r.platform || c.meta.seriesDef?.platform, cfg.source)
            : peekChannel(sid, cname));
        }
        const cid = channelCache.get(cname);
        if (!apply) {
          const exist = cid > 0 ? findSale(sid, cfg.source, cid, r.date) : null;
          if (!exist) c.new += 1;
          else if (sameMoney(exist, r)) c.same += 1;
          else c.updated += 1;
          continue;
        }
        const st = upsertSale(sid, cfg.source, cid, r);
        if (st === 'new') c.new += 1;
        else if (st === 'updated') c.updated += 1;
        else c.same += 1;
      }
      c.status = apply ? 'applied' : 'parsed';
      rowsNew += c.new; rowsUpdated += c.updated; rowsSame += c.same;

      if (apply && c.summary?.length) {
        for (const one of c.summary) {
          saveSummary(sid, one, { fileName: c.name, fileMaxDate: c.maxDate, scope: one.scope || 'embedded' });
        }
      }
      if (apply) {
        const archived = archiveFile(c.file, c.sha, period, cfg);
        const payload = [c.meta.series, c.meta.brand, period, usable.length, c.new, c.updated, c.same,
          batchId, archived, '', now()];
        if (c.known) {
          run(`UPDATE wecom_files SET series = ?, brand = ?, period = ?, rows_in = ?, rows_new = ?,
              rows_updated = ?, rows_same = ?, batch_id = ?, archived_path = ?, note = ?, last_seen = ?,
              content_sig = ? WHERE id = ?`, ...payload, c.sig || '', c.known.id);
        } else {
          run(`INSERT INTO wecom_files (set_id, sha256, content_sig, file_name, ext, size, source_path, series, brand, period,
              kind, status, rows_in, rows_new, rows_updated, rows_same, batch_id, archived_path, note, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'report', 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sid, c.sha, c.sig || '', c.name, c.ext, c.size, c.rel, c.meta.series, c.meta.brand, period,
          usable.length, c.new, c.updated, c.same, batchId, archived, '', now(), now());
        }
      }
    }
    /** 第五遍：汇总校验 —— 对已记录的每一条汇总值重新校准，不只针对本次新文件 */
    for (const sm of all('SELECT * FROM wecom_summary WHERE set_id = ? ORDER BY month DESC', sid)) {
      reconciles.push(reconcileOne(sid, cfg, apply, { name: sm.source_file }, {
        month: sm.month, channel: sm.channel, platform: sm.platform,
        amount: sm.amount, refund: sm.refund, fee: sm.fee, scope: sm.scope,
      }, batchId));
    }
    if (apply) db.exec('COMMIT');
  } catch (e) {
    if (apply) { try { db.exec('ROLLBACK'); } catch { /* 忽略 */ } }
    run(`UPDATE wecom_batches SET files_seen = ?, files_failed = ?, finished_at = ?, detail = ? WHERE id = ?`,
      seen, failed + 1, now(), JSON.stringify({ error: e.message }), batchId);
    return fail(`同步中断（已回滚）：${e.message}`);
  }

  run(`UPDATE wecom_batches SET files_seen = ?, files_new = ?, files_skipped = ?, files_failed = ?,
      rows_new = ?, rows_updated = ?, rows_same = ?, finished_at = ?, detail = ? WHERE id = ?`,
  seen, candidates.filter((c) => c.status === 'parsed' || c.status === 'applied').length,
  skipped, failed, rowsNew, rowsUpdated, rowsSame, now(),
  JSON.stringify(candidates.filter((c) => c.meta.kind === 'report')
    .map((c) => ({ f: c.name, s: c.status, n: c.note })).slice(0, 40)), batchId);

  const reports = candidates.filter((c) => c.meta.kind === 'report');
  const accepted = reports.filter((c) => c.status === 'parsed' || c.status === 'applied');
  const dupCount = reports.filter((c) => c.status === 'duplicate').length;
  return ok({
    batchId,
    mode: apply ? 'apply' : 'preview',
    roots: alive,
    source: cfg.source,
    scanned: seen,
    accepted: accepted.length,
    skipped,
    failed,
    pending,
    registered,
    rows: { new: rowsNew, updated: rowsUpdated, same: rowsSame },
    duplicates: reports.filter((c) => c.status === 'duplicate').length,
    reconcile: {
      total: reconciles.length,
      ok: reconciles.filter((r) => r.status === 'ok').length,
      adopted: reconciles.filter((r) => r.status === 'adopted'),
      review: reconciles.filter((r) => r.status === 'review'),
    },
    files: reports.map((c) => ({
      name: c.name, series: c.meta.series, brand: c.meta.brand,
      period: c.meta.period || c.maxDate.slice(0, 7),
      rows: c.rows.length, new: c.new, updated: c.updated, same: c.same,
      status: c.status, note: c.note,
      owners: c.meta.brand ? personsOfBrand(c.meta.brand, cfg).map((p) => p.name) : [],
    })),
  }, (apply
    ? `已落库：${accepted.length} 份日报，新增 ${rowsNew} 行，修正 ${rowsUpdated} 行，未变 ${rowsSame} 行`
    : `预览完成：识别 ${accepted.length} 份日报，待新增 ${rowsNew} 行，待修正 ${rowsUpdated} 行，未变 ${rowsSame} 行`)
    + (dupCount ? `；${dupCount} 份内容重复已跳过` : '')
    + (reconciles.filter((r) => r.status === 'adopted').length
      ? `；${reconciles.filter((r) => r.status === 'adopted').length} 个渠道已按汇总表调整`
      : '')
    + (reconciles.filter((r) => r.status === 'review').length
      ? `；${reconciles.filter((r) => r.status === 'review').length} 个渠道汇总与明细不符，待复核（未改数）`
      : ''));
}

/* ---------------- 核对 ---------------- */

/** 台账 vs 库内数据对账，并做重复检测。任何不一致都会列出来，不静默。 */
export function verifyWecom(setId) {
  ensureWecomTables();
  const cfg = loadConfig();
  const sid = Number(setId) || cfg.setId;

  const dup = all(`SELECT channel_id, date, COUNT(*) AS n FROM sales_daily
    WHERE set_id = ? AND source = ? GROUP BY channel_id, date, product, sku HAVING COUNT(*) > 1`,
  sid, cfg.source);

  const byChannel = all(`SELECT c.name, c.platform,
      COUNT(CASE WHEN d.sku != '__SUMADJ__' THEN 1 END) AS days,
      COUNT(CASE WHEN d.sku = '__SUMADJ__' THEN 1 END) AS adjust_rows,
      ROUND(SUM(d.amount), 2) AS amount,
      ROUND(SUM(d.return_amount), 2) AS refund, ROUND(SUM(d.fee), 2) AS fee,
      MIN(d.date) AS d1, MAX(d.date) AS d2
    FROM sales_daily d JOIN sales_channels c ON c.id = d.channel_id
    WHERE d.set_id = ? AND d.source = ? GROUP BY c.id ORDER BY amount DESC`, sid, cfg.source);

  const byMonth = all(`SELECT substr(date, 1, 7) AS ym, COUNT(*) AS days, ROUND(SUM(amount), 2) AS amount,
      ROUND(SUM(return_amount), 2) AS refund, ROUND(SUM(fee), 2) AS fee
    FROM sales_daily WHERE set_id = ? AND source = ? GROUP BY ym ORDER BY ym DESC LIMIT 24`, sid, cfg.source);

  const ledger = all(`SELECT series, status, COUNT(*) AS n, SUM(rows_new) AS new_rows,
      SUM(rows_updated) AS upd_rows FROM wecom_files WHERE set_id = ? GROUP BY series, status`, sid);

  const batches = all(`SELECT id, mode, files_new, files_skipped, files_failed, rows_new, rows_updated,
      rows_same, started_at FROM wecom_batches WHERE set_id = ? ORDER BY id DESC LIMIT 10`, sid);

  const recon = all(`SELECT month, channel, summary_amount, detail_amount, diff_amount, status, source_file
    FROM wecom_reconcile WHERE set_id = ? ORDER BY month DESC, ABS(diff_amount) DESC LIMIT 60`, sid);
  const dupFiles = all(`SELECT file_name, note FROM wecom_files
    WHERE set_id = ? AND status = 'duplicate' ORDER BY id DESC LIMIT 30`, sid);

  const problems = [];
  if (dup.length) problems.push(`发现 ${dup.length} 组重复自然键`);
  const failedRows = ledger.filter((l) => l.status === 'failed');
  if (failedRows.length) problems.push(`${failedRows.reduce((s, f) => s + f.n, 0)} 份文件解析失败`);
  const pendingRows = ledger.filter((l) => l.status === 'pending');
  if (pendingRows.length) problems.push(`${pendingRows.reduce((s, p) => s + p.n, 0)} 份文件适配器未接入（已登记）`);

  const adopted = recon.filter((r) => r.status === 'adopted');
  const review = recon.filter((r) => r.status === 'review');
  if (adopted.length) problems.push(`${adopted.length} 个渠道已按外部汇总表调整（见 reconcile）`);
  if (review.length) problems.push(`${review.length} 个渠道「同文件内嵌汇总」与明细不符，待人工复核（未改数）`);

  const total = byChannel.reduce((s, c) => s + Number(c.amount || 0), 0);
  return ok({
    source: cfg.source,
    totalAmount: money(total),
    adoptedCount: adopted.length,
    reviewCount: review.length,
    duplicate: dup,
    byChannel,
    byMonth,
    ledger,
    batches,
    reconcile: recon,
    duplicateFiles: dupFiles,
    problems,
  }, problems.length ? `核对完成，有 ${problems.length} 项需要处理` : '核对完成，未发现重复或异常');
}
