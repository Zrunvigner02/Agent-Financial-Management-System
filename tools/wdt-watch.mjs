#!/usr/bin/env node
/**
 * 旺店通导出自动入库（目录监控）
 *
 * 你只要把旺店通导出的「销售订单」CSV/XLSX 丢进 D:\振颜丽舍\wdt\每日导出，
 * 这个程序会在 10 秒内解析、按「日期 × 渠道 × 品牌」写进 sales_daily，然后把文件移到「已入库」。
 *
 * 口径（与 29 栏日报对齐）：
 *   销售额   = 付款订单金额（支付口径，不用发货金额，避免重复计）
 *   成本     = 货品成本 + 包装成本
 *   平台费用 = 佣金成本
 *   净利润   = 销售额 − 成本 − 平台费用 − 预估邮资成本
 *   件数     = 该报表不含件数，留 0（不猜）
 *
 * 幂等：同一 (日期, 渠道, 品牌) 只保留一行，重复导入只更新不新增。
 *
 *   node tools/wdt-watch.mjs --once      # 扫一遍就退出
 *   node tools/wdt-watch.mjs --watch     # 常驻，每 10 秒扫一次
 *   node tools/wdt-watch.mjs --dry       # 只看会解析出什么，不写库、不移动文件
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { unzipEntries } from '../backend/export.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.ZD_DB_PATH ? path.resolve(process.env.ZD_DB_PATH) : path.join(ROOT, 'backend', 'data', 'jinli.db');
const SET_ID = Number(process.env.ZD_SET_ID || 85);
const INBOX = process.env.WDT_INBOX || 'D:/振颜丽舍/wdt/每日导出';
const DONE = process.env.WDT_DONE || 'D:/振颜丽舍/wdt/已入库';
const POLL_MS = Number(process.env.WDT_POLL_MS || 10000);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has('--dry');

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/* ---------------- 列映射 ---------------- */

const CHANNEL_MAP = [
  [/天猫国际|天猫/, '天猫'],
  [/淘宝/, '淘宝'],
  [/京东/, '京东'],
  [/拼多多/, '拼多多'],
  [/抖音|抖店/, '抖音'],
  [/小红书/, '小红书'],
  [/唯品会/, '唯品会'],
];

const BRAND_MAP = [
  [/dr\.?hauschka|德国世家|德世|世家/i, '德国世家'],
  [/pf\s*-?\s*79/i, 'PF79'],
  [/歌剧魅影|opera/i, '歌剧魅影'],
];

function pickChannel(shop, fallback = '') {
  for (const [re, name] of CHANNEL_MAP) if (re.test(shop)) return name;
  const head = String(shop).split(/[-－—]/)[0].trim();
  return head || fallback || '未分渠道';
}
function pickBrand(shop) {
  for (const [re, name] of BRAND_MAP) if (re.test(shop)) return name;
  return '';
}

/* ---------------- 读取 CSV / XLSX ---------------- */

function parseCsv(text) {
  const rows = [];
  let cur = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cur.push(field); field = ''; }
    else if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  // 旺店通 CSV 每行前面有个 "="，去掉
  return rows
    .map((r) => r.map((c) => String(c).replace(/^=/, '').trim()))
    .filter((r) => r.length && r.some((c) => c));
}

