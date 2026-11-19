/**
 * 智能体 · 意图反问工具（Grill / Clarify）v2
 *
 * v2 变更：
 *  - 意图识别：咨询类问题 / 已写清规格的请求不再反问；模糊的产出需求才反问。
 *  - 「不用反问了」持久化关闭追问（全局 + 会话），「开启追问」可恢复。
 *  - 连续两次没匹配答案自动按默认输出，不再无限重复同一题。
 *  - 从用户原话预填已说明的规格，只问真正缺的项；force 时完整问一遍。
 *  - 每个问题末尾固定给「✎ 其他补充…（我自己输入）」选项。
 *  - 只有具备渲染能力的前端（body.clarify === 1）才走聊天窗口反问，
 *    避免旧缓存页面只显示文字却看不到可点选项。
 */
import { get, run, now, DEFAULT_SET_ID } from './store.mjs';
import * as exp from './export.mjs';
import * as skills from './skills.mjs';

export const TOOL_NAME = 'clarify_intent';
export const ANALYZE_TOOL = 'analyze_intent';
export const TOOL_DESCRIPTION = '意图追问工具：仅当需求模糊时才反问，逐步给出可点击选项，确认输出形式、报表类型、文件格式与期间，最后按精确规格产出真实报表';
export const ANALYZE_DESCRIPTION = '意图识别：判断一句话是否需要调用意图追问工具，返回 decision / reason / 已识别规格 / 建议工具';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const BUILTIN_FORMATS = ['csv', 'xlsx', 'json', 'md', 'html'];
const currentPeriod = () => new Date().toISOString().slice(0, 7);
const shiftPeriod = (delta) => {
  const [y, m] = currentPeriod().split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const CUSTOM_OPT = { value: '__custom__', label: '✎ 其他补充…（我自己输入）', desc: '点这里后直接在输入框写出你的要求，再点发送', custom: true };

const OPTIONS = {
  output: [
    { value: 'chat', label: '只在消息里看摘要', desc: '直接在对话里给结论和关键数字，不生成文件', alias: ['消息', '摘要', '文字', '直接看', '聊天里'] },
    { value: 'file', label: '生成详细报表文件', desc: '导出完整明细表，并给出下载按钮', alias: ['文件', '报表文件', '下载', '导出', '附件'] },
    { value: 'both', label: '消息摘要 + 报表文件', desc: '两者都要，先看结论再下载明细', alias: ['都要', '两个', '摘要和文件'] },
  ],
  kind: [
    { value: 'vouchers', label: '凭证清单', desc: '本期全部记账凭证及分录', alias: ['凭证', '分录'] },
    { value: 'ledger', label: '科目余额表', desc: '各科目期初 / 发生额 / 期末余额', alias: ['余额', '科目余额'] },
    { value: 'dashboard', label: '经营概览', desc: '收入、成本、费用、利润等综合指标', alias: ['经营', '概览', '利润', '资产负债', '财务报表', '财报'] },
    { value: 'subjects', label: '会计科目表', desc: '当前账套启用的全部会计科目', alias: ['科目表', '科目清单'] },
  ],
  format: [
    { value: 'xlsx', label: 'Excel（.xlsx）', desc: '表格，便于继续编辑与筛选', alias: ['excel', 'xlsx', '表格'] },
    { value: 'csv', label: 'CSV（.csv）', desc: '通用纯文本表格', alias: ['csv'] },
    { value: 'pdf', label: 'PDF（.pdf）', desc: '适合打印、归档、发给别人', alias: ['pdf', '打印'] },
    { value: 'docx', label: 'Word（.docx）', desc: '适合放进报告文档', alias: ['word', 'docx', '文档'] },
    { value: 'json', label: 'JSON（.json）', desc: '适合程序读取', alias: ['json'] },
    { value: 'md', label: 'Markdown（.md）', desc: '适合写进笔记或文档', alias: ['markdown', 'md', '笔记'] },
    { value: 'png', label: '图片（.png）', desc: '适合贴到聊天或汇报里', alias: ['图片', 'png', '截图'] },
  ],
  period: [
    { value: 'this', label: '本月', desc: currentPeriod(), alias: ['这个月', '当前月', '本月'] },
    { value: 'last', label: '上月', desc: shiftPeriod(-1), alias: ['上个月', '上月'] },
    { value: 'custom', label: '✎ 我自己输入期间（YYYY-MM）', desc: '点这里后在输入框写 2026-09 这样的月份', alias: ['自定义', '指定', '其它月份', '其他月份'], custom: true },
  ],
  detail: [
    { value: 'brief', label: '简要结论（3~5 行）', desc: '只看总额、状态和结论', alias: ['简单', '简要', '结论', '少一点'] },
    { value: 'full', label: '完整明细（逐项列出）', desc: '把各项数字和检查项全部展开', alias: ['详细', '完整', '全部', '逐项'] },
  ],
  confirm: [
    { value: 'go', label: '确认，按此输出', desc: '按上面全部设置生成结果', alias: ['确定', '确认', '就这样', '可以'] },
    { value: 'back', label: '返回上一步修改', desc: '重新选上一个问题', alias: ['上一步', '改一下', '返回'] },
    { value: 'restart', label: '重新问一遍', desc: '清空所有选择，从头开始', alias: ['重来', '重新', '从头'] },
    { value: 'cancel', label: '取消本次输出', desc: '不做输出，回到正常对话', alias: ['取消', '算了'] },
  ],
};

function optionsFor(key) {
  const base = (OPTIONS[key] || []).map((o) => ({ ...o }));
  if (key === 'period') return base;                 // 第三项已经是自由输入
  return [...base, { ...CUSTOM_OPT }];
}

const QUESTIONS = [
  { key: 'output', title: '你想要哪种结果形式？', when: () => true },
  { key: 'kind', title: '需要哪一类报表？', when: (a) => a.output !== 'chat' },
  { key: 'format', title: '要什么文件格式？', when: (a) => a.output !== 'chat' },
  { key: 'period', title: '统计哪个期间？', when: () => true },
  { key: 'detail', title: '要多详细？', when: (a) => a.output !== 'file' },
  { key: 'confirm', title: '确认按以上设置输出吗？', when: (a) => requiredKeys(a).every((k) => a[k] !== undefined) },
];

function requiredKeys(a) {
  const keys = ['output', 'period'];
  if (a.output !== 'chat') keys.push('kind', 'format');
  if (a.output !== 'file') keys.push('detail');
  return keys;
}

/* ---------------- 意图识别 ---------------- */

const FORCE_RE = /(追问我|反问工具|逐步反问|问清楚|先问我|问细一点|别猜|grill|clarify)/i;
const RE_ENABLE_RE = /(开启|打开|恢复|重新启用|继续用).{0,4}(意图)?(追问|反问)|开启追问|打开追问|恢复追问|继续追问/i;
const DISABLE_RE = /(不用|不要|别|停止|关闭|取消|关掉).{0,5}(再)?(意图)?(反问|追问|问了)|不用问了|别问了|不要再问|直接给|按默认|默认就行|直接输出/i;
const CANCEL_RE = /(取消本次|取消这次|算了|不弄了|中止|不要了)/;
const CONSULT_RE = /(怎么|如何|为什么|为何|是什么|啥是|能不能|可不可以|可以吗|支持吗|原理|保存|备份|存在哪|存在哪里|安全吗|区别|什么意思|教程|怎么用|用来干嘛|是否|会不会)/;
const OUTPUT_RE = /(报表|财报|财务报表|导出|清单|明细|余额|凭证|发票|汇总|统计|数据|文件|下载|给我|来一份|发我|整理|生成|出一份|做个表|查一下|多少)/;
const CHAT_RE = /^(你好|hi|hello|在吗|谢谢|好的|ok|收到|嗯|哈喽|继续)[\s!！.。?？]*$/i;
const VAGUE_RE = /^(一般|普通|随便|默认|都行|无所谓|你看着办|大概|差不多)/;
const UI_COMPLAINT_RE = /(没弹出|没有选项|看不到选项|选项呢|点不了|选项在哪|没显示选项)/;

/** 从用户原话里抽出已经说清楚的规格，只问真正缺的项 */
export function extractSpec(raw) {
  const t = String(raw || '');
  const spec = {};
  const f = t.toLowerCase();
  if (/xlsx|excel|\.xls|表格/.test(f)) spec.format = 'xlsx';
  else if (/\bcsv\b/.test(f)) spec.format = 'csv';
  else if (/\bpdf\b|打印/.test(f)) spec.format = 'pdf';
  else if (/docx|\bword\b|文档/.test(f)) spec.format = 'docx';
  else if (/\bjson\b/.test(f)) spec.format = 'json';
  else if (/markdown|\bmd\b|笔记/.test(f)) spec.format = 'md';
  else if (/\bpng\b|图片|截图/.test(f)) spec.format = 'png';
  if (/科目表|科目清单/.test(t)) spec.kind = 'subjects';
  else if (/余额表|科目余额/.test(t)) spec.kind = 'ledger';
  else if (/凭证|分录/.test(t)) spec.kind = 'vouchers';
  else if (/财务报表|财报|经营|利润|资产负债|概览/.test(t)) spec.kind = 'dashboard';
  const ym = t.match(/(20\d{2})\s*[-年/.]\s*(\d{1,2})/);
  if (ym) spec.period = `${ym[1]}-${String(Number(ym[2])).padStart(2, '0')}`;
  else if (/上月|上个月/.test(t)) spec.period = 'last';
  else if (/本月|这个月|当月/.test(t)) spec.period = 'this';
  if (/只在消息|直接看摘要|文字说明|聊天里看/.test(t)) spec.output = 'chat';
  else if (/(导出|下载|生成|文件|附件|xlsx|excel|pdf|csv|docx|word|报表文件)/.test(f)) spec.output = 'file';
  if (/完整|详细|逐项|全部明细/.test(t)) spec.detail = 'full';
  else if (/简要|简单|结论|少一点/.test(t)) spec.detail = 'brief';
  return spec;
}

function detectIntent(raw) {
  if (/(报表|财报|导出|文件|下载|给我|来一份|生成.*(表|单|文件))/.test(raw)) return { id: 'report', label: '报表 / 文件导出' };
  if (/(查询|多少|看看|余额|凭证|发票|结账|统计|汇总|明细|清单)/.test(raw)) return { id: 'query', label: '账务数据查询' };
  return { id: 'general', label: '一般需求' };
}

/**
 * 决定是否要调用反问工具。
 * @returns { decision, reason, intent, spec, suggested_tool }
 */
export function classify(raw) {
  const t = String(raw || '').trim();
  if (!t) return { decision: 'no_clarify', reason: '空消息', intent: 'chat', spec: {}, suggested_tool: null };
  if (RE_ENABLE_RE.test(t)) return { decision: 'enable', reason: '用户要求重新开启意图追问', intent: 'control', spec: {}, suggested_tool: TOOL_NAME };
  if (DISABLE_RE.test(t)) return { decision: 'disable', reason: '用户明确表示不想被反问', intent: 'control', spec: {}, suggested_tool: null };
  if (FORCE_RE.test(t)) return { decision: 'clarify', reason: '用户主动要求逐步追问', intent: 'control', spec: {}, suggested_tool: TOOL_NAME };
  if (CHAT_RE.test(t) || t.length < 4) return { decision: 'no_clarify', reason: '闲聊 / 过短，无需澄清', intent: 'chat', spec: {}, suggested_tool: null };
  // 咨询软件本身的问题（「你的数据是怎么保存的？」「发票怎么归档」）交给模型回答，不反问。
  // 只有同时带明确产出目标（给我 / 导出 xlsx / 下载报表 …）时才算产出请求。
  if (CONSULT_RE.test(t) && !/(给我|发我|来一份|下载|导出|生成).{0,8}(报表|文件|清单|明细|表|xlsx|pdf|csv|docx)/.test(t)) {
    return { decision: 'no_clarify', reason: '这是咨询/说明类问题，不是产出请求', intent: 'consult', spec: {}, suggested_tool: null };
  }
  if (!OUTPUT_RE.test(t)) {
    return { decision: 'no_clarify', reason: '未识别到报表 / 数据 / 导出类需求', intent: 'general', spec: {}, suggested_tool: null };
  }
  const spec = extractSpec(t);
  const intent = detectIntent(t).id;
  const hasAll = spec.output && spec.period && (spec.output === 'chat' || (spec.kind && spec.format));
  if (hasAll) {
    return { decision: 'direct', reason: '需求已写清形式 / 期间 / 报表 / 格式，无需反问，直接产出', intent, spec, suggested_tool: 'get_report' };
  }
  return { decision: 'clarify', reason: '产出类需求但规格不完整，需要逐步确认', intent, spec, suggested_tool: TOOL_NAME };
}

/* ---------------- 偏好持久化 ---------------- */

function prefEnabled(sessionId) {
  const s = get('SELECT enabled FROM agent_clarify_prefs WHERE scope = ?', `session:${sessionId}`);
  if (s) return s.enabled === 1;
  const g = get('SELECT enabled FROM agent_clarify_prefs WHERE scope = ?', 'global');
  if (g) return g.enabled === 1;
  return false;
}

function setPref(scope, enabled) {
  run(`INSERT INTO agent_clarify_prefs (scope, enabled, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  scope, enabled ? 1 : 0, now());
}

export function prefsOf(sessionId = '') {
  const g = get('SELECT enabled FROM agent_clarify_prefs WHERE scope = ?', 'global');
  const s = get('SELECT enabled FROM agent_clarify_prefs WHERE scope = ?', `session:${sessionId}`);
  return {
    global: g ? g.enabled === 1 : false,
    session: s ? s.enabled === 1 : null,
    enabled: prefEnabled(sessionId),
  };
}

export function setPrefs({ sessionId = '', enabled = true, scope = 'global' } = {}) {
  if (scope === 'session' || scope === 'both') setPref(`session:${sessionId}`, enabled);
  if (scope === 'global' || scope === 'both') setPref('global', enabled);
  return prefsOf(sessionId);
}

/* ---------------- 状态持久化 ---------------- */

function load(sessionId) {
  const row = get('SELECT * FROM agent_clarify WHERE session_id = ? AND status = ?', sessionId, 'asking');
  if (!row) return null;
  try {
    return {
      sessionId: row.session_id, intent: row.intent, intentLabel: row.intent_label,
      original: row.original, asked: JSON.parse(row.asked || '[]'),
      answers: JSON.parse(row.answers || '{}'), status: row.status,
    };
  } catch { drop(sessionId); return null; }
}

function persist(s) {
  run(`INSERT INTO agent_clarify
       (session_id, intent, intent_label, original, asked, answers, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         intent = excluded.intent, intent_label = excluded.intent_label,
         original = excluded.original, asked = excluded.asked,
         answers = excluded.answers, status = excluded.status, updated_at = excluded.updated_at`,
  s.sessionId, s.intent, s.intentLabel, s.original,
  JSON.stringify(s.asked), JSON.stringify(s.answers), s.status, now());
}

function drop(sessionId) { run('DELETE FROM agent_clarify WHERE session_id = ?', sessionId); }

export function stateOf(sessionId) {
  const s = load(String(sessionId || ''));
  if (!s) return { active: false, enabled: prefEnabled(String(sessionId || '')) };
  const q = nextQuestion(s);
  return {
    active: true, enabled: prefEnabled(String(sessionId || '')),
    intent: s.intent, intentLabel: s.intentLabel, original: s.original,
    answers: cleanAnswers(s.answers), asked: s.asked,
    step: progress(s).step, total: progress(s).total,
    question: q ? { key: q.key, title: q.title, options: optionsFor(q.key) } : null,
  };
}

export function reset(sessionId) {
  drop(String(sessionId || ''));
  return { active: false, enabled: prefEnabled(String(sessionId || '')) };
}

/** 最后一次产出（前端 SSE 旁路失效时据此补挂下载按钮） */
function saveLast(sid, payload) {
  run(`INSERT INTO agent_clarify (session_id, intent, intent_label, original, asked, answers, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET answers = excluded.answers,
         status = excluded.status, updated_at = excluded.updated_at`,
  sid, 'last', '', '', '[]', JSON.stringify(payload), 'done', now());
}

export function lastOf(sessionId) {
  const row = get('SELECT answers FROM agent_clarify WHERE session_id = ? AND status = ?', String(sessionId || ''), 'done');
  if (!row) return null;
  try { return JSON.parse(row.answers); } catch { return null; }
}

/* ---------------- 问题推进 ---------------- */

function cleanAnswers(a) {
  const out = {};
  for (const k of Object.keys(a || {})) if (!k.startsWith('__')) out[k] = a[k];
  return out;
}
function visibleCount(a) { return QUESTIONS.filter((q) => q.when(a)).length; }
/** 从原话预填的规格不算「问过」，进度只统计真正向用户提过的问题 */
function prefilledOf(s) { return Array.isArray(s.answers?.__prefilled) ? s.answers.__prefilled : []; }
function progress(s) {
  const pre = prefilledOf(s);
  const askedReal = s.asked.filter((k) => !pre.includes(k)).length;
  const total = QUESTIONS.filter((q) => q.when(s.answers)).filter((q) => !pre.includes(q.key)).length;
  return { step: askedReal + 1, total };
}
function nextQuestion(s) {
  return QUESTIONS.filter((q) => q.when(s.answers)).find((q) => !s.asked.includes(q.key)) || null;
}
function labelOf(key, value) { return OPTIONS[key]?.find((o) => o.value === value)?.label || String(value ?? '未设置'); }
function resolvePeriod(v) {
  if (v === 'last') return shiftPeriod(-1);
  if (PERIOD_RE.test(String(v || ''))) return String(v);
  return currentPeriod();
}
function summaryOf(a) {
  const names = { output: '形式', kind: '报表', format: '格式', period: '期间', detail: '详略' };
  return ['output', 'kind', 'format', 'period', 'detail']
    .filter((k) => a[k] !== undefined)
    .map((k) => `${names[k]}：${k === 'period' ? resolvePeriod(a[k]) : labelOf(k, a[k])}`)
    .join(' · ');
}

function parseAnswer(message, question) {
  const raw = String(message || '').trim();
  if (!raw) return null;
  const m = raw.match(/^【澄清选择】\s*([^｜|\s]+)/);
  const token = m ? m[1] : raw;
  if (token === '__skip__' || /^(不用问了|别问了|直接给|跳过追问|按默认|默认就行|直接输出)/.test(raw)) return { special: 'skip' };
  if (token === '__cancel__' || token === 'cancel' || CANCEL_RE.test(raw)) return { special: 'cancel' };
  if (token === '__custom__') return { special: 'need_custom' };
  if (question.key === 'period') {
    if (PERIOD_RE.test(token)) return { value: token, label: token };
    if (token === 'custom') return { special: 'need_period' };
  }
  // 自由输入一句完整需求：尽量从中抽规格，直接按这份规格产出
  if (!m && raw.length > 8) {
    const spec = extractSpec(raw);
    if (Object.keys(spec).length >= 2) return { special: 'free_spec', spec };
  }
  const norm = token.toLowerCase();
  const num = raw.match(/^[第]?\s*([1-9])\s*[、.项个]?$/);
  if (num && !m) {
    const o = OPTIONS[question.key][Number(num[1]) - 1];
    if (o) return { value: o.value, label: o.label };
  }
  const opts = OPTIONS[question.key] || [];
  const hit = opts.find((o) => o.value.toLowerCase() === norm
    || o.label.toLowerCase().includes(norm)
    || (o.alias || []).some((x) => norm.includes(x.toLowerCase())));
  if (hit) return { value: hit.value, label: hit.label };
  // 「一般 / 随便 / 默认」这类含糊回答：按默认直接给结果，不再卡住
  if (VAGUE_RE.test(raw)) return { special: 'skip' };
  return null;
}

function applyDefaults(s) {
  const defaults = { output: 'chat', kind: 'dashboard', format: 'xlsx', period: 'this', detail: 'brief', confirm: 'go' };
  for (const q of QUESTIONS.filter((x) => x.when(s.answers))) {
    if (s.answers[q.key] === undefined) {
      s.answers[q.key] = defaults[q.key];
      if (!s.asked.includes(q.key)) s.asked.push(q.key);
    }
  }
  if (s.answers.output === 'chat') { s.answers.kind = 'dashboard'; s.answers.format = 'xlsx'; }
  persist(s);
}

function ask(s, question, hint = '') {
  persist(s);
  const { step, total } = progress(s);
  const isFirst = s.asked.filter((k) => !prefilledOf(s).includes(k)).length === 0;
  const lines = [
    `【意图追问 第 ${step} 步】${question.title}`,
    isFirst ? `我理解你要做的是：${s.intentLabel}（${s.original.slice(0, 40)}）` : `已确认：${summaryOf(s.answers)}`,
    hint || '请点选下面的选项，也可以直接输入答案或序号；最后一项可自己输入；说「不用问了」按默认直接给结果。',
  ];
  const text = lines.join('\n');
  return {
    type: 'ask', text, reason: hint ? '上一轮未匹配到选项，重新给选项' : '需求规格未完整，继续确认',
    payload: {
      kind: 'ask', phase: s.intent, step, total, decision: 'clarify',
      question: question.title, key: question.key,
      options: optionsFor(question.key),
      summary: cleanAnswers(s.answers), anchor: text.replace(/\s+/g, '').slice(0, 12),
      hint: hint || '点选项即可继续，也可以自己输入；看不到卡片请按 Ctrl+R 刷新页面',
    },
  };
}

function notice(text, extra = {}) {
  return { type: 'notice', text, reason: extra.reason || '', payload: { kind: 'notice', anchor: text.replace(/\s+/g, '').slice(0, 12), ...extra } };
}

/* ---------------- 最终产出 ---------------- */

async function buildFile(spec, setId) {
  const target = BUILTIN_FORMATS.includes(spec.format) ? spec.format : 'csv';
  const out = exp.buildReport({ kind: spec.kind, period: spec.period, format: target, setId });
  const base = { filename: out.filename, rows: out.rows, format: target, url: `/api/export/download?file=${encodeURIComponent(out.filename)}` };
  if (target === spec.format) return { ...base, degraded: '' };
  const conv = await exp.convert({ file: out.filename, to: spec.format });
  if (conv.ok && conv.download) {
    return { filename: conv.output, rows: out.rows, format: spec.format, url: conv.download, degraded: '' };
  }
  return { ...base, degraded: `目标格式 .${spec.format} 未生成（${conv.message}），已提供 .${target} 文件` };
}

function dataBrief(spec, setId) {
  let text = '';
  try { text = skills.runSkill('monthly-overview', { period: spec.period }, setId).text; }
  catch (e) { text = `（本地数据汇总失败：${e.message}）`; }
  const periodLine = `【本地账套真实数据 · ${spec.period}】`;
  if (spec.detail === 'brief') return [periodLine, ...text.split('\n').filter(Boolean).slice(0, 9)].join('\n');
  return `${periodLine}\n${text}`;
}

function specFromAnswers(s) {
  return {
    intent: s.intent, intentLabel: s.intentLabel, original: s.original,
    output: s.answers.output || 'chat',
    kind: s.answers.kind || 'dashboard',
    format: s.answers.format || 'xlsx',
    period: resolvePeriod(s.answers.period),
    detail: s.answers.detail || 'brief',
  };
}

async function produce(spec, setId, extraNote = '', sid = '') {
  let download = null;
  let fileNote = '';
  if (spec.output !== 'chat') {
    try {
      download = await buildFile(spec, setId);
      fileNote = download.degraded ? `⚠ ${download.degraded}`
        : `✅ 文件已生成：${download.filename}（${download.rows} 行，.${download.format}），点下方按钮下载。`;
    } catch (e) { fileNote = `⚠ 文件生成失败：${e.message}。可改用 Excel/CSV 格式再试。`; }
  }
  const lines = [
    '【已按你的选择输出】',
    `· 需求：${spec.intentLabel || '报表 / 数据'} · ${String(spec.original || '').slice(0, 50)}`,
    `· 输出形式：${labelOf('output', spec.output)}`,
    spec.output !== 'chat' ? `· 报表：${labelOf('kind', spec.kind)} / 格式：${labelOf('format', spec.format)}` : '',
    `· 期间：${spec.period} / 详略：${labelOf('detail', spec.detail)}`,
    '',
    spec.output !== 'file' ? dataBrief(spec, setId) : '',
    fileNote,
    extraNote,
    '',
    '（以上数字来自本地账套实时汇总，未使用演示数据。）',
  ].filter(Boolean);
  const text = lines.join('\n');
  const payload = {
    kind: 'final', phase: spec.intent, decision: 'final', spec, download,
    anchor: text.replace(/\s+/g, '').slice(0, 12),
  };
  if (sid) saveLast(sid, payload);
  return { type: 'final', text, reason: '规格已确认，按真实数据产出', payload };
}

function finalize(s, setId, extraNote = '') {
  const spec = specFromAnswers(s);
  drop(s.sessionId);
  return produce(spec, setId, extraNote, s.sessionId);
}

function startSession(sid, raw, force, setId = DEFAULT_SET_ID) {
  const intent = detectIntent(raw);
  const state = {
    sessionId: sid, intent: intent.id, intentLabel: intent.label,
    original: raw, asked: [], answers: {}, status: 'asking',
  };
  if (!force) {
    const spec = extractSpec(raw);
    const pre = [];
    for (const k of ['kind', 'format', 'period', 'detail', 'output']) {
      if (spec[k] !== undefined) { state.answers[k] = spec[k]; state.asked.push(k); pre.push(k); }
    }
    if (pre.length) state.answers.__prefilled = pre;
  }
  const q = nextQuestion(state);
  if (!q) return finalize(state, setId);
  return ask(state, q, force ? '' : '我已从你的话里识别出部分要求，只需补齐剩下几项。');
}

/* ---------------- 对外入口 ---------------- */

/**
 * 每次 /api/agent/chat 调用前执行。
 * @param capable 前端注入层是否具备选项渲染能力（避免旧页面只有文字没有卡片）
 */
export async function handle({ sessionId, message, setId = DEFAULT_SET_ID, capable = true, force = false } = {}) {
  const sid = String(sessionId || 'clarify-default');
  const raw = String(message || '').trim();
  let s = load(sid);

  // 1) 重新开启追问（最高优先级，即使当前已关闭）
  if (RE_ENABLE_RE.test(raw)) {
    setPref('global', true); setPref(`session:${sid}`, true);
    if (s) drop(sid);
    if (force || FORCE_RE.test(raw)) return startSession(sid, raw, true, setId);
    return notice('已重新开启「意图追问」。下次说报表 / 导出类需求时，我会再一步步问清楚。', { decision: 'enable' });
  }

  // 2) 用户明确不想被反问：持久化关闭，并按默认直接给结果
  if (DISABLE_RE.test(raw) || (s && /^【澄清选择】\s*__skip__/.test(raw))) {
    const wasEnabled = prefEnabled(sid);
    setPref('global', false); setPref(`session:${sid}`, false);
    if (s) {
      applyDefaults(s);
      const out = await finalize(s, setId, '（已关闭「意图追问」，之后不再逐步反问；说「开启追问」可恢复。）');
      if (out.payload) out.payload.prefs_disabled = true;
      return out;
    }
    if (!wasEnabled) return { type: 'passthrough', reason: '追问已处于关闭状态' };
    return notice('已关闭「意图追问」，之后所有会话都不再逐步反问，需求直接交给你我按常识处理。想恢复请说「开启追问」。', { decision: 'disable' });
  }

  // 3) 能力 / 偏好门槛：旧页面或已关闭偏好都不反问，直接交给模型
  if (!capable || !prefEnabled(sid)) {
    if (s) drop(sid);
    return { type: 'passthrough', reason: capable ? '用户已关闭意图追问' : '当前页面未加载选项渲染层' };
  }

  // 4) 活动状态：解析答案并推进
  if (s) {
    const question = nextQuestion(s);
    if (!question) return finalize(s, setId);
    const ans = parseAnswer(raw, question);

    if (ans?.special === 'cancel') {
      drop(sid);
      return notice('已取消本次追问，回到正常对话。你可以直接说出新的需求。');
    }
    if (ans?.special === 'skip') {
      applyDefaults(s);
      return finalize(s, setId, '（已按默认设置直接给结果，不再继续追问。）');
    }
    if (ans?.special === 'need_custom') {
      return ask(s, question, '请在下方输入框直接写出你的要求，再点发送；也可以点其它选项。');
    }
    if (ans?.special === 'need_period') {
      return ask(s, question, '请在输入框直接输入期间，格式 YYYY-MM（例如 2026-09），也可以点「本月 / 上月」。');
    }
    if (ans?.special === 'free_spec') {
      const merged = { ...s.answers, ...ans.spec };
      const spec = {
        intent: s.intent, intentLabel: s.intentLabel, original: s.original,
        output: merged.output || 'chat', kind: merged.kind || 'dashboard',
        format: merged.format || 'xlsx', period: resolvePeriod(merged.period),
        detail: merged.detail || 'brief',
      };
      drop(sid);
      return produce(spec, setId, '（已按你补充说明的规格直接输出。）', sid);
    }
    if (!ans) {
      const misses = (Number(s.answers.__misses) || 0) + 1;
      s.answers.__misses = misses;
      if (UI_COMPLAINT_RE.test(raw)) {
        return ask(s, question, '看不到可点选项时：按 Ctrl+R 刷新页面即可显示；也可以直接输入序号 1/2/3，或写「不用问了」按默认给结果。');
      }
      if (misses >= 2) {
        applyDefaults(s);
        return finalize(s, setId, '（连续两次没匹配到选项，已按默认设置直接给结果，不再重复追问。）');
      }
      return ask(s, question, '没看懂这个回答，请点选项、输入序号 1/2/3，或点最后一项自己写；说「不用问了」按默认给结果。');
    }

    if (question.key === 'confirm') {
      if (ans.value === 'cancel') { drop(sid); return notice('已取消本次输出，回到正常对话。'); }
      if (ans.value === 'restart') {
        s.asked = []; s.answers = {};
        return ask(s, nextQuestion(s), '已清空选择，我们从头再问一遍。');
      }
      if (ans.value === 'back') {
        const last = s.asked.filter((k) => k !== 'confirm').pop();
        if (last) {
          s.asked = s.asked.filter((k) => k !== last);
          delete s.answers[last];
          return ask(s, QUESTIONS.find((x) => x.key === last), '回到上一个问题，请重新选择。');
        }
      }
      s.answers.confirm = 'go';
      if (!s.asked.includes('confirm')) s.asked.push('confirm');
      return finalize(s, setId);
    }

    s.answers[question.key] = ans.value;
    delete s.answers.__misses;
    if (!s.asked.includes(question.key)) s.asked.push(question.key);
    const next = nextQuestion(s);
    return next ? ask(s, next) : finalize(s, setId);
  }

  // 5) 新消息：先做意图识别
  if (/^【澄清选择】/.test(raw)) {
    return notice('这次追问已经结束了。请重新说出你的需求，我会再一步步问清楚。');
  }
  const decision = classify(raw);
  if (decision.decision === 'direct') {
    const spec = {
      intent: decision.intent, intentLabel: detectIntent(raw).label, original: raw,
      output: decision.spec.output || 'file',
      kind: decision.spec.kind || 'dashboard',
      format: decision.spec.format || 'xlsx',
      period: resolvePeriod(decision.spec.period),
      detail: decision.spec.detail || 'brief',
    };
    return produce(spec, setId, '（你的需求已经写得很清楚，因此没有反问，直接按上述规格产出。）', sid);
  }
  if (decision.decision !== 'clarify') {
    return { type: 'passthrough', reason: decision.reason };
  }
  return startSession(sid, raw, force || FORCE_RE.test(raw), setId);
}

/** 供 MCP 意图识别工具调用 */
export function analyze({ message = '', session_id = '' } = {}) {
  const d = classify(message);
  return {
    code: 0,
    data: {
      ...d,
      enabled: prefEnabled(String(session_id || '')),
      active: Boolean(load(String(session_id || ''))),
      hint: d.decision === 'clarify'
        ? `调用 ${TOOL_NAME} 获取第 1 步的问题与可点击选项`
        : d.decision === 'direct' ? '直接按 spec 生成报表，无需反问'
          : '交给模型正常回答，不要调用意图追问工具',
    },
  };
}

/** MCP tools/call 入口：返回结构化问题与选项，供外部智能体展示 */
export async function callTool(args = {}, setId = DEFAULT_SET_ID) {
  const r = await handle({
    sessionId: args.session_id || 'mcp-clarify',
    message: args.message || args.answer || '',
    setId, capable: true,
    force: Boolean(args.force),
  });
  if (r.type === 'passthrough') {
    return { code: 0, data: { phase: 'idle', decision: 'no_clarify', reason: r.reason || '该消息无需澄清', message: '可直接执行，无需调用意图追问工具' } };
  }
  return { code: 0, data: { ...r.payload, reason: r.reason || '' } };
}
