import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { get, run, now, db, readEnv, readSeed, DEFAULT_SET_ID } from './store.mjs';
import { runAuditMulti } from './data-audit.mjs';
import * as biz from './biz.mjs';
import * as exp from './export.mjs';
import * as llm from './llm.mjs';
import * as skills from './skills.mjs';
import * as clarify from './clarify.mjs';
import * as attachment from './attachment.mjs';
import * as sessionTitle from './session-title.mjs';
import * as rpt from './reports.mjs';
import * as rec from './recurring.mjs';

const PORT = Number(process.env.LOCAL_BACKEND_PORT || 8000);
const HOST = process.env.LOCAL_BACKEND_HOST || '127.0.0.1';

const TOOL_NAMES = [
  'list_sets', 'list_vouchers', 'get_voucher', 'get_ledger', 'get_report',
  'list_assets', 'list_asset_categories', 'list_subjects', 'list_auxiliaries',
  'list_invoices', 'get_closing_status', 'create_voucher', 'create_asset',
  'create_subject', 'create_auxiliary', 'upload_invoice', 'create_invoice',
  'list_invoice_templates', 'create_invoice_voucher',
  'list_recurring', 'save_recurring', 'generate_recurring', 'adjust_recurring', 'recurring_reminder',
  clarify.TOOL_NAME, clarify.ANALYZE_TOOL, 'read_attachment', 'data_audit',
];

const TOOL_DESCRIPTIONS = {
  [clarify.TOOL_NAME]: clarify.TOOL_DESCRIPTION,
  [clarify.ANALYZE_TOOL]: clarify.ANALYZE_DESCRIPTION,
  read_attachment: '读取并解析任意格式附件（文本/CSV/JSON/MD/HTML/XLSX/DOCX/PPTX/ODT/PDF/RTF/XLS/图片），返回可录入的表格与文本',
  get_report: '按 kind/period/format 生成本地账套真实报表，返回 columns+rows 结构化数据、行数与下载链接（不再是空 rows）',
  data_audit: '对账套做多轮数据核验：借贷平衡、分录一致性、科目有效性、凭证号唯一、两套独立 SQL 重算看板指标、金额精度、前端单位契约；返回逐项结论与数据快照哈希，只读不改动数据',
  create_voucher: '按摘要与分录创建记账凭证',
  list_vouchers: '查询当前账套凭证列表',
  list_recurring: '查询固定支出（工资/房租/社保等）当月清单：金额、是否已生成凭证、是否本月已调整',
  save_recurring: '新建或修改固定支出模板；可按类别+金额快速生成分录，也可直接给完整分录',
  generate_recurring: '为指定月份生成缺失的固定支出凭证（草稿、幂等，一个模板一个月只生成一张）',
  adjust_recurring: '调整固定支出：scope=this_month 直接改本月（草稿凭证随之更新）、next_month 提前改下月、template 长期改模板',
  recurring_reminder: '每月首条消息用：返回本月固定支出一句话摘要与调整选项，mark=true 时标记为已提醒',
};

const TOOL_SCHEMAS = {
  save_recurring: {
    type: 'object',
    properties: {
      id: { type: 'number', description: '修改已有固定支出时传，新增不传' },
      name: { type: 'string', description: '名称，如「工资」「房租」' },
      category: { type: 'string', description: '类别：工资/社保/公积金/房租/水电/物业，可按类别自动生成分录' },
      amount: { type: 'number', description: '按类别建时的金额' },
      entries: { type: 'array', description: '完整分录：[{summary,subject_code,debit,credit}]，给了就不看 category/amount' },
      day: { type: 'number', description: '每月几号入账，默认 1' },
      start_period: { type: 'string', description: '生效起始月 YYYY-MM' },
      end_period: { type: 'string', description: '生效结束月 YYYY-MM' },
      note: { type: 'string' },
    },
    required: ['name'],
  },
  list_recurring: {
    type: 'object',
    properties: { period: { type: 'string', description: '月份 YYYY-MM，默认当月' } },
  },
  generate_recurring: {
    type: 'object',
    properties: { period: { type: 'string', description: '月份 YYYY-MM，默认当月' } },
  },
  adjust_recurring: {
    type: 'object',
    properties: {
      id: { type: 'number', description: '固定支出 id' },
      name: { type: 'string', description: '或用名称指定' },
      scope: { type: 'string', description: 'this_month（默认，直接改本月）/ next_month（提前改下月）/ template（长期改）' },
      amount: { type: 'number', description: '新金额（沿用原分录结构）' },
      entries: { type: 'array', description: '或给完整新分录' },
      period: { type: 'string', description: '月份 YYYY-MM，默认当月' },
      reason: { type: 'string' },
    },
  },
  recurring_reminder: {
    type: 'object',
    properties: {
      period: { type: 'string', description: '月份 YYYY-MM，默认当月' },
      mark: { type: 'boolean', description: 'true 表示标记本月已提醒' },
      auto: { type: 'boolean', description: 'false 时只读不生成' },
    },
  },
  [clarify.TOOL_NAME]: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: '会话 ID，多轮追问必须保持一致' },
      message: { type: 'string', description: '用户原话或上一题的选项值/答案' },
      force: { type: 'boolean', description: 'true 时忽略意图识别，强制完整问一遍' },
    },
  },
  [clarify.ANALYZE_TOOL]: {
    type: 'object',
    properties: { message: { type: 'string', description: '待判断的用户消息' }, session_id: { type: 'string' } },
    required: ['message'],
  },
  read_attachment: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '本地文件绝对路径（与 content 二选一）' },
      name: { type: 'string', description: '文件名，含扩展名' },
      content: { type: 'string', description: '文件内容的 base64（与 path 二选一）' },
      session_id: { type: 'string' },
    },
  },
  data_audit: {
    type: 'object',
    properties: {
      period: { type: 'string', description: '会计期间 YYYY-MM，默认当前月' },
      rounds: { type: 'number', description: '连续核验轮数，默认 3，结果必须完全一致' },
      expect_clean: { type: 'boolean', description: 'true 时额外要求无业务凭证且所有看板指标为 0' },
    },
  },
  get_report: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['vouchers', 'ledger', 'dashboard', 'subjects', 'balance', 'income', 'cash'],
        description: '报表类型：凭证清单 / 科目余额表 / 经营概览 / 会计科目表',
      },
      period: { type: 'string', description: '期间 YYYY-MM，留空取当前月' },
      format: { type: 'string', enum: ['csv', 'xlsx', 'json', 'md', 'html'], description: '同时生成的文件格式，默认 json' },
      limit: { type: 'number', description: '最多返回的行数，默认 200，上限 1000' },
    },
  },
};

