/* 妆点智能体 · 会话自动命名
 *
 * 背景：前端点「新增会话」时先 POST /api/agent/sessions（title 固定「新对话」），
 * 之后才带 session_id 发消息。旧后端只在「会话不存在」时用消息前 20 字命名，
 * 因此正常流程里会话名永远停在「新对话」。
 *
 * 本模块把命名做成一条独立、可测试、幂等的链路：
 *   1) 首条有效用户消息 → 本地启发式命名（零依赖、零延迟、模型挂了也能用）
 *   2) /api/agent/chat 立即发 SSE `session_title`，前端同步刷新侧栏与顶部标题
 *   3) 一轮对话结束后可选调用 LLM 精修短标题（失败/未配置自动回退）
 *   4) 列表接口对历史「新对话」按首条消息回填，老会话也能补上名字
 *   5) 用户手动重命名后置 title_source='manual'，任何自动逻辑都不再覆盖
 *
 * 数据严谨：所有写操作都带 set_id 与 title_source 条件，UPDATE 后核对 changes；
 * 只改 agent_sessions.title，绝不触碰账务数据。
 */
import { get, all, run, now, readEnv } from './store.mjs';
import * as llm from './llm.mjs';

export const DEFAULT_TITLES = Object.freeze(['', '新对话', '新会话', '未命名', '未命名会话']);
const MAX_LEN = 18;
const DEFAULT_IN_SQL = "('', '新对话', '新会话', '未命名', '未命名会话')";

export function isDefaultTitle(title) {
  return DEFAULT_TITLES.includes(String(title ?? '').trim());
}

/** 清洗成可直接展示的短标题：去引号/尾标点、压空白、按码点截断 */
export function sanitizeTitle(raw, maxLen = MAX_LEN) {
  let t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'「『“”‘’]+|["'」』“”‘’]+$/g, '');
  t = t.replace(/^(标题|会话名|名称)\s*[:：]\s*/i, '');
  t = t.replace(/[。！？!?，,、；;：:\-—~～\s]+$/g, '').trim();
  if (!t) return '';
  const chars = Array.from(t);
  if (chars.length > maxLen) t = chars.slice(0, maxLen).join('').replace(/[，,、\s]+$/g, '') + '…';
  return t;
}

/** 从一条用户消息提取会话名；追问选项/系统文案/空消息返回空串（不命名） */
export function heuristicTitle(message) {
  const raw = String(message ?? '').trim();
  if (!raw || /^【/.test(raw)) return '';
  let t = raw.split(/[\r\n。！？!?；;]+/)[0].trim();
  t = t.replace(/<[^>]{1,80}>/g, ' ').replace(/\s+/g, ' ').trim();
  // 反复剥离开头的客套词（「请帮我把…」需要剥两层）
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(/^(请|麻烦|帮我|帮忙|能不能|可否|能否|可以|我想|我要|请问|想问|问一下|查一下|查询一下|给我|把|来|看下|看看)\s*/, '').trim();
    if (t === before) break;
  }
  // 只剥无实义的语气尾巴，保留「是多少 / 有哪些」等核心疑问信息
  t = t.replace(/(给我|帮我|一下|可以吗|好吗|行吗|谢谢|呢|吧|嘛|啊)\s*$/g, '').trim();
  t = t.replace(/[，,、；;：:\s]+$/g, '').trim();
  const clean = sanitizeTitle(t || raw);
  return Array.from(clean).length >= 2 ? clean : '';
}

function sessionRow(sessionId) {
  return get('SELECT id, set_id, title, title_source FROM agent_sessions WHERE id = ?', String(sessionId || ''));
}

const isSameSet = (row, setId) => row && Number(row.set_id) === Number(setId);

