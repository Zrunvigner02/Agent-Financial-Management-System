import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:5173';
const LOCAL = path.join(ROOT, '.local');
const token = JSON.parse(fs.readFileSync(path.join(LOCAL, 'session.json'), 'utf8')).token;

let setId = '';
const report = { base: BASE, recon_at: new Date().toISOString(), endpoints: [], mcp: {} };

function shape(v, depth = 0) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return { kind: 'array', length: v.length, sample: v.length ? shape(v[0], depth + 1) : null };
  if (typeof v === 'object') {
    if (depth >= 2) return { kind: 'object', keys: Object.keys(v).slice(0, 40) };
    return { kind: 'object', fields: Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shape(x, depth + 1)])) };
  }
  return typeof v;
}

async function call(method, url, body) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (setId) headers['x-set-id'] = String(setId);
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, headers: res.headers, body: parsed };
}

// 1) 账套
const setsRes = await call('GET', '/api/sets/enabled');
const sets = Array.isArray(setsRes.body.data) ? setsRes.body.data : [];
setId = sets[0]?.id ?? '';
console.log(`[sets] status=${setsRes.status} count=${sets.length} set_id=${setId || '(none)'}`);
report.sets = sets.map((s) => ({ id: s.id, name: s.name, keys: Object.keys(s) }));

// 2) 带账套头探测业务接口
const GETS = [
  '/api/accounts', '/api/subjects', '/api/vouchers', '/api/ledger/balance',
  '/api/ledger/detail', '/api/dashboard/overview', '/api/dashboard/biz-settings',
  '/api/roles', '/api/tokens', '/api/auxiliaries', '/api/invoices',
  '/api/closing/list', '/api/agent/llm-config', '/api/agent/skills',
  '/api/agent/sessions', '/api/agent/my-rules', '/api/organization/tree',
  '/api/reports/balance-sheet', '/api/setting/business',
];
for (const ep of GETS) {
  try {
    const r = await call('GET', ep);
    const b = r.body;
    report.endpoints.push({
      path: ep,
      status: r.status,
      code: b.code,
      message: b.message,
      data_shape: shape(b.data ?? b),
    });
    console.log(`${r.status} ${ep} code=${b.code ?? '-'} msg=${b.message ?? '-'} shape=${Array.isArray(b.data) ? `array(${b.data.length})` : typeof b.data}`);
  } catch (e) {
    report.endpoints.push({ path: ep, error: e.message });
    console.log(`ERR ${ep} ${e.message}`);
  }
}

// 3) 创建 WorkBuddy 用 OpenToken（只创建一次，复用已有）
let openToken = '';
const tokenFile = path.join(LOCAL, 'open-token.json');
if (fs.existsSync(tokenFile)) {
  openToken = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token || '';
}
if (!openToken) {
  const created = await call('POST', '/api/tokens', {
    name: 'workbuddy-local',
    scope: 'read,write',
    default_set_id: setId || null,
  });
  openToken = created.body?.data?.token || '';
  if (openToken) {
    fs.writeFileSync(tokenFile, JSON.stringify({ token: openToken, set_id: setId, created_at: new Date().toISOString() }));
    console.log(`[open-token] created, length=${openToken.length}`);
  } else {
    console.log(`[open-token] create failed: ${created.status} ${created.body?.message ?? ''}`);
  }
} else {
  console.log(`[open-token] reused, length=${openToken.length}`);
}

// 4) MCP JSON-RPC 握手 + 工具清单
let rpcId = 0;
async function mcp(method, params, sessionId, notify = false) {
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'authorization': `Bearer ${openToken}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const payload = { jsonrpc: '2.0', method, params };
  if (!notify) payload.id = ++rpcId;
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {
    const m = text.match(/data:\s*(\{[\s\S]*\})/);
    if (m) { try { body = JSON.parse(m[1]); } catch { body = { raw: text.slice(0, 300) }; } }
    else body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), body };
}

if (openToken) {
  const init = await mcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'jinli-local-recon', version: '0.1.0' },
  });
  const sid = init.sessionId || '';
  report.mcp.initialize = { status: init.status, session: Boolean(sid), result: init.body?.result ?? init.body };
  console.log(`[mcp initialize] ${init.status} session=${Boolean(sid)} server=${init.body?.result?.serverInfo?.name ?? '-'}`);
  await mcp('notifications/initialized', {}, sid, true);
  const tools = await mcp('tools/list', {}, sid);
  const names = (tools.body?.result?.tools || []).map((t) => t.name);
  report.mcp.tools = { status: tools.status, count: names.length, names };
  console.log(`[mcp tools/list] ${tools.status} count=${names.length}`);
  console.log(names.join(', '));
}

fs.writeFileSync(path.join(ROOT, 'analysis/recon.json'), JSON.stringify(report, null, 2));
console.log('report: analysis/recon.json');