const SEED_FALLBACK = {
  '/api/roles': 'roles',
  '/api/organization/tree': 'organization_tree',
  '/api/agent/skills': 'agent_skills',
  '/api/agent/my-rules': 'agent_my_rules',
  '/api/dashboard/biz-settings': 'dashboard_biz_settings',
};

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-set-id, mcp-session-id',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    ...extraHeaders,
  });
  res.end(text);
}

const reply = (res, result, status = 200) => sendJson(res, status, result);
/** 运行时配置：优先进程环境变量，其次 .env（支持热改，不用重启） */
const runtimeEnv = (name, fallback = '') => process.env[name] || readEnv(name) || fallback;
/** 当前月份（本地时区） */
const currentPeriod = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);
const bearer = (h) => (typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : '');

function sendDownload(res, filename, mime, buf) {
  res.writeHead(200, {
    'content-type': mime,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'content-length': Buffer.byteLength(buf),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(buf);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

/* ---------------- MCP JSON-RPC ---------------- */

function mcpResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleMcp(res, body, authHeader) {
  const { id, method, params = {} } = body || {};
  // 通知类消息无响应体、无副作用，且按 MCP 规范可能在 initialize 之前到达。
  // 放在鉴权之前可避免客户端因尚未带上令牌而收到 401 判定连接失败。
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    res.writeHead(202, { 'access-control-allow-origin': '*' });
    return res.end();
  }
  const token = bearer(authHeader);
  const record = biz.tokenFromRequest(token);
  if (!record) return sendJson(res, 401, { code: 401, message: '缺少访问令牌' });

  if (method === 'initialize') {
    return sendJson(res, 200, mcpResult(id, {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'zhuangdian-guanzhang-local', version: '2.0.0' },
    }), { 'mcp-session-id': randomUUID() });
  }
  if (method === 'ping') return sendJson(res, 200, mcpResult(id, {}));
  if (method === 'tools/list') {
    return sendJson(res, 200, mcpResult(id, {
      tools: TOOL_NAMES.map((name) => ({
        name,
        description: TOOL_DESCRIPTIONS[name] || `妆点管账本地工具 ${name}`,
        inputSchema: TOOL_SCHEMAS[name] || { type: 'object', properties: {}, additionalProperties: true },
      })),
    }));
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    let result;
    try {
      if (name === 'data_audit') {
        result = biz.ok(runAuditMulti(db, {
          setId: record.default_set_id || DEFAULT_SET_ID,
          period: args.period,
          expectClean: Boolean(args.expect_clean),
        }, args.rounds || 3));
      } else if (name === clarify.ANALYZE_TOOL) result = clarify.analyze(args);
      else if (name === 'read_attachment') {
        result = attachment.callTool({ ...args, set_id: record.default_set_id || DEFAULT_SET_ID });
      } else if (name === clarify.TOOL_NAME) {
        result = await clarify.callTool({ ...args, set_id: record.default_set_id || DEFAULT_SET_ID },
          record.default_set_id || DEFAULT_SET_ID);
      } else {
        result = biz.callTool(name, args, record.default_set_id || DEFAULT_SET_ID, 'workbuddy');
      }
    } catch (e) {
      result = { code: 1, message: `工具执行失败：${e.message}` };
    }
    return sendJson(res, 200, mcpResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: result.code !== 0,
    }));
  }
  return sendJson(res, 200, mcpError(id ?? null, -32601, `Method not found: ${method}`));
}

/* ---------------- DeepSeek SSE 智能体 ---------------- */

// 标准 SSE：必须输出 `event:` 行。前端 AgentWorkspace 的解析器以 event: 行
// 决定事件名（缺省 message），并把 data 当作事件负载；只写 data 包裹层会导致
// content/done/error 全部落空，界面永远停在「思考中…」。
function sse(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  });
}

