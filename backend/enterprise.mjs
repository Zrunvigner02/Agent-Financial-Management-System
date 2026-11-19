/**
 * 企业内部助手扩展骨架：销售/运营/分销/工作汇报/文档检索。
 *
 * 阶段说明（v1.7.0）：
 *  - 已实现：渠道与门店维护、日销售查询、工作汇报读写、文档入库与检索（LIKE，带出处）
 *  - 占位：销售/运营/分销的批量导入（返回 pending，等模板确定后接）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, all, run, now } from './store.mjs';
import * as life from './lifecycle.mjs';
import { xlsToTable } from './xls.mjs';
import { recognize as ocrRecognize } from './ocr.mjs';

const ok = (data, message = '') => ({ code: 0, message, data });
const fail = (message) => ({ code: 1, message, data: null });
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------------- 渠道 / 店铺 ---------------- */

export function listChannels(setId, { source = '' } = {}) {
  const rows = source
    ? all('SELECT * FROM sales_channels WHERE set_id = ? AND source = ? ORDER BY id', setId, source)
    : all('SELECT * FROM sales_channels WHERE set_id = ? ORDER BY active DESC, id', setId);
  return ok({
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id, name: r.name, platform: r.platform, shop_code: r.shop_code,
      source: r.source, active: Boolean(r.active),
    })),
  });
}

