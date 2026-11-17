/**
 * 企业内部助手扩展骨架：销售/运营/分销/工作汇报/文档检索。
 *
 * 阶段说明（v1.7.0）：
 *  - 已实现：渠道与门店维护、日销售查询、工作汇报读写、文档入库与检索（LIKE，带出处）
 *  - 占位：销售/运营/分销的批量导入（返回 pending，等模板确定后接）
 */
import { get, all, run, now } from './store.mjs';

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

export function listSales(setId, { from = '', to = '', source = '', product = '', limit = 200 } = {}) {
  const where = ['set_id = ?'];
  const params = [setId];
  if (from) { where.push('date >= ?'); params.push(from); }
  if (to) { where.push('date <= ?'); params.push(to); }
  if (source) { where.push('source = ?'); params.push(source); }
  if (product) { where.push('product LIKE ?'); params.push(`%${product}%`); }
  const rows = all(`SELECT * FROM sales_daily WHERE ${where.join(' AND ')}
    ORDER BY date DESC, id DESC LIMIT ?`, ...params, Math.min(1000, Number(limit) || 200));
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
      return_amount: money(r.return_amount), cost: money(r.cost), source: r.source,
    })),
  });
}

/**
 * 批量导入销售数据（骨架）：校验行 → 写库。
 * 目前支持直接传 rows，模板映射与截图解析在后续版本接入。
 */
export function importSales(setId, { rows = [], source = 'sales_dept', date = '' } = {}) {
  if (!Array.isArray(rows) || !rows.length) return fail('没有可导入的行');
  const src = ['sales_dept', 'wdt'].includes(source) ? source : 'sales_dept';
  let inserted = 0;
  const errors = [];
  for (const [i, r] of rows.entries()) {
    const d = String(r.date || date || '').slice(0, 10);
    if (!DATE_RE.test(d)) { errors.push(`第 ${i + 1} 行日期不合法`); continue; }
    if (!r.product && !r.sku) { errors.push(`第 ${i + 1} 行缺少商品名或 SKU`); continue; }
    run(`INSERT INTO sales_daily (set_id, channel_id, date, sku, product, qty, amount, return_qty, return_amount, cost, source, batch_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    setId, Number(r.channel_id || 0), d, String(r.sku || ''), String(r.product || ''),
    Number(r.qty || 0), money(r.amount), Number(r.return_qty || 0), money(r.return_amount),
    money(r.cost), src, now());
    inserted += 1;
  }
  return inserted
    ? ok({ inserted, errors }, `已导入 ${inserted} 行${errors.length ? `，${errors.length} 行有问题` : ''}`)
    : fail(`全部未导入：${errors[0] || '格式不符'}`);
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