/** 把整段文本切成 SSE content 块，前端逐块累加 */
function textChunks(text, size = 3) {
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += size) {
    out.push(lines.slice(i, i + size).join('\n') + (i + size < lines.length ? '\n' : ''));
  }
  return out.length ? out : [text];
}

/**
 * 技能执行 SSE。前端契约（AgentWorkspace 的 handler t）：
 *   tool(status=running) 显示「正在执行…」→ tool(status!=running) 清除
 *   content { text } 逐块累加 → done 结束思考并把内容落成 assistant 消息
 *   error { message } 弹错并停止思考；任何分支都必须以 done 收尾
 * 注意：本链路不调用 LLM，纯本地汇总，避免网络/模型慢导致再次卡「思考中」。
 */
async function runSkillSse(res, skillId, body, setId) {
  sseHead(res);
  const sessionId = body.session_id || randomUUID();
  sessionTitle.ensureSession(setId, sessionId, '', '技能执行');
  try {
    const meta = skills.findSkill(skillId);
    if (!meta) throw new Error(`未知技能：${skillId}`);
    sse(res, 'tool', { status: 'running', name: skillId, label: meta.name });
    const result = skills.runSkill(skillId, body, setId);
    sse(res, 'tool', { status: 'done', name: skillId, label: meta.name });
    biz.saveAgentMessage(sessionId, 'user', result.userLine);
    for (const text of result.chunks) sse(res, 'content', { text });
    biz.saveAgentMessage(sessionId, 'assistant', result.text);
  } catch (e) {
    sse(res, 'error', { message: `技能执行失败：${e.message}` });
  } finally {
    // 无论成功失败都发 done：前端只有 done/error 才会把 I.value 置回 false
    sse(res, 'done', {});
    res.end();
  }
}

async function agentChat(res, body, setId) {
  sseHead(res);
  const message = body.message || '';
  const sessionId = body.session_id || randomUUID();

  // 会话自动命名：首条有效用户消息立即生成短标题，并通过 SSE 让前端同步刷新侧栏/顶栏。
  // 放在 clarify / LLM 之前，即使模型未配置或走追问分支，会话名也一定生成。
  const titled = sessionTitle.trackFirstMessage(setId, sessionId, message);
  biz.saveAgentMessage(sessionId, 'user', message);
  if (titled) sse(res, 'session_title', titled);

  // 意图追问工具：不依赖 LLM，模型未配置时也能完成多轮反问与精确产出。
  // 结构化选项走独立 clarify 事件，前端注入层 tee 响应流后渲染可点击卡片。
  try {
    const r = await clarify.handle({
      sessionId, message, setId,
      // 只有新版注入层（能渲染可点击选项）才在聊天窗口反问，避免旧缓存页面
      // 只显示文字卡片却没有按钮，把用户卡在「没看懂这个回答」的循环里。
      capable: body.clarify === 1 || body.clarify === true,
      force: Boolean(body.clarify_force),
    });
    if (r.type !== 'passthrough') {
      for (const chunk of textChunks(r.text)) sse(res, 'content', { text: chunk });
      sse(res, 'clarify', r.payload);
      biz.saveAgentMessage(sessionId, 'assistant', r.text);
      sse(res, 'done', {});
      return res.end();
    }
  } catch (e) {
    sse(res, 'error', { message: `意图追问失败：${e.message}` });
    sse(res, 'done', {});
    return res.end();
  }

  // 每次请求都重新读 agent_config：改模型/key 无需重启即可生效。
  // llm.currentConfig 负责把 dsv4.1f1017 之类的别名解析成上游真正接受的 model id。
  const { key, baseUrl, model } = llm.currentConfig(get('SELECT * FROM agent_config WHERE user_id = 1'));
  if (!key) {
    sse(res, 'error', { message: '未配置 DEEPSEEK_API_KEY，请在 .env 中设置' });
    sse(res, 'done', {});
    return res.end();
  }

  // 前端没有请求级超时：模型慢或连接挂起时会永久停在「思考中…」。
  // 这里补 12s 慢提示 / 45s 无首字中止 / 120s 总时长硬上限，并统一走 error+done。
  const controller = new AbortController();
  let gotFirstToken = false;
  let answer = '';
  const slowTimer = setTimeout(() => {
    if (!gotFirstToken) {
      sse(res, 'tool', { status: 'running', name: '模型响应较慢，仍在生成', label: '模型响应较慢，仍在生成' });
    }
  }, 12000);
  const firstTimer = setTimeout(() => {
    if (!gotFirstToken) controller.abort(new Error('45 秒内未收到模型首字'));
  }, 45000);
  const totalTimer = setTimeout(() => controller.abort(new Error('生成超过 120 秒')), 120000);
  const clearTimers = () => { clearTimeout(slowTimer); clearTimeout(firstTimer); clearTimeout(totalTimer); };
  res.on('close', clearTimers);

  try {
    const history = biz.agentMessages(sessionId).data.slice(-10).map((m) => ({ role: m.role, content: m.content }));
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: 'system', content: biz.agentSystemPrompt(setId) },
          ...history,
        ],
      }),
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) {
      // 透出上游的 invalid model / 余额不足 / 限流等原因，避免静默失败
      const detail = upstream.ok ? '' : await llm.readUpstreamError(upstream);
      throw new Error(`模型请求失败（HTTP ${upstream.status}${model ? ` / ${model}` : ''}）${detail ? `：${detail}` : ''}`);
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (delta) {
            if (!gotFirstToken) { gotFirstToken = true; clearTimeout(slowTimer); clearTimeout(firstTimer); }
            answer += delta;
            sse(res, 'content', { text: delta });
          }
        } catch { /* 忽略无法解析的增量 */ }
      }
    }
    if (!gotFirstToken && !answer) throw new Error('模型未返回任何内容');
  } catch (e) {
    const msg = e.message || '';
    sse(res, 'error', { message: e.name === 'AbortError' || /超时|超过 120|未收到模型首字/.test(msg)
      ? `模型响应超时：${msg}，请重试或稍后再问`
      : msg.startsWith('模型请求失败') ? msg : `智能体异常：${msg}` });
  } finally {
    clearTimers();
    if (answer) biz.saveAgentMessage(sessionId, 'assistant', answer);
  }
  sse(res, 'done', {});
  res.end();
}