export function saveChannel(setId, data = {}) {
  const name = String(data.name || '').trim();
  if (!name) return fail('请给出店铺/渠道名称');
  const source = ['sales_dept', 'wdt'].includes(data.source) ? data.source : 'sales_dept';
  const exist = get('SELECT * FROM sales_channels WHERE set_id = ? AND name = ?', setId, name);
  if (exist) {
    run('UPDATE sales_channels SET platform = ?, shop_code = ?, source = ?, active = ? WHERE id = ?',
      String(data.platform || exist.platform), String(data.shop_code || exist.shop_code),
      source, data.active === false ? 0 : 1, exist.id);
    return ok({ id: exist.id }, `已更新渠道「${name}」`);
  }
  const info = run(`INSERT INTO sales_channels (set_id, name, platform, shop_code, source, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, setId, name, String(data.platform || ''), String(data.shop_code || ''),
  source, data.active === false ? 0 : 1, now());
  return ok({ id: Number(info.lastInsertRowid) }, `已新增渠道「${name}」（口径：${source === 'wdt' ? '旺店通' : '销售部'}）`);
}

/* ---------------- 销售日数据 ---------------- */

/** 销售表的扩展列（老库由导入脚本逐步补上，新库在这里兜底） */
let salesColsReady = false;
function ensureSalesCols() {
  if (salesColsReady) return;
  const cols = all('PRAGMA table_info(sales_daily)').map((c) => c.name);
  if (!cols.includes('staff')) run("ALTER TABLE sales_daily ADD COLUMN staff TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('group_name')) run("ALTER TABLE sales_daily ADD COLUMN group_name TEXT NOT NULL DEFAULT ''");
  // 品牌维度：旺店通导入时写入（德国世家 / PF79 / 歌剧魅影）
  if (!cols.includes('brand')) run("ALTER TABLE sales_daily ADD COLUMN brand TEXT NOT NULL DEFAULT ''");
  salesColsReady = true;
}

export function listSales(setId, { from = '', to = '', source = '', product = '', staff = '', limit = 200 } = {}) {
  ensureSalesCols();
  const where = ['set_id = ?'];
  const params = [setId];
  if (from) { where.push('date >= ?'); params.push(from); }
  if (to) { where.push('date <= ?'); params.push(to); }
  if (source) { where.push('source = ?'); params.push(source); }
  if (product) { where.push('product LIKE ?'); params.push(`%${product}%`); }
  if (staff) { where.push("COALESCE(staff,'') = ?"); params.push(staff); }
  const rows = all(`SELECT * FROM sales_effective WHERE ${where.join(' AND ')}
    ORDER BY date DESC, id DESC LIMIT ?`, ...params, Math.min(5000, Number(limit) || 200));
  const sum = rows.reduce((s, r) => ({
    qty: s.qty + Number(r.qty || 0),
    amount: s.amount + Number(r.amount || 0),
    return_amount: s.return_amount + Number(r.return_amount || 0),
  }), { qty: 0, amount: 0, return_amount: 0 });
  return ok({
    count: rows.length,
    total: { qty: sum.qty, amount: money(sum.amount), return_amount: money(sum.return_amount) },
    items: rows.map((r) => ({
      id: r.id, date: r.date, product: r.product, sku: r.sku,
      qty: r.qty, amount: money(r.amount), return_qty: r.return_qty,
      return_amount: money(r.return_amount), cost: money(r.cost),
      fee: money(r.fee), gross_profit: money(r.gross_profit), net_profit: money(r.net_profit),
      group_name: r.group_name || '', staff: r.staff || '', source: r.source,
    })),
  });
}

/**
 * 按天聚合的销售序列（趋势图专用）
 *
 * 与 listSales 的区别：这里在库里 GROUP BY date 汇总，一天一行。
 * 目的：趋势图要能翻看历史、缩放、拖动，客户端需要"整段区间"的连续序列；
 * 若用 listSales 取原始行，31 天×多渠道就上百行，一年上万行会直接撞 limit。
 *
 * 返回同时带 min_date / max_date（全库覆盖范围，不受 from/to 影响），
 * 前端据此决定"能不能继续往前拖"。
 */
export function salesDaily(setId, { from = '', to = '', source = '' } = {}) {
  const where = ['set_id = ?'];
  const params = [setId];
  if (from) { where.push('date >= ?'); params.push(from); }
  if (to) { where.push('date <= ?'); params.push(to); }
  if (source) { where.push('source = ?'); params.push(source); }

  const cov = get(`SELECT MIN(date) AS min_date, MAX(date) AS max_date, COUNT(*) AS n
    FROM sales_daily WHERE set_id = ?${source ? ' AND source = ?' : ''}`,
  ...(source ? [setId, source] : [setId]));

  const rows = all(`SELECT date,
      COALESCE(SUM(amount), 0) AS amount,
      COALESCE(SUM(return_amount), 0) AS ret,
      COALESCE(SUM(fee), 0) AS fee,
      COALESCE(SUM(net_profit), 0) AS net,
      COUNT(*) AS cnt
    FROM sales_effective WHERE ${where.join(' AND ')}
    GROUP BY date ORDER BY date`, ...params);

  return ok({
    min_date: cov?.min_date || '',
    max_date: cov?.max_date || '',
    total_rows: Number(cov?.n || 0),
    days: rows.length,
    items: rows.map((r) => ({
      date: r.date,
      amount: money(r.amount),
      return_amount: money(r.ret),
      fee: money(r.fee),
      net_profit: money(r.net),
      cnt: Number(r.cnt || 0),
    })),
  });
}

/**
 * 目前支持直接传 rows，模板映射与截图解析在后续版本接入。
 */
export function importSales(setId, { rows = [], source = 'sales_dept', date = '' } = {}) {
  if (!Array.isArray(rows) || !rows.length) return fail('没有可导入的行');
  const src = ['sales_dept', 'wdt'].includes(source) ? source : 'sales_dept';
  let inserted = 0;
  let skipped = 0;
  const errors = [];
  const seen = new Set();
  for (const [i, r] of rows.entries()) {
    const d = String(r.date || date || '').slice(0, 10);
    if (!DATE_RE.test(d)) { errors.push(`第 ${i + 1} 行日期不合法`); continue; }
    if (!r.product && !r.sku) { errors.push(`第 ${i + 1} 行缺少商品名或 SKU`); continue; }
    const prod = resolveProduct(setId, { sku: r.sku, product: r.product });
    const qty = Number(r.qty || 0);
    const amount = money(r.amount);
    const returnAmount = money(r.return_amount);
    const cost = money(r.cost != null ? r.cost : (prod ? Number(prod.unit_cost || 0) * qty : 0));
    const fee = money(r.fee != null ? r.fee : 0);
    const gross = money(amount - returnAmount - cost);
    const net = money(gross - fee);
    const sku = String(prod?.sku || r.sku || '');
    const product = String(prod?.name || r.product || '');
    // 去重：同账套 + 同日期 + 同商品/SKU + 同销售额/退货额，视为重复（跨来源也算），跳过
    const key = [d, sku, product, amount, returnAmount].join('|');
    if (seen.has(key)) { skipped += 1; continue; }
    const dup = get(`SELECT id FROM sales_daily WHERE set_id = ? AND date = ?
      AND COALESCE(sku,'') = ? AND COALESCE(product,'') = ? AND amount = ? AND return_amount = ? LIMIT 1`,
    setId, d, sku, product, amount, returnAmount);
    if (dup) { skipped += 1; seen.add(key); continue; }
    seen.add(key);
    run(`INSERT INTO sales_daily (set_id, channel_id, date, sku, product, group_name, qty, amount, return_qty, return_amount,
        cost, fee, gross_profit, net_profit, source, batch_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    setId, Number(r.channel_id || 0), d, sku, product,
    String(prod?.group_name || ''), qty, amount, Number(r.return_qty || 0), returnAmount,
    cost, fee, gross, net, src, now());
    inserted += 1;
  }
  if (!inserted) {
    if (skipped) return ok({ inserted, skipped, errors }, `全部 ${skipped} 行为重复数据，已跳过（未重复入库）`);
    return fail(`全部未导入：${errors[0] || '格式不符'}`);
  }
  return ok({ inserted, skipped, errors },
    `已导入 ${inserted} 行${skipped ? `，跳过重复 ${skipped} 行` : ''}${errors.length ? `，${errors.length} 行有问题` : ''}`);
}