/** 会话不存在时创建；带首条消息时直接用启发式结果命名，避免先落「新对话」再改 */
export function ensureSession(setId, sessionId, message = '', fixedTitle = '') {
  const id = String(sessionId || '');
  if (!id) return null;
  if (sessionRow(id)) return null;
  const title = fixedTitle
    ? (sanitizeTitle(fixedTitle, 20) || '新对话')
    : (heuristicTitle(message) || '新对话');
  run(`INSERT OR IGNORE INTO agent_sessions (id, set_id, title, title_source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    id, setId, title, fixedTitle ? 'manual' : 'auto', now());
  return { session_id: id, title, source: fixedTitle ? 'manual' : 'auto', changed: true };
}

/** 已有会话（前端提前创建，title 还是默认名）用首条消息命名 */
export function applyFirstMessageTitle(setId, sessionId, message) {
  const row = sessionRow(sessionId);
  if (!isSameSet(row, setId) || row.title_source === 'manual' || !isDefaultTitle(row.title)) return null;
  const title = heuristicTitle(message);
  if (!title) return null;
  const r = run(`UPDATE agent_sessions SET title = ?, title_source = 'auto'
       WHERE id = ? AND set_id = ? AND (title_source IS NULL OR title_source <> 'manual')
         AND TRIM(COALESCE(title, '')) IN ${DEFAULT_IN_SQL}`,
    title, String(sessionId), setId);
  return r.changes ? { session_id: String(sessionId), title, source: 'auto', changed: true } : null;
}

/** /api/agent/chat 的统一入口：无论会话是新建还是已存在，都返回可下发的标题事件 */
export function trackFirstMessage(setId, sessionId, message) {
  const created = ensureSession(setId, sessionId, message);
  if (created) return isDefaultTitle(created.title) ? null : created;
  return applyFirstMessageTitle(setId, sessionId, message);
}

/** 列表接口回填：历史遗留的「新对话」按首条真实用户消息补名（幂等） */
export function backfillTitles(setId) {
  const rows = all(`SELECT s.id,
       (SELECT m.content FROM agent_messages m
          WHERE m.session_id = s.id AND m.role = 'user' AND m.content NOT LIKE '【%'
          ORDER BY m.id LIMIT 1) AS first_msg
     FROM agent_sessions s
     WHERE s.set_id = ? AND (s.title_source IS NULL OR s.title_source <> 'manual')
       AND TRIM(COALESCE(s.title, '')) IN ${DEFAULT_IN_SQL}`, setId);
  const changed = [];
  for (const r of rows) {
    const title = heuristicTitle(r.first_msg || '');
    if (!title) continue;
    const u = run(`UPDATE agent_sessions SET title = ?, title_source = 'auto'
       WHERE id = ? AND set_id = ? AND (title_source IS NULL OR title_source <> 'manual')
         AND TRIM(COALESCE(title, '')) IN ${DEFAULT_IN_SQL}`,
      title, r.id, setId);
    if (u.changes) changed.push({ session_id: r.id, title });
  }
  return changed;
}

/**
 * 一轮对话结束后精修标题。LLM 未配置 / 超时 / 返回异常时回退本地启发式标题。
 * 用 ZD_AUTO_TITLE_LLM=0 可完全关闭外部模型调用（测试环境用）。
 */
export async function refineTitle(setId, sessionId, { timeoutMs = 8000 } = {}) {
  const id = String(sessionId || '');
  const row = sessionRow(id);
  if (!isSameSet(row, setId)) return null;
  if (row.title_source === 'manual') {
    return { session_id: id, title: sanitizeTitle(row.title, 40), source: 'manual', changed: false };
  }
  const msgs = all(`SELECT content FROM agent_messages
     WHERE session_id = ? AND role = 'user' AND content NOT LIKE '【%' ORDER BY id LIMIT 3`, id);
  const seed = msgs.map((m) => String(m.content || '')).join('\n').trim().slice(0, 600);
  let candidate = heuristicTitle(msgs[0]?.content || '') || sanitizeTitle(row.title, MAX_LEN);
  let source = 'heuristic';

  if (readEnv('ZD_AUTO_TITLE_LLM') !== '0' && seed) {
    const { key, baseUrl, model } = llm.currentConfig(get('SELECT * FROM agent_config WHERE user_id = 1'));
    if (key) {
      try {
        const r = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model, stream: false, max_tokens: 24, temperature: 0.2,
            messages: [
              { role: 'system', content: '你是会话命名器。只输出一个不超过 12 个汉字的中文短标题，概括用户核心诉求；不要引号、不要标点、不要解释、不要带「标题」二字。' },
              { role: 'user', content: seed },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (r.ok) {
          const j = await r.json();
          const clean = sanitizeTitle(j?.choices?.[0]?.message?.content || '', 16);
          const n = Array.from(clean).length;
          if (n >= 2 && n <= 20) { candidate = clean; source = 'llm'; }
        }
      } catch { /* 网络/超时/解析异常一律回退本地标题，不影响对话 */ }
    }
  }

  const current = String(row.title || '').trim();
  if (!candidate || current === candidate) {
    return { session_id: id, title: candidate || current, source, changed: false };
  }
  const u = run(`UPDATE agent_sessions SET title = ?, title_source = 'auto'
     WHERE id = ? AND set_id = ? AND (title_source IS NULL OR title_source <> 'manual')`,
    candidate, id, setId);
  return { session_id: id, title: candidate, source, changed: Boolean(u.changes) };
}
