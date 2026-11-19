/**
 * 智能体 · 本地技能执行层
 *
 * 背景：前端 AgentWorkspace 点技能时走 POST /api/agent/skills/:id/run 的 **SSE 流**，
 * 与 /api/agent/chat 是两条独立链路。旧后端只实现了 GET /api/agent/skills，
 * run 落到普通 JSON 兜底，前端流式解析器收不到 event: 行 → 永久「思考中…」。
 *
 * 本层只做确定性本地计算（不调用 LLM），保证秒级返回；数据全部来自本地 SQLite，
 * 不使用 seed 演示值，避免看板清零后仍凭空冒出数字。
 */
import { get, all, run, now, readSeed } from './store.mjs';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const n = (v) => Number(v || 0);
const money = (v) => n(v).toFixed(2);
const currentPeriod = () => new Date().toISOString().slice(0, 7);

export function skillList() {
  return readSeed('agent_skills')?.data?.list ?? [];
}

export function findSkill(id) {
  return skillList().find((s) => s.id === id) || null;
}

function voucherStats(setId, period) {
  const rows = all(
    'SELECT status, COUNT(*) AS c FROM vouchers WHERE set_id = ? AND period = ? GROUP BY status',
    setId, period);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.c]));
  const bal = get(`SELECT COALESCE(SUM(e.debit), 0) AS d, COALESCE(SUM(e.credit), 0) AS c
    FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
    WHERE v.set_id = ? AND v.period = ?`, setId, period);
  const entries = get(`SELECT COUNT(*) AS c FROM voucher_entries e
    JOIN vouchers v ON v.id = e.voucher_id WHERE v.set_id = ? AND v.period = ?`, setId, period);
  return {
    total: rows.reduce((a, r) => a + n(r.c), 0),
    draft: by.draft || 0, reviewed: by.reviewed || 0, posted: by.posted || 0,
    voided: by.void || 0, debit: n(bal?.d), credit: n(bal?.c), lines: n(entries?.c),
  };
}

function invoiceStats(setId, period) {
  const rows = all(`SELECT kind, status, COUNT(*) AS c, COALESCE(SUM(amount), 0) AS amt
    FROM invoices WHERE set_id = ? AND substr(invoice_date, 1, 7) = ? GROUP BY kind, status`,
  setId, period);
  let total = 0, pending = 0, amount = 0;
  const kinds = {};
  for (const r of rows) {
    total += n(r.c);
    amount += n(r.amt);
    if (!/posted|done|已记账|已做账/.test(String(r.status || ''))) pending += n(r.c);
    const k = r.kind || '其他';
    kinds[k] = (kinds[k] || 0) + n(r.amt);
  }
  return { total, pending, amount, kinds };
}

function closingState(setId, period) {
  return get('SELECT is_closed, closed_at, operator FROM closings WHERE set_id = ? AND period = ?',
    setId, period) || { is_closed: 0, closed_at: '', operator: '' };
}

function figureStats(setId, period) {
  // 与看板同源：按科目编码前缀实时汇总凭证分录
  const rows = all(`SELECT e.subject_code AS code, SUM(e.debit) AS d, SUM(e.credit) AS c
    FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
    WHERE v.set_id = ? AND v.period = ? GROUP BY e.subject_code`, setId, period);
  const out = { revenue: 0, cost: 0, expense: 0, capital: 0, ar: 0, ap: 0 };
  for (const r of rows) {
    const code = String(r.code || '');
    const net = n(r.d) - n(r.c);
    if (/^(6001|6041|6051|61|63)/.test(code)) out.revenue += -net;
    else if (/^64/.test(code)) out.cost += net;
    else if (/^6[68]/.test(code)) out.expense += net;
    if (/^100[12]/.test(code)) out.capital += net;
    if (/^1122/.test(code)) out.ar += net;
    if (/^2202/.test(code)) out.ap += net;
  }
  return out;
}

function monthEndCheck(setId, period) {
  const v = voucherStats(setId, period);
  const inv = invoiceStats(setId, period);
  const c = closingState(setId, period);
  const diff = v.debit - v.credit;
  const issues = [];
  if (n(c.is_closed)) issues.push('该期间已结账，如需调整请先反结账');
  if (v.draft) issues.push(`${v.draft} 张草稿凭证未审核`);
  if (v.reviewed) issues.push(`${v.reviewed} 张已审核凭证未记账`);
  if (inv.pending) issues.push(`${inv.pending} 张发票尚未生成凭证`);
  if (Math.abs(diff) > 0.005) issues.push(`借贷不平，差额 ${money(diff)} 元`);
  if (!v.total) issues.push('本期没有任何凭证，请确认是否已导入业务数据');

  const lines = [
    `【月末结账检查】期间 ${period}`,
    '',
    `· 结账状态：${n(c.is_closed) ? `已结账（${c.closed_at || '-'}，操作人 ${c.operator || '-'}）` : '未结账'}`,
    `· 凭证概况：共 ${v.total} 张 / ${v.lines} 条分录（草稿 ${v.draft}、已审核 ${v.reviewed}、已记账 ${v.posted}）`,
    `· 借贷合计：借方 ${money(v.debit)} 元，贷方 ${money(v.credit)} 元，${Math.abs(diff) <= 0.005 ? '平衡' : `差额 ${money(diff)} 元`}`,
    `· 发票情况：共 ${inv.total} 张，金额 ${money(inv.amount)} 元，待做账 ${inv.pending} 张`,
    '',
    issues.length ? `检查结论：发现 ${issues.length} 项待处理` : '检查结论：全部条件满足，可以执行结账',
    ...issues.map((x, i) => `  ${i + 1}. ${x}`),
    '',
    '（以上数据来自本地账套实时汇总，未使用演示数据。）',
  ];
  return lines.join('\n');
}