function readXlsxRows(file) {
  const files = unzipEntries(fs.readFileSync(file));
  const wb = files['xl/workbook.xml'] ? files['xl/workbook.xml'].toString('utf8') : '';
  const parts = Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const sx = files['xl/sharedStrings.xml'].toString('utf8');
    for (const m of sx.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
    }
  }
  const xml = files[parts[0]] ? files[parts[0]].toString('utf8') : '';
  const rows = [];
  for (const m of xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [...m[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((c) => {
      const inline = c[2].match(/<t[^>]*>([\s\S]*?)<\/t>/);
      if (inline) return inline[1].replace(/&amp;/g, '&');
      const v = c[2].match(/<v>([\s\S]*?)<\/v>/);
      if (v && shared[Number(v[1])] != null) return shared[Number(v[1])];
      return v ? v[1] : '';
    });
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/* ---------------- 解析成入库行 ---------------- */

function toRecords(rows) {
  if (!rows.length) return { error: '空文件' };
  const head = rows[0].map((h) => String(h).replace(/\s/g, ''));
  const idx = (...names) => {
    for (const n of names) {
      const i = head.findIndex((h) => h === n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const col = {
    date: idx('日期'),
    shop: idx('店铺', '店铺名称'),
    amount: idx('付款订单金额', '发货订单金额'),
    orders: idx('付款订单数', '发货订单数'),
    cost: idx('货品成本'),
    pack: idx('包装成本'),
    fee: idx('佣金成本'),
    post: idx('预估邮资成本'),
  };
  if (col.date < 0 || col.shop < 0 || col.amount < 0) {
    return { error: `缺少必要列（日期/店铺/金额），实际表头：${head.slice(0, 8).join(',')}` };
  }

  const num = (r, i) => (i >= 0 ? money(String(r[i] || '0').replace(/,/g, '')) : 0);
  const map = new Map();
  for (const r of rows.slice(1)) {
    const date = String(r[col.date] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const shop = String(r[col.shop] || '').trim();
    if (!shop) continue;
    const channel = pickChannel(shop);
    const brand = pickBrand(shop);
    const key = `${date}|${channel}|${brand}`;
    const o = map.get(key) || { date, channel, brand, amount: 0, cost: 0, fee: 0, post: 0, orders: 0, shops: new Set() };
    o.amount = money(o.amount + num(r, col.amount));
    o.cost = money(o.cost + num(r, col.cost) + num(r, col.pack));
    o.fee = money(o.fee + num(r, col.fee));
    o.post = money(o.post + num(r, col.post));
    o.orders += num(r, col.orders);
    o.shops.add(shop);
    map.set(key, o);
  }
  return { records: [...map.values()] };
}

/* ---------------- 写库 ---------------- */

function apply(db, records, file) {
  const ins = db.prepare(`INSERT INTO sales_daily
    (set_id, channel_id, date, sku, product, group_name, brand, qty, amount, return_qty, return_amount,
     cost, fee, gross_profit, net_profit, source, batch_id, created_at)
    VALUES (?, 0, ?, '', '全店', ?, ?, 0, ?, 0, 0, ?, ?, ?, ?, 'wdt', 0, ?)`);
  const upd = db.prepare(`UPDATE sales_daily SET amount = ?, cost = ?, fee = ?, gross_profit = ?, net_profit = ?, created_at = ?
    WHERE set_id = ? AND source = 'wdt' AND date = ? AND group_name = ? AND COALESCE(brand,'') = ?`);
  const find = db.prepare(`SELECT id FROM sales_daily
    WHERE set_id = ? AND source = 'wdt' AND date = ? AND group_name = ? AND COALESCE(brand,'') = ?`);

  let added = 0;
  let updated = 0;
  const run = db.prepare('SELECT 1').get ? null : null; // 占位，保持接口一致
  db.exec('BEGIN');
  try {
    for (const o of records) {
      const gross = money(o.amount - o.cost);
      const net = money(o.amount - o.cost - o.fee - o.post);
      const exist = find.get(SET_ID, o.date, o.channel, o.brand || '');
      if (exist) {
        upd.run(o.amount, o.cost, o.fee, gross, net, now(), SET_ID, o.date, o.channel, o.brand || '');
        updated += 1;
      } else {
        ins.run(SET_ID, o.date, o.channel, o.brand || '', o.amount, o.cost, o.fee, gross, net, now());
        added += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { added, updated };
}

/* ---------------- 主流程 ---------------- */

function ensureDirs() {
  for (const d of [INBOX, DONE]) fs.mkdirSync(d, { recursive: true });
}

function processFile(db, file, { dry = false } = {}) {
  const ext = path.extname(file).toLowerCase();
  let rows = [];
  if (ext === '.csv') rows = parseCsv(fs.readFileSync(file, 'utf8'));
  else if (ext === '.xlsx') rows = readXlsxRows(file);
  else return { skipped: `不支持的类型 ${ext}` };

  const parsed = toRecords(rows);
  if (parsed.error) return { error: parsed.error };
  if (!parsed.records.length) return { skipped: '没有可入库的行' };

  const summary = {
    file: path.basename(file),
    records: parsed.records.length,
    days: new Set(parsed.records.map((r) => r.date)).size,
    channels: [...new Set(parsed.records.map((r) => r.channel))],
    brands: [...new Set(parsed.records.map((r) => r.brand).filter(Boolean))],
    amount: money(parsed.records.reduce((s, r) => s + r.amount, 0)),
  };

  if (!dry) {
    const r = apply(db, parsed.records, file);
    summary.added = r.added;
    summary.updated = r.updated;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dest = path.join(DONE, `${path.basename(file, ext)}_${stamp}${ext}`);
    try { fs.renameSync(file, dest); summary.moved = dest; } catch (e) { summary.move_error = e.message; }
    // 归集台账
    try {
      db.prepare(`INSERT INTO data_intake (set_id, source, sender_id, sender_name, category, doc_type, file_name,
        file_path, doc_date, batch_id, rows, status, sha256, created_at)
        VALUES (?, 'wdt', 'wdt-watch', '旺店通导出', 'sales', '销售订单', ?, ?, ?, 0, ?, ?, ?, ?)`)
        .run(SET_ID, path.basename(file), dest, parsed.records[0].date || '', parsed.records.length,
          'imported', crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex').slice(0, 16), now());
    } catch { /* 台账失败不影响入库 */ }
  }
  return { summary };
}

function scan(db) {
  ensureDirs();
  const files = fs.readdirSync(INBOX)
    .filter((f) => /\.(csv|xlsx)$/i.test(f) && !f.startsWith('~$'))
    .map((f) => path.join(INBOX, f));
  if (!files.length) return { scanned: 0 };
  const out = [];
  for (const f of files) {
    try {
      const r = processFile(db, f, { dry: DRY });
      out.push(r);
      console.log(`[${now()}] ${path.basename(f)} ->`,
        r.error ? `失败：${r.error}` : r.skipped ? `跳过：${r.skipped}` : JSON.stringify(r.summary));
    } catch (e) {
      console.log(`[${now()}] ${path.basename(f)} -> 异常：${e.message}`);
    }
  }
  return { scanned: files.length, out };
}

/* ---------------- 定时导出（RPA）+ 自动出日报 ---------------- */

const AHK = path.join(ROOT, 'tools', 'bin', 'AutoHotkey64.exe');
const EXPORT_AHK = path.join(ROOT, 'tools', 'rpa', 'wdt-export.ahk');
const COORD = path.join(ROOT, 'tools', 'rpa', 'wdt-coords.ini');
const DAY_MARK = path.join(ROOT, '.local', 'wdt-export-marks.json');
const REPORT_DIR = process.env.WDT_REPORT_DIR || 'D:/振颜丽舍/报表/日报';

// 每天两个时间点：23:00 正常抓当天；01:00 校验补漏（跨日订单、晚审单）
const EXPORT_AT = String(process.env.WDT_EXPORT_AT || '23:00,01:00')
  .split(/[,，]/).map((x) => x.trim()).filter((x) => /^\d{2}:\d{2}$/.test(x));
// 每次导出都取最近 N 天，靠幂等覆盖，不做增量裁剪 → 迟到单不会漏
const EXPORT_DAYS = Number(process.env.WDT_EXPORT_DAYS || 7);

const pad2 = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const hhmm = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

function loadMarks() {
  try { return JSON.parse(fs.readFileSync(DAY_MARK, 'utf8')); } catch { return {}; }
}
function saveMarks(m) {
  try { fs.mkdirSync(path.dirname(DAY_MARK), { recursive: true }); fs.writeFileSync(DAY_MARK, JSON.stringify(m, null, 2)); } catch { /* ignore */ }
}

function runExport() {
  if (!fs.existsSync(AHK) || !fs.existsSync(EXPORT_AHK)) return '缺少 RPA 组件';
  if (!fs.existsSync(COORD)) return '未校准坐标（先跑 npm run wdt:calibrate）';
  const to = today();
  const fromD = new Date(Date.now() - (EXPORT_DAYS - 1) * 86400000);
  const from = `${fromD.getFullYear()}-${pad2(fromD.getMonth() + 1)}-${pad2(fromD.getDate())}`;
  console.log(`[${now()}] 自动导出：${from} ~ ${to}（最近 ${EXPORT_DAYS} 天，重复只更新）`);
  const r = spawnSync(AHK, [EXPORT_AHK, from, to], { cwd: path.dirname(EXPORT_AHK), encoding: 'utf8', timeout: 240000 });
  console.log(`[${now()}] RPA 退出码 ${r.status}`);
  return r.status;
}

/** 导出完成后，把有数据的品牌×渠道各出一份日报，放 D://振颜丽舍//报表//日报//日期// */
function generateDailyReports(db) {
  const day = today();
  const fromD = new Date(Date.now() - (EXPORT_DAYS - 1) * 86400000);
  const from = `${fromD.getFullYear()}-${pad2(fromD.getMonth() + 1)}-${pad2(fromD.getDate())}`;
  let pairs = [];
  try {
    pairs = db.prepare(`SELECT DISTINCT COALESCE(brand,'') AS brand, group_name AS ch
      FROM sales_daily WHERE set_id = ? AND source = 'wdt' AND date >= ? AND COALESCE(brand,'') <> ''`)
      .all(SET_ID, from);
  } catch { return 0; }
  if (!pairs.length) return 0;
  const outDir = path.join(REPORT_DIR, day);
  fs.mkdirSync(outDir, { recursive: true });
  const gen = path.join(ROOT, 'tools', 'make-channel-daily.mjs');
  let n = 0;
  for (const p of pairs) {
    const out = path.join(outDir, `${p.brand}-${p.ch}-日报-${day}.xlsx`);
    const r = spawnSync(process.execPath, [gen, '--brand', p.brand, '--channel', p.ch,
      '--from', from, '--to', day, '--source', 'wdt', '--out', out], { cwd: ROOT, encoding: 'utf8' });
    if (r.status === 0) n += 1;
    else console.log(`[${now()}] 日报失败 ${p.brand}/${p.ch}: ${(r.stderr || '').slice(0, 120)}`);
  }
  console.log(`[${now()}] 已生成日报 ${n} 份 → ${outDir}`);
  return n;
}

function startScheduler(db) {
  let running = false;
  let lastFailAt = 0;
  const tick = () => {
    if (running) return;
    if (Date.now() - lastFailAt < 10 * 60 * 1000) return;   // 失败后 10 分钟再试，避免刷屏
    const day = today();
    const nowT = hhmm();
    const marks = loadMarks();
    const done = marks[day] || [];
    const due = EXPORT_AT.find((t) => !done.includes(t) && nowT >= t);
    if (!due) return;
    running = true;
    try {
      const r = runExport();
      if (typeof r !== 'number' || r !== 0) {
        lastFailAt = Date.now();
        console.log(`[${now()}] ${due} 批次未完成（${r}），10 分钟后再试`);
        return;
      }
      scan(db);                 // 先入库（幂等）
      generateDailyReports(db); // 再出日报，保证早上有文件
      marks[day] = [...done, due];
      saveMarks(marks);
      console.log(`[${now()}] ${due} 批次完成`);
    } catch (e) {
      lastFailAt = Date.now();
      console.log(`[${now()}] 自动导出失败：${e.message}`);
    } finally { running = false; }
  };
  console.log(`定时导出已启用：每天 ${EXPORT_AT.join(' / ')}（错过会补跑，重复只更新不新增）`);
  tick();
  setInterval(tick, 30000);
}

function main() {
  ensureDirs();
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  const cols = db.prepare('PRAGMA table_info(sales_daily)').all().map((c) => c.name);
  if (!cols.includes('brand')) {
    db.exec("ALTER TABLE sales_daily ADD COLUMN brand TEXT NOT NULL DEFAULT ''");
  }

  if (has('--watch')) {
    console.log(`监控中：${INBOX}（每 ${POLL_MS / 1000}s 扫描，Ctrl+C 结束）`);
    scan(db);
    setInterval(() => scan(db), POLL_MS);
    if (has('--auto-export')) startScheduler(db);
    return;
  }
  const r = scan(db);
  if (!r.scanned) console.log(`没有待处理文件（目录：${INBOX}）`);
  db.close();
}

main();