/* ---------------- 运营花费 / 分销 ---------------- */

export function listOpsSpend(setId, { from = '', to = '', limit = 200 } = {}) {
  const where = ['set_id = ?'];
  const params = [setId];
  if (from) { where.push('date >= ?'); params.push(from); }
  if (to) { where.push('date <= ?'); params.push(to); }
  const rows = all(`SELECT * FROM ops_spend WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC LIMIT ?`,
    ...params, Math.min(1000, Number(limit) || 200));
  return ok({ count: rows.length, total: money(rows.reduce((s, r) => s + Number(r.amount || 0), 0)),
    items: rows.map((r) => ({ id: r.id, date: r.date, channel: r.channel, metric: r.metric, amount: money(r.amount), note: r.note })) });
}

export function listDistribution(setId, { from = '', to = '', limit = 200 } = {}) {
  const where = ['set_id = ?'];
  const params = [setId];
  if (from) { where.push('date >= ?'); params.push(from); }
  if (to) { where.push('date <= ?'); params.push(to); }
  const rows = all(`SELECT * FROM distribution_sales WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC LIMIT ?`,
    ...params, Math.min(1000, Number(limit) || 200));
  return ok({
    count: rows.length,
    total: money(rows.reduce((s, r) => s + Number(r.amount || 0), 0)),
    items: rows.map((r) => ({ id: r.id, distributor_id: r.distributor_id, date: r.date, qty: r.qty, amount: money(r.amount), return_amount: money(r.return_amount) })),
  });
}

/* ---------------- 工作汇报 ---------------- */