function monthlyOverview(setId, period) {
  const v = voucherStats(setId, period);
  const inv = invoiceStats(setId, period);
  const f = figureStats(setId, period);
  const c = closingState(setId, period);
  const profit = f.revenue - f.cost - f.expense;
  const kindLines = Object.entries(inv.kinds).map(([k, amt]) => `  · ${k}：${money(amt)} 元`);
  const lines = [
    `【月度经营摘要】期间 ${period}`,
    '',
    `· 收入：${money(f.revenue)} 元`,
    `· 成本：${money(f.cost)} 元`,
    `· 费用：${money(f.expense)} 元`,
    `· 本期利润（收 − 成 − 费）：${money(profit)} 元`,
    `· 货币资金净变动：${money(f.capital)} 元`,
    `· 应收 / 应付余额：${money(f.ar)} / ${money(f.ap)} 元`,
    '',
    `· 凭证 ${v.total} 张、分录 ${v.lines} 条（已记账 ${v.posted} 张）`,
    `· 发票 ${inv.total} 张、金额 ${money(inv.amount)} 元，待做账 ${inv.pending} 张`,
    ...(kindLines.length ? ['· 发票分类：', ...kindLines] : []),
    `· 结账状态：${n(c.is_closed) ? '已结账' : '未结账'}`,
    '',
    v.total === 0
      ? '提示：本期尚无凭证，以上为 0 属正常；导入数据后可再来查一次。'
      : '（以上数据来自本地账套实时汇总，金额保留两位小数。）',
  ];
  return lines.join('\n');
}

const ENGINES = {
  'month-end-check': monthEndCheck,
  'monthly-overview': monthlyOverview,
};

/** 把文本切成若干 SSE content 块，前端会逐块累加并显示 */
function chunks(text, size = 3) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += size) {
    out.push(lines.slice(i, i + size).join('\n') + (i + size < lines.length ? '\n' : ''));
  }
  return out.length ? out : [text];
}

export function runSkill(skillId, params = {}, setId) {
  const skill = findSkill(skillId);
  if (!skill) throw new Error(`未知技能：${skillId}`);
  const engine = ENGINES[skillId];
  if (!engine) throw new Error(`技能「${skill.name}」尚未配置本地执行逻辑`);
  const raw = String(params.period || '').trim();
  if (raw && !PERIOD_RE.test(raw)) throw new Error('会计期间格式应为 YYYY-MM');
  const period = raw || currentPeriod();
  const text = engine(setId, period);
  return {
    name: skill.name,
    period,
    text,
    chunks: chunks(text),
    userLine: `使用了技能「${skill.name}」${raw ? `（期间 ${period}）` : ''}`,
  };
}

/* ---------------- 智能体设置面板：自定义提示词技能 ---------------- */

export function listPromptSkills() {
  return all('SELECT * FROM agent_prompt_skills ORDER BY id DESC')
    .map((r) => ({ id: r.id, name: r.name, description: r.description || '',
      prompt: r.prompt || '', enabled: Number(r.enabled || 0),
      auto_apply: Number(r.auto_apply || 0), created_at: r.created_at }));
}

export function createPromptSkill(data = {}) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('技能名称不能为空');
  const info = run(`INSERT INTO agent_prompt_skills
    (name, description, prompt, enabled, auto_apply, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  name, String(data.description || ''), String(data.prompt || data.content || ''),
  data.enabled === false ? 0 : 1, data.auto_apply ? 1 : 0, now());
  return Number(info.lastInsertRowid);
}

export function updatePromptSkill(id, data = {}) {
  const old = get('SELECT * FROM agent_prompt_skills WHERE id = ?', id);
  if (!old) throw new Error('技能不存在');
  run(`UPDATE agent_prompt_skills SET name = ?, description = ?, prompt = ?,
       enabled = ?, auto_apply = ? WHERE id = ?`,
  String(data.name ?? old.name), String(data.description ?? old.description),
  String(data.prompt ?? data.content ?? old.prompt),
  data.enabled === undefined ? old.enabled : (data.enabled ? 1 : 0),
  data.auto_apply === undefined ? old.auto_apply : (data.auto_apply ? 1 : 0), id);
}

export function deletePromptSkill(id) {
  run('DELETE FROM agent_prompt_skills WHERE id = ?', id);
}

/** 附件上传：文本类直接抽取内容，二进制不做假 OCR */
export function extractAttachment({ name = '', content = '' } = {}) {
  const ext = String(name).toLowerCase().split('.').pop();
  const textExts = ['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'html', 'log'];
  if (!textExts.includes(ext)) {
    return { text: '', message: `已收到附件 ${name}（${ext} 为二进制格式，暂不做文字识别）` };
  }
  let buf;
  try { buf = Buffer.from(String(content), 'base64'); }
  catch { throw new Error('附件编码错误'); }
  if (!buf.length || buf.length > 2 * 1024 * 1024) throw new Error('附件为空或超过 2MB');
  const text = buf.toString('utf8').slice(0, 4000);
  return { text, message: `已识别 ${name}：${text.slice(0, 120).replace(/\s+/g, ' ')}…` };
}