/* ---------------- 路由 ---------------- */

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  const method = req.method.toUpperCase();
  const q = Object.fromEntries(u.searchParams.entries());

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, x-set-id, mcp-session-id',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });
    return res.end();
  }

  if (p === '/__local/health') {
    return reply(res, {
      ok: true, service: 'zhuangdian-local-backend',
      set_id: DEFAULT_SET_ID,
      subjects: get('SELECT COUNT(*) AS n FROM subjects').n,
      vouchers: get('SELECT COUNT(*) AS n FROM vouchers').n,
      users: get('SELECT COUNT(*) AS n FROM users').n,
      llm_configured: Boolean(get('SELECT configured FROM agent_config WHERE user_id = 1')?.configured),
    });
  }

  const body = method === 'GET' || method === 'HEAD' ? {} : await readBody(req);

  if (p === '/mcp' && method === 'POST') return await handleMcp(res, body, req.headers.authorization);
  // streamableHttp 客户端常先 GET 建通知通道 / DELETE 关会话：给合法响应，避免连接被判失败
  if (p === '/mcp' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache', connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(': zd-mcp-ready\n\n');
    const keep = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 20000);
    res.on('close', () => clearInterval(keep));
    return;
  }
  if (p === '/mcp' && (method === 'DELETE' || method === 'HEAD')) {
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/mcp') return sendJson(res, 405, { error: '请使用 POST 调用 MCP（JSON-RPC 2.0）' });

  const clientIp = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const isLocalClient = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === 'localhost';

  if (p === '/api/auth/login' && method === 'POST') {
    const st = biz.lockState(body.username, clientIp);
    if (st.locked) return reply(res, biz.fail(`密码错误次数过多，账号已锁定至 ${st.until}`));
    return reply(res, biz.login(body, null, clientIp));
  }
  // 注册来源由 REGISTER_MODE 决定：open(默认) / local / closed
  if (p === '/api/auth/register' && method === 'POST') {
    const policy = biz.registerPolicy(runtimeEnv('REGISTER_MODE', 'open'), clientIp);
    if (!policy.allowed) return reply(res, biz.fail(policy.reason));
    const r = biz.register(body, clientIp);
    return reply(res, r);
  }

  const user = biz.userFromToken(bearer(req.headers.authorization));
  if (!user) return sendJson(res, 401, { code: 401, message: '未登录或登录已过期' });

  const setId = biz.parseSetId(req.headers['x-set-id']);
  const actor = user.username;

  if (p === '/api/auth/logout' && method === 'POST') {
    return reply(res, biz.logout(bearer(req.headers.authorization)));
  }

  // 越权保护：管理类接口只允许管理员；账套数据需在当前用户可访问范围内
  const ADMIN_ONLY = ['/api/accounts', '/api/roles', '/api/sets', '/api/tokens', '/api/agent/llm-config'];
  if (ADMIN_ONLY.some((x) => p === x || p.startsWith(`${x}/`))) {
    if (!biz.isAdminUser(user)) return sendJson(res, 403, { code: 403, message: '当前账号无管理权限' });
  }
  // 记账写操作：管理员或 会计/出纳 角色，普通用户只读
  const WRITE_PREFIX = ['/api/vouchers', '/api/assets', '/api/invoices', '/api/subjects',
    '/api/closing', '/api/auxiliaries', '/api/agent/actions', '/api/recurring'];
  if (['POST', 'PUT', 'DELETE'].includes(method)
    && WRITE_PREFIX.some((x) => p === x || p.startsWith(`${x}/`))
    && !biz.canWrite(user)) {
    return sendJson(res, 403, { code: 403, message: '当前账号为只读权限，不能记账' });
  }
  if (p.startsWith('/api/') && !biz.canAccessSet(user, setId)) {
    return sendJson(res, 403, { code: 403, message: '当前账号无权访问该账套' });
  }

  if (p === '/api/auth/change-password' && method === 'POST') return reply(res, biz.changePassword(user.id, body));

  // 数据核验（只读）：随时可查账套是否自洽；支持多轮一致性校验
  if (p === '/api/data/audit' && method === 'GET') {
    const r = runAuditMulti(db, {
      setId,
      period: q.period || undefined,
      expectClean: q.expect_clean === '1' || q.expect_clean === 'true',
    }, Number(q.rounds) || 3);
    return reply(res, biz.ok(r));
  }

  // 本地账户 / 角色管理：真实读写 SQLite，不再落到「暂未实现」兜底
  if (p === '/api/accounts' && method === 'GET') return reply(res, biz.listAccounts(q.keyword));
  if (p === '/api/accounts' && method === 'POST') return reply(res, biz.createAccount(body));
  let mm = p.match(/^\/api\/accounts\/(\d+)\/status$/);
  if (mm && method === 'PUT') return reply(res, biz.setAccountStatus(Number(mm[1]), body.status, user.id));
  mm = p.match(/^\/api\/accounts\/(\d+)\/sets$/);
  if (mm) {
    if (method === 'GET') return reply(res, biz.accountSets(Number(mm[1])));
    if (method === 'PUT') return reply(res, biz.saveAccountSets(Number(mm[1]), body.setIds));
  }
  mm = p.match(/^\/api\/accounts\/(\d+)$/);
  if (mm) {
    if (method === 'PUT') return reply(res, biz.updateAccount(Number(mm[1]), body));
    if (method === 'DELETE') {
      const token = String((body && body.token) || q.token || '').trim();
      const r = biz.deleteAccount(Number(mm[1]), user.id, { token });
      return reply(res, r, r.code === 428 ? 428 : 200);
    }
  }
  if (p === '/api/roles' && method === 'GET') return reply(res, biz.listRoles(q.keyword));
  if (p === '/api/roles' && method === 'POST') return reply(res, biz.createRole(body));
  mm = p.match(/^\/api\/roles\/(\d+)\/menus$/);
  if (mm) {
    if (method === 'GET') return reply(res, biz.roleMenus(Number(mm[1])));
    if (method === 'PUT') return reply(res, biz.saveRoleMenus(Number(mm[1]), body.paths));
  }
  mm = p.match(/^\/api\/roles\/(\d+)$/);
  if (mm) {
    if (method === 'PUT') return reply(res, biz.updateRole(Number(mm[1]), body));
    if (method === 'DELETE') return reply(res, biz.deleteRole(Number(mm[1])));
  }

  // 账套
  if (p === '/api/sets/enabled' && method === 'GET') return reply(res, biz.listSets(true));
  if (p === '/api/sets' && method === 'GET') return reply(res, biz.listSets());
  if (p === '/api/sets' && method === 'POST') return reply(res, biz.createSet(body));
  let m = p.match(/^\/api\/sets\/(\d+)$/);
  if (m) {
    if (method === 'PUT') return reply(res, biz.updateSet(Number(m[1]), body));
    if (method === 'GET') return reply(res, biz.listSets());
  }

  // 科目
  if (p === '/api/subjects' && method === 'GET') return reply(res, biz.listSubjects(setId));
  if (p === '/api/subjects' && method === 'POST') return reply(res, biz.createSubject(setId, body));
  m = p.match(/^\/api\/subjects\/(\d+)$/);
  if (m && method === 'DELETE') return reply(res, biz.deleteSubject(setId, Number(m[1])));

  // 凭证
  if (p === '/api/vouchers' && method === 'GET') return reply(res, biz.listVouchers(setId, q));
  if (p === '/api/vouchers' && method === 'POST') return reply(res, biz.createVoucher(setId, body, actor));

  // ---------------- 固定支出（周期性凭证） ----------------
  if (p === '/api/recurring' && method === 'GET') return reply(res, rec.plan(setId, q.period || currentPeriod()));
  if (p === '/api/recurring/templates' && method === 'GET') return reply(res, { code: 0, message: '', data: rec.listTemplates(setId) });
  if (p === '/api/recurring' && method === 'POST') return reply(res, rec.saveTemplate(setId, body, actor));
  if (p === '/api/recurring/reminder' && method === 'GET') {
    return reply(res, rec.reminder(setId, q.period || currentPeriod(), {
      auto: q.auto !== '0', mark: q.mark === '1',
    }));
  }
  if (p === '/api/recurring/reminder/ack' && method === 'POST') {
    return reply(res, rec.markNotified(setId, body.period || currentPeriod()));
  }
  if (p === '/api/recurring/generate' && method === 'POST') {
    return reply(res, rec.generateForPeriod(setId, body.period || currentPeriod(), actor));
  }
  m = p.match(/^\/api\/recurring\/(\d+)$/);
  if (m && method === 'PUT') return reply(res, rec.saveTemplate(setId, { ...body, id: Number(m[1]) }, actor));
  if (m && method === 'DELETE') return reply(res, rec.removeTemplate(setId, Number(m[1])));
  m = p.match(/^\/api\/recurring\/(\d+)\/status$/);
  if (m && method === 'POST') return reply(res, rec.setTemplateActive(setId, Number(m[1]), Boolean(body.active)));
  m = p.match(/^\/api\/recurring\/(\d+)\/override$/);
  if (m && method === 'POST') {
    return reply(res, rec.setOverride(setId, Number(m[1]), body.period, body.entries, body.reason || ''));
  }
  if (m && method === 'DELETE') return reply(res, rec.dropOverride(Number(m[1]), q.period));
  m = p.match(/^\/api\/recurring\/(\d+)\/adjust$/);
  if (m && method === 'POST') {
    return reply(res, rec.adjustThisMonth(setId, body.period || currentPeriod(), Number(m[1]), body.entries, actor));
  }

  m = p.match(/^\/api\/vouchers\/(\d+)\/(audit|review|post|unpost|unaudit|reverse)$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const action = m[2];
    const result = action === 'audit' || action === 'review' ? biz.auditVoucher(setId, id, actor)
      : action === 'post' ? biz.postVoucher(setId, id, actor)
        : action === 'unpost' || action === 'reverse' ? biz.unpostVoucher(setId, id, actor)
          : biz.unauditVoucher(setId, id, actor);
    return reply(res, result);
  }
  m = p.match(/^\/api\/vouchers\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'GET') return reply(res, biz.getVoucher(setId, id));
    if (method === 'DELETE') return reply(res, biz.deleteVoucher(setId, id));
    if (method === 'PUT') return reply(res, biz.getVoucher(setId, id));
  }

  // 账簿 / 看板 / 结账
  if (p === '/api/ledger/balance' && method === 'GET') return reply(res, biz.ledgerBalance(setId, q.period || ''));
  if (p === '/api/ledger/detail' && method === 'GET') return reply(res, biz.ledgerDetail(setId, q));
  if (p === '/api/dashboard/overview' && method === 'GET') return reply(res, biz.dashboardOverview(setId, q.period));
  if (p === '/api/dashboard/biz-settings' && method === 'GET') return reply(res, biz.bizSettings());
  m = p.match(/^\/api\/dashboard\/([a-z][a-z-]*)$/);
  if (m && method === 'GET' && !['overview', 'biz-settings'].includes(m[1])) {
    return reply(res, biz.dashboardSection(m[1], setId, q.period || new Date().toISOString().slice(0, 7)));
  }
  if (p === '/api/closing/list' && method === 'GET') return reply(res, biz.closingList(setId, q.period));

  // 开放令牌
  if (p === '/api/tokens' && method === 'GET') return reply(res, biz.listTokens());
  if (p === '/api/tokens' && method === 'POST') return reply(res, biz.createToken(body));
  m = p.match(/^\/api\/tokens\/(\d+)$/);
  if (m) {
    if (method === 'PUT') return reply(res, biz.updateToken(Number(m[1]), body));
    if (method === 'DELETE') return reply(res, biz.deleteToken(Number(m[1])));
  }

  // 智能体：模型配置（前端保存用 PUT，POST 保留兼容）/ 真实连通性探测
  if (p === '/api/agent/llm-config' && method === 'GET') return reply(res, biz.agentConfig());
  if (p === '/api/agent/llm-config' && (method === 'PUT' || method === 'POST')) {
    return reply(res, biz.saveAgentConfig(body));
  }
  if (p === '/api/agent/llm-config' && method === 'DELETE') return reply(res, biz.resetAgentConfig());
  if (p === '/api/agent/llm-config/test' && method === 'POST') {
    const cfg = Object.keys(body || {}).length ? body : get('SELECT * FROM agent_config WHERE user_id = 1');
    const t = await llm.testModel(cfg);
    return reply(res, t.ok ? biz.ok({ effective_model: t.effective_model }, t.message) : biz.fail(t.message));
  }
  if (p === '/api/agent/skills' && method === 'GET') return reply(res, biz.agentSkills());

  // 技能执行：与 /api/agent/chat 独立的 SSE 链路；缺此路由会让界面永久「思考中…」
  m = p.match(/^\/api\/agent\/skills\/([^/]+)\/run$/);
  if (m && method === 'POST') return runSkillSse(res, decodeURIComponent(m[1]), body, setId);

  // 设置面板「技能」tab：自定义提示词技能（真实落库，不假成功）
  if (p === '/api/agent/prompt-skills' && method === 'GET') {
    return reply(res, biz.ok(skills.listPromptSkills()));
  }
  if (p === '/api/agent/prompt-skills' && method === 'POST') {
    try {
      const id = skills.createPromptSkill(body);
      return reply(res, biz.ok({ id }, '已添加技能'));
    } catch (e) { return reply(res, biz.fail(e.message)); }
  }
  m = p.match(/^\/api\/agent\/prompt-skills\/(\d+)$/);
  if (m) {
    try {
      if (method === 'PUT') {
        skills.updatePromptSkill(Number(m[1]), body);
        return reply(res, biz.ok(null, '已保存'));
      }
      if (method === 'DELETE') {
        skills.deletePromptSkill(Number(m[1]));
        return reply(res, biz.ok(null, '已删除'));
      }
    } catch (e) { return reply(res, biz.fail(e.message)); }
  }
  if (p === '/api/agent/actions/confirm' && method === 'POST') {
    return reply(res, biz.fail('没有待确认的操作（本地技能均为只读查询，无需二次确认）'));
  }
  // 全格式附件读取：兼容前端 {image,file_name,mime}、REST {content,name}、MCP {path}
  if (p === '/api/agent/upload' && method === 'POST') {
    try {
      const r = attachment.readAttachment({ ...body, session_id: body.session_id || '', set_id: setId });
      return reply(res, { code: 0, data: r, message: r.message });
    } catch (e) { return reply(res, biz.fail(e.message)); }
  }
  if (p === '/api/agent/attachments/formats' && method === 'GET') {
    return reply(res, biz.ok({ extensions: attachment.SUPPORTED_EXTS, max_mb: attachment.MAX_SIZE / 1024 / 1024 }));
  }
  if (p === '/api/agent/attachments' && method === 'GET') {
    return reply(res, biz.ok({ list: attachment.listAttachments(Number(q.limit) || 20) }));
  }
  if (p === '/api/agent/attachments/read' && method === 'POST') {
    try { return reply(res, biz.ok(attachment.readAttachment({ ...body, set_id: setId }))); }
    catch (e) { return reply(res, biz.fail(e.message)); }
  }

  // 智能体会话：列表 / 新建 / 消息 / 重命名 / 置顶 / 删除 / 标题精修
  if (p === '/api/agent/sessions' && method === 'GET') return reply(res, biz.agentSessions(setId));
  // 三大报表：资产负债 / 利润 / 现金流。只读计算 + 模板读写 + 重分类开关
  if (p === '/api/reports/balance/default-formulas' && method === 'GET') {
    return reply(res, biz.ok({ rows: rpt.defaultTemplates('balance') }));
  }
  if (p === '/api/reports/balance/reclassify' && method === 'POST') {
    try {
      const on = rpt.setReclass(db, setId, Boolean(body && body.on));
      return reply(res, biz.ok({ reclassOn: on }, on ? '已开启重分类' : '已关闭重分类'));
    } catch (e) { return reply(res, biz.fail(e.message)); }
  }
  m = p.match(/^\/api\/reports\/([a-z]+)\/items$/);
  if (m && method === 'PUT') {
    try {
      const n = rpt.saveTemplates(db, setId, m[1], body && body.items);
      return reply(res, biz.ok({ saved: n }, `已保存 ${n} 行`));
    } catch (e) { return reply(res, biz.fail(e.message)); }
  }
  m = p.match(/^\/api\/reports\/([a-z]+)\/reset$/);
  if (m && method === 'POST') {
    try {
      const n = rpt.resetTemplates(db, setId, m[1]);
      return reply(res, biz.ok({ reset: n }, '已恢复默认模板'));
    } catch (e) { return reply(res, biz.fail(e.message)); }
  }
  m = p.match(/^\/api\/reports\/([a-z]+)$/);
  if (m && method === 'GET') {
    try {
      const out = rpt.computeReport(db, setId, m[1], q.period || new Date().toISOString().slice(0, 7));
      return reply(res, biz.ok({
        type: out.type, period: out.period, title: out.title,
        rows: out.rows, warnings: out.warnings,
        reclassOn: out.type === 'balance' ? rpt.getReclass(db, setId) : false,
      }));
    } catch (e) { return reply(res, biz.fail(e.message)); }
  }
  // 活跃度快照：桌面端轮询用，只回计数，体积极小
  if (p === '/api/agent/activity' && method === 'GET') return reply(res, biz.agentActivity(setId));
  if (p === '/api/agent/sessions' && method === 'POST') return reply(res, biz.createAgentSession(setId, body.title));
  m = p.match(/^\/api\/agent\/sessions\/([^/]+)\/messages$/);
  if (m && method === 'GET') return reply(res, biz.agentMessages(decodeURIComponent(m[1])));
  m = p.match(/^\/api\/agent\/sessions\/([^/]+)\/auto-title$/);
  if (m && method === 'POST') {
    const r = await sessionTitle.refineTitle(setId, decodeURIComponent(m[1]));
    return reply(res, r ? biz.ok(r) : biz.fail('会话不存在或不属于当前账套'));
  }
  m = p.match(/^\/api\/agent\/sessions\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (method === 'PUT') return reply(res, biz.updateAgentSession(setId, id, body));
    if (method === 'DELETE') return reply(res, biz.deleteAgentSession(setId, id));
  }

  // 智能体设置面板：知识记忆 / 我的规则
  if (p === '/api/agent/knowledge' && method === 'GET') return reply(res, biz.agentKnowledge(setId));
  if (p === '/api/agent/knowledge/memory' && method === 'POST') {
    return reply(res, biz.createAgentMemory(setId, body.content));
  }
  m = p.match(/^\/api\/agent\/knowledge\/(\d+)$/);
  if (m && method === 'DELETE') return reply(res, biz.deleteAgentMemory(setId, Number(m[1])));
  if (p === '/api/agent/rules' && method === 'GET') return reply(res, biz.agentRules(setId));
  if (p === '/api/agent/rules' && method === 'PUT') return reply(res, biz.saveAgentRules(setId, body.content));
  if (p === '/api/agent/my-rules' && method === 'GET') return reply(res, biz.agentRules(setId));

  // 意图追问工具：聊天窗口走 /api/agent/chat 的 SSE，这里给外部智能体/调试留 JSON 端点
  if (p === '/api/agent/clarify/state' && method === 'GET') {
    return reply(res, biz.ok(clarify.stateOf(q.session_id || '')));
  }
  if (p === '/api/agent/clarify/reset' && method === 'POST') {
    return reply(res, biz.ok(clarify.reset(body.session_id || q.session_id || '')));
  }
  if (p === '/api/agent/clarify/answer' && method === 'POST') {
    return reply(res, await clarify.callTool(body, setId));
  }
  if (p === '/api/agent/clarify/prefs' && method === 'GET') {
    return reply(res, biz.ok(clarify.prefsOf(q.session_id || '')));
  }
  if (p === '/api/agent/clarify/prefs' && method === 'POST') {
    return reply(res, biz.ok(clarify.setPrefs({
      sessionId: body.session_id || q.session_id || '',
      enabled: body.enabled !== false && body.enabled !== 0,
      scope: body.scope || 'global',
    })));
  }
  if (p === '/api/agent/clarify/analyze' && method === 'POST') {
    return reply(res, clarify.analyze(body));
  }
  if (p === '/api/agent/clarify/last' && method === 'GET') {
    return reply(res, biz.ok({ payload: clarify.lastOf(q.session_id || '') }));
  }

  if (p === '/api/agent/chat' && method === 'POST') return agentChat(res, body, setId);

  // 辅助档案 / 资产 / 发票
  if (p === '/api/auxiliaries' && method === 'GET') return reply(res, biz.listAuxiliaries(setId));
  if (p === '/api/auxiliaries' && method === 'POST') return reply(res, biz.createAuxiliary(setId, body));
  if (p === '/api/assets' && method === 'GET') return reply(res, biz.listAssets(setId));
  if (p === '/api/assets' && method === 'POST') return reply(res, biz.createAsset(setId, body));
  if (p === '/api/asset-categories' && method === 'GET') return reply(res, biz.listAssetCategories(setId));
  if (p === '/api/asset-categories' && method === 'POST') {
    const info = run('INSERT INTO asset_categories (set_id, name, created_at) VALUES (?, ?, ?)', setId, body.name || '', now());
    return reply(res, biz.ok(get('SELECT * FROM asset_categories WHERE id = ?', Number(info.lastInsertRowid))));
  }
  if (p === '/api/invoices' && method === 'GET') return reply(res, biz.listInvoices(setId, q));
  if (p === '/api/invoices/upload' && method === 'POST') return reply(res, biz.createInvoice(setId, body));
  if (p === '/api/invoices/templates' && method === 'GET') return reply(res, biz.listInvoiceTemplates(setId));
  m = p.match(/^\/api\/invoices\/(\d+)\/voucher$/);
  if (m && method === 'POST') return reply(res, biz.createInvoiceVoucher(setId, Number(m[1]), actor));

  // 报表导出中心（内置格式 + Filee 格式转换桥接）
  if (p === '/api/export/formats' && method === 'GET') return reply(res, biz.ok(exp.formats()));
  if (p === '/api/export/files' && method === 'GET') return reply(res, biz.ok(exp.listFiles()));
  if (p === '/api/export/upload' && method === 'POST') {
    try { return reply(res, biz.ok(exp.upload(body))); }
    catch (e) { return reply(res, biz.fail(e.message)); }
  }
  if (p === '/api/export/report' && method === 'GET') {
    let out;
    try {
      out = exp.buildReport({ kind: q.kind, period: q.period, format: q.format, setId });
    } catch (e) {
      return reply(res, biz.fail(e.message));
    }
    return sendDownload(res, out.filename, out.mime, out.content);
  }
  if (p === '/api/export/download' && method === 'GET') {
    const name = path.basename(q.file || '');
    if (!name || name.includes('..') || name.length > 200) return reply(res, biz.fail('非法文件名'));
    const dir = q.dir === 'converted' ? path.join(exp.EXPORT_DIR, 'converted') : exp.EXPORT_DIR;
    const fp = path.join(dir, name);
    if (!fs.existsSync(fp)) return reply(res, biz.fail('文件不存在'));
    return sendDownload(res, name, exp.mimeFor(name), fs.readFileSync(fp));
  }
  if (p === '/api/export/convert' && method === 'POST') {
    try {
      return reply(res, biz.ok(await exp.convert(body)));
    } catch (e) {
      return reply(res, biz.fail(e.message));
    }
  }

  // seed 兜底（保持与云端一致的响应结构）
  if (method === 'GET' && SEED_FALLBACK[p]) {
    const seed = readSeed(SEED_FALLBACK[p]);
    return reply(res, seed ?? biz.ok([]));
  }
  if (method === 'GET') return reply(res, biz.ok([]));
  // SSE 类请求绝不能落到普通 JSON 兜底：前端流式解析器收不到 event: 行会永久
  // 停在「思考中…」。即使将来新增 SSE 路径忘了实现，也必须回 error+done 收尾。
  if (method === 'POST' && (p === '/api/agent/chat' || /^\/api\/agent\/skills\/[^/]+\/run$/.test(p))) {
    sseHead(res);
    sse(res, 'error', { message: `本地版暂未实现该操作：${p}` });
    sse(res, 'done', {});
    return res.end();
  }
  // 写操作必须返回 code!=0，否则前端会把「没实现」当成保存成功
  return reply(res, biz.fail(`本地版暂未实现该操作：${p}`));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) sendJson(res, 500, { code: 500, message: `服务端异常：${e.message}` });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[zhuangdian-backend] http://${HOST}:${PORT}  db=backend/data/jinli.db  set=${DEFAULT_SET_ID}`);
  console.log(`[auth] 注册模式 REGISTER_MODE=${runtimeEnv('REGISTER_MODE', 'open')}（open=任何来源 / local=仅本机 / closed=关闭）`);
  // 启动即清理过期会话，此后每小时一次
  try { const n = biz.pruneSessions(); if (n) console.log(`[auth] 清理过期会话 ${n} 条`); } catch { /* 首启无表时忽略 */ }
  setInterval(() => { try { biz.pruneSessions(); } catch { /* 忽略 */ } }, 3600000).unref();
});