export function addWorkReport(setId, data = {}) {
  const author = String(data.author || '').trim();
  const content = String(data.content || '').trim();
  if (!author) return fail('请给出汇报人');
  if (!content) return fail('汇报内容不能为空');
  const period = String(data.period || new Date().toLocaleDateString('sv-SE')).slice(0, 10);
  const kind = ['daily', 'weekly', 'monthly'].includes(data.kind) ? data.kind : 'daily';
  const info = run(`INSERT INTO work_reports (set_id, author, dept, period, kind, content, metrics, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, setId, author, String(data.dept || ''), period, kind,
  content, JSON.stringify(data.metrics || {}), now());
  return ok({ id: Number(info.lastInsertRowid), author, period, kind }, `已记录 ${author} 的汇报`);
}

export function listWorkReports(setId, { period = '', author = '', kind = '', limit = 50 } = {}) {
  const where = ['set_id = ?'];
  const params = [setId];
  if (period) { where.push('period = ?'); params.push(period); }
  if (author) { where.push('author = ?'); params.push(author); }
  if (kind) { where.push('kind = ?'); params.push(kind); }
  const rows = all(`SELECT * FROM work_reports WHERE ${where.join(' AND ')} ORDER BY period DESC, id DESC LIMIT ?`,
    ...params, Math.min(200, Number(limit) || 50));
  return ok({
    count: rows.length,
    items: rows.map((r) => ({ id: r.id, author: r.author, dept: r.dept, period: r.period, kind: r.kind, content: r.content, created_at: r.created_at })),
  });
}

/* ---------------- 文档库（RAG 一期：分块 + 关键词检索 + 出处） ---------------- */

const chunk = (text, size = 300) => {
  const clean = String(text || '').replace(/\r/g, '').trim();
  if (!clean) return [];
  const parts = clean.split(/\n{2,}/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length <= size) { out.push(p); continue; }
    for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
  }
  return out.slice(0, 200);
};

export function addDoc(setId, data = {}) {
  const title = String(data.title || '').trim();
  const content = String(data.content || '').trim();
  if (!title) return fail('文档要有标题');
  if (!content) return fail('文档内容为空');
  const exist = get('SELECT * FROM docs WHERE set_id = ? AND title = ?', setId, title);
  const t = now();
  let id;
  if (exist) {
    id = exist.id;
    run(`UPDATE docs SET category=?, dept=?, source=?, effective_from=?, content=?, updated_at=? WHERE id=?`,
      String(data.category || exist.category), String(data.dept || exist.dept), String(data.source || exist.source),
      String(data.effective_from || exist.effective_from), content, t, id);
    run('DELETE FROM doc_chunks WHERE doc_id = ?', id);
  } else {
    const info = run(`INSERT INTO docs (set_id, title, category, dept, source, effective_from, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, setId, title, String(data.category || ''), String(data.dept || ''),
    String(data.source || ''), String(data.effective_from || ''), content, t, t);
    id = Number(info.lastInsertRowid);
  }
  const parts = chunk(content);
  parts.forEach((text, i) => run('INSERT INTO doc_chunks (doc_id, seq, text) VALUES (?, ?, ?)', id, i, text));
  return ok({ id, chunks: parts.length }, `已入库「${title}」，切 ${parts.length} 段`);
}

export function searchDocs(setId, { q = '', limit = 5 } = {}) {
  const key = String(q || '').trim();
  if (!key) return fail('请给出要检索的关键词');
  const rows = all(`SELECT c.*, d.title, d.category, d.effective_from FROM doc_chunks c
    JOIN docs d ON d.id = c.doc_id
    WHERE d.set_id = ? AND c.text LIKE ? ORDER BY d.updated_at DESC, c.seq LIMIT ?`,
  setId, `%${key}%`, Math.min(20, Number(limit) || 5));
  const items = rows.map((r) => {
    const idx = r.text.indexOf(key);
    const start = Math.max(0, idx - 60);
    return {
      doc_id: r.doc_id, title: r.title, category: r.category, effective_from: r.effective_from,
      snippet: (start > 0 ? '…' : '') + r.text.slice(start, start + 200) + (start + 200 < r.text.length ? '…' : ''),
      ref: `${r.title} #${r.seq + 1}`,
    };
  });
  return ok({ count: items.length, items, note: items.length ? '' : '文档库里没有匹配内容' });
}

export function listDocs(setId, { limit = 50 } = {}) {
  const rows = all('SELECT id, title, category, dept, effective_from, updated_at FROM docs WHERE set_id = ? ORDER BY updated_at DESC LIMIT ?',
    setId, Math.min(200, Number(limit) || 50));
  return ok({ count: rows.length, items: rows });
}

/* ---------------- 商品主数据 + 别名（第 3 项） ---------------- */

