/**
 * 财务端销售损益表（v2.0.0）
 *
 * 与销售端（sales_daily / wecom 口径）完全分离：本模块只服务财务部口径，
 * 收入取旺店通发货数据与平台账单，不拿销售端 GMV 换算。
 *
 * 核算链条（口径见 rules/finance-pnl-rules.md）：
 *   收入 − 成本 = 毛利
 *   毛利 − 推广费 − 平台扣点 − 物流费 − 其他直接支出 = 边界利润
 *   边界利润 − 人力成本 = 净利润
 *
 * 设计要点：
 *   1. 只存基础科目（fin_pnl_lines），派生指标一律实时算，避免「算好的数」被改脏；
 *   2. 每个科目带 basis（旺店通/万相台/账单/估算/工资表/样例），实际与估算分开存，
 *      报表时以实际为准并提示差异，不做加权平均；
 *   3. 自然键 (set_id, period, brand, channel, item)，重复导入只更新不新增。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, get, all, run, now } from './store.mjs';
import { unzipEntries } from './export.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SET_DEFAULT = 85;

const ok = (data, message = '') => ({ code: 0, message, data });
const fail = (message) => ({ code: 1, message, data: null });
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r6 = (v) => Math.round((Number(v) || 0) * 1e6) / 1e6;

/** 基础科目定义。派生科目不在此列。 */
export const ITEMS = {
  revenue_gross: { label: '收入总额', group: 'base' },
  refund: { label: '退款金额', group: 'base' },
  revenue: { label: '主营业务收入', group: 'base' },
  cost: { label: '成本', group: 'base' },
  ad_spend: { label: '推广费', group: 'variable' },
  platform_fee: { label: '平台扣点', group: 'variable' },
  logistics: { label: '物流费', group: 'variable' },
  other_direct: { label: '其他直接支出', group: 'variable' },
  labor_direct: { label: '直接人力成本', group: 'labor' },
  labor_shared: { label: '公摊人力成本', group: 'labor' },
  labor: { label: '人力成本（未拆分）', group: 'labor' },
};

const CHANNEL_ORDER = ['天猫', '抖音', '快手', '微信视频号', '京东自营', '小红书', '京东POP', '拼多多', '有赞', '分销（一件代发+批采）'];
const BRAND_CODE = { GJMY: '歌剧', DH: '世家', PF: 'PF' };
const BRAND_CODE_REV = { 歌剧: 'GJMY', 世家: 'DH', PF: 'PF' };
const BRAND_ORDER = ['歌剧', 'PF', '世家'];

/* ---------------- 表结构 ---------------- */

export function ensureFinanceTables() {
  try { db.exec('PRAGMA busy_timeout = 8000'); } catch { /* 忽略 */ }
  db.exec(`
CREATE TABLE IF NOT EXISTS fin_pnl_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  brand TEXT NOT NULL,
  channel TEXT NOT NULL,
  item TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  basis TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(set_id, period, brand, channel, item, basis)
);
CREATE INDEX IF NOT EXISTS idx_fin_pnl ON fin_pnl_lines(set_id, period, brand);

CREATE TABLE IF NOT EXISTS fin_pnl_sku (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL DEFAULT 0,
  revenue REAL NOT NULL DEFAULT 0,
  refund REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  basis TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(set_id, period, channel, sku)
);
`);
}

/* ---------------- 写入 ---------------- */

