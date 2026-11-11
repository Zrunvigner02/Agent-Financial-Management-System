import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, '.local');
const BASE = process.env.LOCAL_BASE || 'http://127.0.0.1:8000';
const token = JSON.parse(fs.readFileSync(path.join(LOCAL, 'local-session.json'), 'utf8')).token;
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'x-set-id': '85',
};

const report = { at: new Date().toISOString(), base: BASE, checks: [] };
function check(name, pass, detail = '') {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

// 1. 基础
const health = await api('GET', '/__local/health');
check('health', health.json.ok === true, `subjects=${health.json.subjects} llm=${health.json.llm_configured}`);
const sets = await api('GET', '/api/sets/enabled');
check('sets/enabled', sets.json.code === 0 && sets.json.data?.length > 0, `count=${sets.json.data?.length}`);
const subjects = await api('GET', '/api/subjects');
check('subjects', subjects.json.code === 0 && subjects.json.data?.length >= 100, `count=${subjects.json.data?.length}`);

// 2. 凭证闭环
const created = await api('POST', '/api/vouchers', {
  date: '2026-11-11',
  period: '2026-11',
  entries: [
    { summary: '收到客户货款', subject_code: '1002', debit: 10000, credit: 0 },
    { summary: '收到客户货款', subject_code: '6001', debit: 0, credit: 10000 },
  ],
});
const voucherId = created.json.data?.id;
check('create_voucher', created.json.code === 0 && Boolean(voucherId), `id=${voucherId} amount=${created.json.data?.amount}`);
if (voucherId) {
  const audited = await api('POST', `/api/vouchers/${voucherId}/audit`, {});
  check('audit_voucher', audited.json.code === 0, `status=${audited.json.data?.status}`);
  const posted = await api('POST', `/api/vouchers/${voucherId}/post`, {});
  check('post_voucher', posted.json.code === 0, `status=${posted.json.data?.status}`);
}
const list = await api('GET', '/api/vouchers?period=2026-11');
check('list_vouchers', list.json.code === 0 && list.json.data?.total >= 1, `total=${list.json.data?.total}`);

// 3. 账簿 / 看板 / 结账
const balance = await api('GET', '/api/ledger/balance?period=2026-11');
const bank = (balance.json.data?.roots || []).find((r) => r.code === '1002');
check('ledger_balance', balance.json.code === 0 && Boolean(bank), `1002 debit=${bank?.period_debit}`);
const detail = await api('GET', '/api/ledger/detail?period=2026-11&subject_code=1002');
check('ledger_detail', detail.json.code === 0, `rows=${detail.json.data?.rows?.length}`);
const overview = await api('GET', '/api/dashboard/overview?period=2026-11');
check('dashboard_overview', overview.json.code === 0 && Array.isArray(overview.json.data?.months),
  `revenue=${overview.json.data?.revenue} profit=${overview.json.data?.profit}`);
const closing = await api('GET', '/api/closing/list?period=2026-11');
check('closing_list', closing.json.code === 0, `posted=${closing.json.data?.rows?.[0]?.posted_count}`);

// 4. 本地开放令牌 + MCP
let openToken = '';
const tokenFile = path.join(LOCAL, 'local-open-token.json');
if (fs.existsSync(tokenFile)) openToken = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token || '';
if (!openToken) {
  const t = await api('POST', '/api/tokens', { name: 'workbuddy-local', scope: 'read,write', default_set_id: 85 });
  openToken = t.json.data?.token || '';
  if (openToken) fs.writeFileSync(tokenFile, JSON.stringify({ token: openToken, set_id: 85 }));
  check('create_open_token', Boolean(openToken), `length=${openToken.length}`);
}
const mcpHeaders = {
  'content-type': 'application/json',
  'accept': 'application/json, text/event-stream',
  authorization: `Bearer ${openToken}`,
};
async function mcp(method, params = {}, id = 1) {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST', headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  try { return { status: res.status, json: JSON.parse(line ? line.slice(5).trim() : text) }; }
  catch { return { status: res.status, json: { raw: text.slice(0, 200) } }; }
}
const init = await mcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'local-smoke', version: '1' } });
check('mcp_initialize', init.status === 200 && Boolean(init.json.result), `server=${init.json.result?.serverInfo?.name}`);
const tools = await mcp('tools/list', {}, 2);
const names = tools.json.result?.tools?.map((t) => t.name) || [];
// 工具数量会随功能迭代增长（v12 起新增意图追问 / 附件读取等），断言关键能力而非写死数字
const coreTools = ['list_subjects', 'get_report', 'create_voucher', 'clarify_intent', 'analyze_intent', 'read_attachment'];
check('mcp_tools_list', names.length >= 19 && coreTools.every((n) => names.includes(n)),
  `count=${names.length} missing=${coreTools.filter((n) => !names.includes(n)).join(',') || 'none'}`);
const called = await mcp('tools/call', { name: 'list_subjects', arguments: {} }, 3);
check('mcp_tools_call', called.json.result?.content?.[0]?.text?.includes('"code":0'), '');

// 5. 智能体配置 + SSE
const cfg = await api('GET', '/api/agent/llm-config');
check('agent_llm_config', cfg.json.code === 0, `configured=${cfg.json.data?.configured}`);
const skills = await api('GET', '/api/agent/skills');
check('agent_skills', skills.json.code === 0, `count=${skills.json.data?.list?.length}`);
const smokeSessionId = `smoke-${Date.now()}`;
try {
  const res = await fetch(BASE + '/api/agent/chat', {
    method: 'POST', headers,
    body: JSON.stringify({ session_id: smokeSessionId, message: '用一句话说明借贷记账法', skill_ids: [] }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  // 后端用的是标准 SSE：事件名在 `event:` 行、负载在 `data:` 行。
  // 旧版只解析 data 行并读 JSON 里的 event 字段，会永远得到空 kinds。
  const events = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) { cur = { event: line.slice(6).trim(), data: {} }; events.push(cur); }
    else if (line.startsWith('data:') && cur) {
      try { cur.data = JSON.parse(line.slice(5).trim()); } catch { cur.data = {}; }
    }
  }
  const kinds = [...new Set(events.map((e) => e.event))];
  check('agent_chat_sse', events.length > 0 && kinds.includes('done') && kinds.includes('content'),
    `events=${events.length} kinds=${kinds.join(',')}`);
  const content = events.filter((e) => e.event === 'content').map((e) => e.data?.text || '').join('');
  report.agent_answer_preview = content.slice(0, 120);
} catch (e) {
  check('agent_chat_sse', false, e.message);
}

// smoke 会真的写一张凭证并创建一个会话；跑完必须清掉，否则污染用户账套，
// 还会让后续「无演示数据」类断言误报。
if (voucherId) {
  await api('POST', `/api/vouchers/${voucherId}/unpost`, {});
  await api('POST', `/api/vouchers/${voucherId}/unaudit`, {});
  await api('DELETE', `/api/vouchers/${voucherId}`);
}
await api('DELETE', `/api/agent/sessions/${smokeSessionId}`);
report.cleanup = { voucher_id: voucherId, session_id: smokeSessionId };

const passed = report.checks.filter((c) => c.pass).length;
report.summary = `${passed}/${report.checks.length} passed`;
fs.writeFileSync(path.join(ROOT, 'analysis', 'local-smoke.json'), JSON.stringify(report, null, 2));
console.log(`\n=== ${report.summary} ===`);