export function saveProduct(setId, data = {}) {
  const sku = String(data.sku || '').trim();
  const name = String(data.name || '').trim();
  if (!sku) return fail('请给出 SKU（建议用旺店通商家编码）');
  if (!name) return fail('请给出商品名称');
  const exist = get('SELECT * FROM products WHERE set_id = ? AND sku = ?', setId, sku);
  const t = now();
  if (exist) {
    run(`UPDATE products SET name=?, group_name=?, spec=?, unit_cost=?, active=?, updated_at=? WHERE id=?`,
      name, String(data.group_name ?? exist.group_name), String(data.spec ?? exist.spec),
      money(data.unit_cost ?? exist.unit_cost), data.active === false ? 0 : 1, t, exist.id);
    if (data.alias) addAlias(setId, data.alias, sku);
    return ok({ id: exist.id, sku }, `已更新商品 ${sku}`);
  }
  const info = run(`INSERT INTO products (set_id, sku, name, group_name, spec, unit_cost, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, setId, sku, name, String(data.group_name || ''),
  String(data.spec || ''), money(data.unit_cost), data.active === false ? 0 : 1, t, t);
  if (data.alias) addAlias(setId, data.alias, sku);
  return ok({ id: Number(info.lastInsertRowid), sku }, `已新增商品 ${name}（${sku}）`);
}

export function addAlias(setId, alias, sku) {
  const a = String(alias || '').trim();
  const k = String(sku || '').trim();
  if (!a || !k) return fail('别名与 SKU 都要有');
  run(`INSERT INTO product_aliases (set_id, alias, sku) VALUES (?, ?, ?)
       ON CONFLICT(set_id, alias) DO UPDATE SET sku = excluded.sku`, setId, a, k);
  return ok({ alias: a, sku: k }, `别名「${a}」→ ${k}`);
}

export function listProducts(setId, { group_name = '', active = '', limit = 200 } = {}) {
  const where = ['set_id = ?'];
  const params = [setId];
  if (group_name) { where.push('group_name = ?'); params.push(group_name); }
  if (active !== '') { where.push('active = ?'); params.push(Number(active) ? 1 : 0); }
  const rows = all(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY group_name, sku LIMIT ?`,
    ...params, Math.min(1000, Number(limit) || 200));
  return ok({
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id, sku: r.sku, name: r.name, group_name: r.group_name,
      spec: r.spec, unit_cost: money(r.unit_cost), active: Boolean(r.active),
    })),
  });
}

/** 商品名/别名 → SKU + 分组 + 单位成本 */
function resolveProduct(setId, { sku = '', product = '' } = {}) {
  const k = String(sku || '').trim();
  const name = String(product || '').trim();
  let row = k ? get('SELECT * FROM products WHERE set_id = ? AND sku = ?', setId, k) : null;
  if (!row && name) {
    row = get('SELECT * FROM products WHERE set_id = ? AND name = ?', setId, name);
    if (!row) {
      const alias = get('SELECT sku FROM product_aliases WHERE set_id = ? AND alias = ?', setId, name);
      if (alias) row = get('SELECT * FROM products WHERE set_id = ? AND sku = ?', setId, alias.sku);
    }
  }
  return row || null;
}

/* ---------------- 双口径对比（第 2 项） ---------------- */

export function salesCompare(setId, { from = '', to = '', level = 'product' } = {}) {
  const where = ['set_id = ?'];
  const params = [setId];
  if (from) { where.push('date >= ?'); params.push(from); }
  if (to) { where.push('date <= ?'); params.push(to); }
  const rows = all(`SELECT * FROM sales_effective WHERE ${where.join(' AND ')}`, ...params);
  const keyOf = (r) => (level === 'date' ? r.date : level === 'channel' ? String(r.channel_id) : (r.sku || r.product || '未归类'));
  const bucket = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!bucket.has(k)) bucket.set(k, { key: k, label: k, sales_dept: 0, wdt: 0, qty_dept: 0, qty_wdt: 0 });
    const b = bucket.get(k);
    if (r.source === 'wdt') { b.wdt += Number(r.amount || 0); b.qty_wdt += Number(r.qty || 0); }
    else { b.sales_dept += Number(r.amount || 0); b.qty_dept += Number(r.qty || 0); }
  }
  const items = [...bucket.values()].map((b) => {
    const diff = money(b.sales_dept - b.wdt);
    const base = b.wdt || b.sales_dept;
    return {
      ...b, sales_dept: money(b.sales_dept), wdt: money(b.wdt),
      diff, diff_rate: base ? Number(((diff / base) * 100).toFixed(1)) : 0,
    };
  }).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const totalDept = money(items.reduce((s2, x) => s2 + x.sales_dept, 0));
  const totalWdt = money(items.reduce((s2, x) => s2 + x.wdt, 0));
  return ok({
    from, to, level, total: { sales_dept: totalDept, wdt: totalWdt, diff: money(totalDept - totalWdt) },
    count: items.length, items,
    note: items.length ? '' : '所选区间没有数据，先导入销售日数据',
  });
}

/* ---------------- 销售文件解析（CSV / Excel / 图片 OCR） ---------------- */