/** 批量写基础科目。同键只更新金额，不新增行。 */
export function upsertLines(setId, lines = [], { basis = '手工', sourceRef = '' } = {}) {
  ensureFinanceTables();
  let written = 0;
  for (const l of lines) {
    const period = String(l.period || '').trim();
    const brand = String(l.brand || '').trim();
    const channel = String(l.channel || '').trim();
    const item = String(l.item || '').trim();
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(period)) return fail(`期间格式不合法：${period}`);
    if (!brand || !channel) return fail(`缺少品牌或渠道：${brand}/${channel}`);
    if (!ITEMS[item]) return fail(`未知科目：${item}`);
    const amount = r2(l.amount);
    const exist = get(`SELECT id FROM fin_pnl_lines WHERE set_id = ? AND period = ? AND brand = ?
        AND channel = ? AND item = ? AND basis = ?`, setId, period, brand, channel, item, basis);
    if (exist) {
      run('UPDATE fin_pnl_lines SET amount = ?, source_ref = ?, note = ?, updated_at = ? WHERE id = ?',
        amount, sourceRef, String(l.note || ''), now(), exist.id);
    } else {
      run(`INSERT INTO fin_pnl_lines (set_id, period, brand, channel, item, amount, basis, source_ref, note,
          created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      setId, period, brand, channel, item, amount, basis, sourceRef, String(l.note || ''), now(), now());
    }
    written += 1;
  }
  return ok({ written }, `已写入 ${written} 条损益科目`);
}

/* ---------------- 读取与核算 ---------------- */

/** 同一科目若同时存在实际与估算，取「实际」类；返回 {amount, basis} */
const BASIS_RANK = { '旺店通': 1, '万相台': 1, '千川': 1, '千帆': 1, '京准通': 1, '账单': 1, '工资表': 1, '结算账单': 1, '手工': 2, '估算': 3, '损益表导入': 2 };
const pickActual = (rows) => {
  if (!rows.length) return { amount: 0, basis: '' };
  const sorted = [...rows].sort((a, b) => (BASIS_RANK[a.basis] ?? 9) - (BASIS_RANK[b.basis] ?? 9));
  return { amount: Number(sorted[0].amount), basis: sorted[0].basis };
};

/** 期间聚合：'2026-Q4' / '2026-10' / '2026-10-15' 都归一成月份数组 */
export function periodsOf(period) {
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q) {
    const y = Number(q[1]), n = Number(q[2]);
    return [1, 2, 3].map((i) => `${y}-${String((n - 1) * 3 + i).padStart(2, '0')}`);
  }
  if (/^\d{4}-\d{2}$/.test(period)) return [period];
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return [period.slice(0, 7)];
  return [];
}

function collectRows(setId, periods, brand) {
  const ph = periods.map(() => '?').join(',');
  const params = [setId, ...periods];
  let sql = `SELECT brand, channel, item, amount, basis, period FROM fin_pnl_lines
    WHERE set_id = ? AND substr(period, 1, 7) IN (${ph})`;
  if (brand) { sql += ' AND brand = ?'; params.push(brand); }
  return all(sql, ...params);
}

/** 由基础科目算出一条完整损益链 */
export function derive(items) {
  const revenue = r2(items.revenue || 0);
  const cost = r2(items.cost || 0);
  const gross = r2(revenue - cost);
  const variable = r2((items.ad_spend || 0) + (items.platform_fee || 0) + (items.logistics || 0) + (items.other_direct || 0));
  const boundary = r2(gross - variable);
  const labor = r2((items.labor || 0) + (items.labor_direct || 0) + (items.labor_shared || 0));
  const net = r2(boundary - labor);
  const ratio = (v) => (revenue ? r6(v / revenue) : null);
  return {
    revenue, cost, cost_ratio: ratio(cost),
    gross_profit: gross, gross_margin: ratio(gross),
    ad_spend: r2(items.ad_spend || 0), ad_ratio: ratio(items.ad_spend || 0),
    platform_fee: r2(items.platform_fee || 0), fee_ratio: ratio(items.platform_fee || 0),
    logistics: r2(items.logistics || 0), logistics_ratio: ratio(items.logistics || 0),
    other_direct: r2(items.other_direct || 0),
    variable_total: variable, variable_ratio: ratio(variable),
    boundary_profit: boundary, boundary_margin: ratio(boundary),
    labor_cost: labor, labor_ratio: ratio(labor),
    net_profit: net, net_margin: ratio(net),
    labor_split: items.labor ? '未拆分' : '已拆分',
  };
}

/**
 * 核算某期间（支持 2026-Q4 / 2026-10 / 2026-10-15）。
 * 返回按品牌分组的「渠道 × 科目」矩阵 + 各层合计，比率一律用汇总后的金额重算。
 */
export function computePnl(setId, { period, brand = '' } = {}) {
  ensureFinanceTables();
  const periods = periodsOf(String(period || ''));
  if (!periods.length) return fail(`期间不合法：${period}（示例 2026-10 / 2026-Q4 / 2026-10-15）`);
  const rows = collectRows(setId, periods, brand);
  if (!rows.length) return fail(`期间 ${period} 没有数据`);

  // brand → channel → item → [{amount,basis}]
  const bucket = new Map();
  for (const r of rows) {
    const b = bucket.get(r.brand) || new Map();
    const c = b.get(r.channel) || new Map();
    const i = c.get(r.item) || [];
    i.push({ amount: Number(r.amount), basis: r.basis });
    c.set(r.item, i);
    b.set(r.channel, c);
    bucket.set(r.brand, b);
  }

  const cellOf = (channelMap) => {
    const items = {};
    const bases = {};
    for (const [item, list] of channelMap) {
      const { amount, basis } = pickActual(list);
      items[item] = (items[item] || 0) + amount;
      if (basis) bases[item] = basis;
    }
    return { items, bases, ...derive(items) };
  };

  const brands = [];
  for (const [b, channels] of bucket) {
    const perChannel = {};
    const sumItems = {};
    for (const ch of CHANNEL_ORDER.concat([...channels.keys()].filter((x) => !CHANNEL_ORDER.includes(x)))) {
      if (!channels.has(ch)) continue;
      const cell = cellOf(channels.get(ch));
      if (!cell.revenue && !cell.cost && !cell.variable_total && !cell.labor_cost) continue;
      perChannel[ch] = cell;
      for (const [k, v] of Object.entries(cell.items)) sumItems[k] = (sumItems[k] || 0) + v;
    }
    brands.push({ brand: b, code: BRAND_CODE_REV[b] || '', channels: perChannel, total: { items: sumItems, ...derive(sumItems) } });
  }
  brands.sort((a, b) => {
    const ia = BRAND_ORDER.indexOf(a.brand), ib = BRAND_ORDER.indexOf(b.brand);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.brand.localeCompare(b.brand);
  });

  // 全品牌按渠道汇总（合计块）
  const allByChannel = {};
  const allItems = {};
  for (const b of brands) {
    for (const [ch, cell] of Object.entries(b.channels)) {
      const acc = allByChannel[ch] || { items: {} };
      for (const [k, v] of Object.entries(cell.items)) acc.items[k] = (acc.items[k] || 0) + v;
      allByChannel[ch] = acc;
    }
    for (const [k, v] of Object.entries(b.total.items)) allItems[k] = (allItems[k] || 0) + v;
  }
  const allChannels = {};
  for (const ch of CHANNEL_ORDER.concat(Object.keys(allByChannel).filter((x) => !CHANNEL_ORDER.includes(x)))) {
    if (!allByChannel[ch]) continue;
    allChannels[ch] = { items: allByChannel[ch].items, ...derive(allByChannel[ch].items) };
  }

  // 取数质量提示
  // 只报「完全没有这个科目」的硬缺口；值为 0 属业务可能，交 coverage() 单独确认
  const NEED = [['revenue', '收入'], ['cost', '成本'], ['ad_spend', '推广费'], ['platform_fee', '平台扣点'], ['logistics', '物流费'], ['labor', '人力成本']];
  const missing = [];
  for (const b of brands) {
    for (const [ch, cell] of Object.entries(b.channels)) {
      for (const [k, label] of NEED) {
        const present = ['labor_direct', 'labor_shared'].includes(k)
          ? ('labor' in cell.items)
          : (k in cell.items);
        if (!present) missing.push(`${b.brand}/${ch} 未取到${label}`);
      }
    }
  }

  return ok({
    period,
    months: periods,
    brands,
    all: { channels: allChannels, total: { items: allItems, ...derive(allItems) } },
    missing,
  }, `已核算 ${period}：${brands.length} 个品牌，${Object.keys(allChannels).length} 个渠道`);
}

/* ---------------- 报表输出（文本矩阵） ---------------- */

const fmt = (v) => (v === null || v === undefined || v === '' ? '' : r2(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v) => (v === null || v === undefined ? '' : `${(Number(v) * 100).toFixed(2)}%`);

/** 生成与模板一致的文本矩阵（供人工比对/终端查看） */
export function renderPnlText(data) {
  const out = [];
  const rows = [
    ['主营业务收入', 'revenue', 'ratio'],
    ['成本', 'cost', 'ratio'],
    ['毛利', 'gross_profit', 'gross_margin'],
    ['推广费', 'ad_spend', 'ratio'],
    ['平台扣点', 'platform_fee', 'ratio'],
    ['物流费', 'logistics', 'ratio'],
    ['其他直接支出', 'other_direct', 'ratio'],
    ['变动费用合计', 'variable_total', 'variable_ratio'],
    ['边界利润', 'boundary_profit', 'boundary_margin'],
    ['人力成本', 'labor_cost', 'labor_ratio'],
    ['净利润', 'net_profit', 'net_margin'],
  ];
  const blocks = [...data.brands.map((b) => ({ title: `${b.brand}（${b.code}）`, channels: b.channels, total: b.total })),
    { title: '全部品牌合计', channels: data.all.channels, total: data.all.total }];

  for (const blk of blocks) {
    const chs = Object.keys(blk.channels);
    out.push(`\n== ${data.period} ${blk.title}`);
    for (const [label, key, ratioKey] of rows) {
      const cells = chs.map((ch) => `${ch} ${fmt(blk.channels[ch][key])}${blk.channels[ch][ratioKey] !== null ? '(' + pct(blk.channels[ch][ratioKey]) + ')' : ''}`);
      out.push(`  ${label.padEnd(12)} 合计 ${fmt(blk.total[key]).padStart(12)}${blk.total[ratioKey] !== null ? '(' + pct(blk.total[ratioKey]) + ')' : ''}`);
      if (cells.length) out.push(`      ${cells.join('  ')}`);
    }
  }
  if (data.missing.length) {
    out.push(`\n取数缺口（${data.missing.length} 项）：`);
    for (const m of data.missing.slice(0, 20)) out.push(`  - ${m}`);
  }
  return out.join('\n');
}

/* ---------------- 从损益表 Excel 导入（验证基准 / 历史月份补录） ---------------- */

const decodeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');
const colIndex = (letters) => letters.split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

function sheetGrid(files, name) {
  const xml = files[name]?.toString('utf8');
  if (!xml) return [];
  const shared = [];
  for (const m of (files['xl/sharedStrings.xml']?.toString('utf8') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join(''));
  }
  const grid = [];
  for (const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rn = Number(rm[1]) - 1;
    const cells = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || '', inner = cm[2] || '';
      const L = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const idx = L ? colIndex(L) : cells.length;
      const t = /t="([^"]+)"/.exec(attrs)?.[1] || '';
      let val = '';
      if (t === 'inlineStr') val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join('');
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
        val = t === 's' ? (shared[Number(v)] ?? '') : decodeXml(v);
      }
      cells[idx] = val;
    }
    grid[rn] = Array.from(cells, (c) => (c == null ? '' : c));
  }
  return grid;
}

const numOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s === '-' || s === '/' || s.startsWith('#')) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// 收入与成本一律以 Sheet2 明细为准，这里只取费用类科目，避免 Sheet1 覆盖 Sheet2
const SHEET1_ITEM = {
  '推广费': 'ad_spend',
  '平台扣点': 'platform_fee',
  '物流费': 'logistics',
  '关税物流费': 'logistics',
  '其他直接支出': 'other_direct',
  '固定费用合计': 'labor',
  '人力成本': 'labor',
};

/**
 * 导入损益表工作簿。
 * - 收入/退款/成本 以 Sheet2「品牌渠道明细」为准（含收入总额与退款，可自校验）；
 * - 推广费/平台扣点/物流费/人力成本 取 Sheet1 品牌块；
 * - 派生行（毛利/变动费用合计/边界利润/经营利润）一律忽略，由引擎重算。
 */
export function importWorkbook(setId, buf, { period = '', basis = '损益表导入', sourceRef = '' } = {}) {
  ensureFinanceTables();
  const files = unzipEntries(buf);
  const names = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/sheet(\d+)/)[1]) - Number(b.match(/sheet(\d+)/)[1]));
  const s1 = sheetGrid(files, names[0]);
  const s2 = sheetGrid(files, names[1]);

  // 期间：优先用参数，其次取 Sheet1 第一个日期单元格（YYYY-MM）
  let per = String(period || '').trim();
  if (!per) {
    for (const row of s1.slice(0, 6)) {
      const hit = (row || []).find((c) => /^\d{4}-\d{2}$/.test(String(c).trim()));
      if (hit) { per = String(hit).trim(); break; }
    }
  }
  if (!/^\d{4}-\d{2}$/.test(per)) return fail(`无法确定期间，请用 --period=YYYY-MM 指定`);

  const lines = [];
  const push = (brand, channel, item, amount, note = '') => {
    if (amount === null || amount === undefined) return;
    lines.push({ period: per, brand, channel, item, amount, note });
  };

  // ---- Sheet2：收入 / 退款 / 成本 ----
  let s2n = 0;
  for (const row of s2) {
    const code = String(row?.[0] || '').trim();
    const ch = String(row?.[2] || '').trim();
    if (!BRAND_CODE[code]) continue;
    if (!ch || ch === '小计' || ch === '总计') continue;
    const brand = BRAND_CODE[code];
    const gross = numOrNull(row[3]);
    const refund = numOrNull(row[4]);
    const netRev = numOrNull(row[5]);
    const cost = numOrNull(row[6]);
    push(brand, ch, 'revenue_gross', gross);
    push(brand, ch, 'refund', refund);
    push(brand, ch, 'revenue', netRev ?? (gross !== null && refund !== null ? r2(gross - refund) : null));
    push(brand, ch, 'cost', cost);
    s2n += 1;
  }

  // ---- Sheet1：费用科目 ----
  let curBrand = '';
  let chCols = null;
  let s1n = 0;
  for (const row of s1) {
    const a = String(row?.[0] || '').trim();
    const block = /^[一二三四五六七八九]、(.+)$/.exec(a);
    if (block) {
      const code = /（([A-Z]+)）/.exec(block[1])?.[1] || '';
      curBrand = BRAND_CODE[code] || '';
      chCols = null;
      continue;
    }
    if (a === '费用科目') {
      chCols = {};
      for (let c = 2; c < (row || []).length; c++) {
        const v = String(row[c] || '').trim();
        if (v && v !== '合计' && !/实际金额|比率/.test(v)) chCols[c] = v;
      }
      continue;
    }
    if (!curBrand || !chCols) continue;
    const item = SHEET1_ITEM[a] || SHEET1_ITEM[Object.keys(SHEET1_ITEM).find((k) => a.startsWith(k)) || ''];
    if (!item) continue;
    for (const [c, ch] of Object.entries(chCols)) {
      const amt = numOrNull(row[Number(c)]);
      if (amt === null) continue;
      push(curBrand, ch, item, amt, a.includes('关税') ? '含关税' : '');
      s1n += 1;
    }
  }

  if (!lines.length) return fail('未从工作簿中取到任何科目数据');

  const res = upsertLines(setId, lines, { basis, sourceRef: sourceRef || `损益表 ${per}` });
  if (res.code !== 0) return res;
  return ok({
    period: per, lines: res.data.written, fromSheet2: s2n, fromSheet1: s1n,
    channels: [...new Set(lines.map((l) => l.channel))],
    brands: [...new Set(lines.map((l) => l.brand))],
  }, `已导入 ${per} 损益科目 ${res.data.written} 条（明细 ${s2n} 行 / 费用 ${s1n} 条）`);
}

/* ---------------- 与模板逐项核对 ---------------- */

/** 用工作簿自身的派生行（毛利/变动费用合计/边界利润/经营利润）校验引擎重算结果 */
export function checkAgainstWorkbook(setId, buf, { period = '' } = {}) {
  const files = unzipEntries(buf);
  const names = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/sheet(\d+)/)[1]) - Number(b.match(/sheet(\d+)/)[1]));
  const s1 = sheetGrid(files, names[0]);
  let per = String(period || '').trim();
  if (!per) {
    for (const row of s1.slice(0, 6)) {
      const hit = (row || []).find((c) => /^\d{4}-\d{2}$/.test(String(c).trim()));
      if (hit) { per = String(hit).trim(); break; }
    }
  }
  const computed = computePnl(setId, { period: per });
  if (computed.code !== 0) return computed;
  const byBrand = new Map(computed.data.brands.map((b) => [b.brand, b]));

  const CHECK = { 毛利: 'gross_profit', 变动费用合计: 'variable_total', 边界利润: 'boundary_profit', 经营利润: 'net_profit' };
  const diffs = [];
  let curBrand = '';
  let chCols = null;
  for (const row of s1) {
    const a = String(row?.[0] || '').trim();
    const block = /^[一二三四五六七八九]、(.+)$/.exec(a);
    if (block) {
      const code = /（([A-Z]+)）/.exec(block[1])?.[1] || '';
      curBrand = BRAND_CODE[code] || '';
      chCols = null;
      continue;
    }
    if (a === '费用科目') {
      chCols = {};
      for (let c = 2; c < (row || []).length; c++) {
        const v = String(row[c] || '').trim();
        if (v && v !== '合计' && !/实际金额|比率/.test(v)) chCols[c] = v;
      }
      continue;
    }
    const key = CHECK[a];
    if (!key || !curBrand || !chCols) continue;
    const b = byBrand.get(curBrand);
    for (const [c, ch] of Object.entries(chCols)) {
      const expect = numOrNull(row[Number(c)]);
      if (expect === null) continue;
      const got = b?.channels?.[ch]?.[key];
      if (got === undefined) {
        if (Math.abs(expect) < 0.005) continue;          // 模板为 0、引擎无该渠道 → 视为一致
        diffs.push({ brand: curBrand, channel: ch, item: a, expect, got: null, delta: null });
        continue;
      }
      if (Math.abs(expect) < 0.005 && Math.abs(Number(got)) < 0.005) continue;
      const delta = r2(got - expect);
      if (Math.abs(delta) > 0.02) diffs.push({ brand: curBrand, channel: ch, item: a, expect, got, delta });
    }
  }
  return ok({ period: per, diffCount: diffs.length, diffs },
    diffs.length ? `${per} 与模板有 ${diffs.length} 处差异` : `${per} 与模板逐项一致`);
}

/* ---------------- 取数缺口清单 ---------------- */

/** 按模板要求的渠道×科目，列出当前期间还缺哪些取数 */
export function coverage(setId, { period } = {}) {
  ensureFinanceTables();
  const periods = periodsOf(String(period || ''));
  if (!periods.length) return fail(`期间不合法：${period}`);
  const rows = all(`SELECT brand, channel, item, basis, amount FROM fin_pnl_lines
    WHERE set_id = ? AND substr(period, 1, 7) IN (${periods.map(() => '?').join(',')})`, setId, ...periods);
  if (!rows.length) return fail(`期间 ${period} 没有数据`);

  const need = ['revenue', 'cost', 'ad_spend', 'platform_fee', 'logistics', 'labor'];
  const keys = new Map();
  for (const r of rows) keys.set(`${r.brand}|${r.channel}`, { brand: r.brand, channel: r.channel });
  const gaps = [];
  const zeros = [];
  for (const { brand, channel } of keys.values()) {
    for (const item of need) {
      const hit = rows.find((r) => r.brand === brand && r.channel === channel && r.item === item);
      if (!hit) gaps.push({ brand, channel, item, label: ITEMS[item].label, kind: 'missing' });
      else if (!Number(hit.amount)) zeros.push({ brand, channel, item, label: ITEMS[item].label, kind: 'zero' });
    }
  }
  const byBasis = all(`SELECT basis, COUNT(*) n, ROUND(SUM(amount), 2) amount FROM fin_pnl_lines
    WHERE set_id = ? AND substr(period, 1, 7) IN (${periods.map(() => '?').join(',')})
    GROUP BY basis ORDER BY n DESC`, setId, ...periods);
  return ok({ period, gaps, zeros, byBasis },
    gaps.length
      ? `${period} 有 ${gaps.length} 项未取到，另有 ${zeros.length} 项为 0（需确认是真 0 还是没取到）`
      : `${period} 取数完整${zeros.length ? `，其中 ${zeros.length} 项为 0` : ''}`);
}