const HEAD_ALIAS = {
  date: ['日期', '销售日期', 'date', '时间', '交易日期'],
  product: ['商品', '商品名称', '产品', '产品名称', '名称', 'product', '宝贝'],
  sku: ['sku', '编码', '货号', '商品编码', '商家编码'],
  qty: ['数量', '销量', '销售数量', 'qty', '件数'],
  amount: ['销售额', '金额', '销售金额', '收入', 'amount', '成交金额'],
  return_qty: ['退货数量', '退款数量', 'return_qty', '退件数'],
  return_amount: ['退货金额', '退款金额', '退款', '退货', 'return_amount', '退款总额'],
  cost: ['成本', '商品成本', '成本金额', 'cost'],
  fee: ['费用', '平台费用', '平台费', '服务费', '佣金', 'fee', '推广费'],
  channel: ['渠道', '店铺', '平台', 'channel', '店铺名称'],
};

function normDate(v) {
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}

function normNum(v) {
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[¥,，\s元]/g, '').replace(/%$/, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function splitCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((x) => String(x).trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => String(x).trim() !== '')) rows.push(row);
  return rows;
}

function mapTable(columns, tableRows) {
  const fieldOf = {};
  for (const c of columns) {
    const label = String(c.label || '').toLowerCase().trim();
    for (const [field, aliases] of Object.entries(HEAD_ALIAS)) {
      if (fieldOf[field]) continue;
      if (aliases.some((a) => label === a.toLowerCase() || label.includes(a.toLowerCase()))) fieldOf[field] = c.key;
    }
  }
  const rows = [];
  for (const r of tableRows) {
    const o = {};
    for (const [field, key] of Object.entries(fieldOf)) o[field] = r[key];
    const mapped = {
      date: normDate(o.date), product: String(o.product || '').trim(), sku: String(o.sku || '').trim(),
      qty: normNum(o.qty), amount: normNum(o.amount), return_qty: normNum(o.return_qty),
      return_amount: normNum(o.return_amount), cost: normNum(o.cost), fee: normNum(o.fee),
      channel: String(o.channel || '').trim(),
    };
    if (!mapped.date || (!mapped.product && !mapped.sku)) continue;
    rows.push(mapped);
  }
  return { rows, fields: Object.keys(fieldOf) };
}

export async function parseSalesUpload({ name = '', dataBase64 = '' } = {}) {
  if (!dataBase64) return fail('没有收到文件内容');
  const ext = String(name).split('.').pop().toLowerCase();
  let buf;
  try { buf = Buffer.from(String(dataBase64).replace(/^data:[^;]+;base64,/, ''), 'base64'); }
  catch { return fail('文件解码失败'); }
  try {
    if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
      const text = buf.toString('utf8').replace(/^\uFEFF/, '');
      const grid = splitCsv(text);
      const head = grid[0] || [];
      const columns = head.map((h, i) => ({ key: `c${i}`, label: String(h || `列${i + 1}`) }));
      const tableRows = grid.slice(1).map((r) => { const o = {}; r.forEach((v, i) => { o[`c${i}`] = v; }); return o; });
      const { rows, fields } = mapTable(columns, tableRows);
      return ok({ kind: 'table', ext, columns, rows, fields, count: rows.length, text: text.slice(0, 4000) });
    }
    if (ext === 'xlsx' || ext === 'xls') {
      const t = xlsToTable(buf, 800);
      if (!t || !t.table) return fail('Excel 里没有解析到表格');
      const { rows, fields } = mapTable(t.table.columns, t.table.rows);
      return ok({ kind: 'table', ext, columns: t.table.columns, rows, fields, count: rows.length, sheet: t.sheet });
    }
    if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) {
      const tmp = path.join(os.tmpdir(), `zd-sales-${Date.now()}.${ext}`);
      fs.writeFileSync(tmp, buf);
      let r;
      try { r = await ocrRecognize(tmp, { ext }); } finally { try { fs.unlinkSync(tmp); } catch {} }
      const text = String(r && (r.text || r.content) || '').trim();
      return ok({ kind: 'text', ext, rows: [], count: 0, text: text.slice(0, 6000) });
    }
    return fail(`不支持的文件类型：.${ext}`);
  } catch (e) {
    return fail(`解析失败：${e.message}`);
  }
}

/* ---------------- 数据归集台账 ---------------- */
export function listIntake(setId, { from = '', to = '', category = '', source = '', limit = 200 } = {}) {
  try {
    const where = ['set_id = ?'];
    const params = [setId];
    if (from) { where.push('doc_date >= ?'); params.push(from); }
    if (to) { where.push('doc_date <= ?'); params.push(to); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (source) { where.push('source = ?'); params.push(source); }
    const rows = all(`SELECT * FROM data_intake WHERE ${where.join(' AND ')}
      ORDER BY doc_date DESC, id DESC LIMIT ?`, ...params, Math.min(1000, Number(limit) || 200));
    return ok({ count: rows.length, items: rows });
  } catch (e) {
    return ok({ count: 0, items: [], note: `数据归集表尚未建立：${e.message}` });
  }
}

/* ---------------- 员工-渠道归属映射 ---------------- */
export function setStaffMap(setId, { rows = [] } = {}) {
  ensureSalesCols();
  if (!Array.isArray(rows) || !rows.length) return fail('没有收到归属数据');
  let updated = 0;
  const done = [];
  for (const r of rows) {
    const ch = String(r.channel || r.group_name || r['渠道'] || '').trim();
    const st = String(r.staff || r.name || r['员工'] || '').trim();
    if (!ch || !st) continue;
    const info = run('UPDATE sales_daily SET staff = ? WHERE set_id = ? AND group_name = ?', st, setId, ch);
    updated += Number(info.changes || 0);
    done.push(`${ch}→${st}`);
  }
  return updated
    ? ok({ updated, mapping: done }, `已为 ${updated} 条销售记录绑定员工（${done.join('、')}）`)
    : fail('没有匹配到可更新的记录，请确认渠道名与销售数据一致');
}

/**
 * 某日/某区间是否已经入过库（给智能体判断"要不要再录"用）
 * 返回每天每渠道每品牌的条数与金额，以及 covered 标记。
 */
export function salesDayStatus(setId, { date = '', from = '', to = '' } = {}) {
  ensureSalesCols();
  const f = String(date || from || '').slice(0, 10);
  const t = String(date || to || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return fail('请给出日期（YYYY-MM-DD）或 from/to 区间');
  }
  const rows = all(`SELECT date, COALESCE(group_name,'') AS channel, COALESCE(brand,'') AS brand,
      source, COUNT(*) AS n, ROUND(SUM(amount),2) AS amount, MAX(created_at) AS updated_at
    FROM sales_daily WHERE set_id = ? AND date >= ? AND date <= ?
    GROUP BY date, channel, brand, source ORDER BY date DESC, amount DESC`, setId, f, t);
  const days = [...new Set(rows.map((r) => r.date))];
  return ok({
    from: f, to: t,
    covered: days.length > 0,
    days,
    count: rows.length,
    total: money(rows.reduce((a, r) => a + Number(r.amount || 0), 0)),
    items: rows,
    note: days.length
      ? `已有数据：${days.length} 天、${rows.length} 组（日期×渠道×品牌）；重复导入只会更新，不会新增`
      : '该区间库里没有数据',
  });
}

export function staffSummary(setId) {
  ensureSalesCols();
  // 业绩口径：停用日之后的销售不计入本人业绩，但原始行一行不删（历史报表照旧可查）
  const rows = all(`SELECT COALESCE(staff,'') AS staff, date, amount
    FROM sales_effective WHERE set_id = ?`, setId);
  const okDay = life.dayFilter(setId, 'staff');
  const stops = life.stoppedMap(setId, 'staff');
  const map = new Map();
  for (const r of rows) {
    const name = r.staff || '';
    if (name && !okDay(name, r.date)) continue;
    const o = map.get(name) || { staff: name, n: 0, amount: 0 };
    o.n += 1;
    o.amount += Number(r.amount || 0);
    map.set(name, o);
  }
  const items = [...map.values()]
    .map((o) => ({ ...o, amount: Math.round(o.amount * 100) / 100, stopped_at: stops.get(o.staff) || '' }))
    .sort((a, b) => b.amount - a.amount);
  return ok({
    items,
    note: '已按停用日期过滤：停用日之后的销售不计入该员工业绩；历史数据完整保留在库中',
  });
}
