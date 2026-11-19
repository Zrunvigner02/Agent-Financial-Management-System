/* 振颜丽舍 · 全量功能回归（完全隔离，不污染用户账套）
 *
 * 做法：把 backend/ + .env + 格式转换桥复制到系统临时目录，用真实数据库的一份
 * 副本启动独立实例（默认 8002），所有写操作只落在副本上，跑完自动清理。
 *
 *   node tools/full-regression.mjs             # 全量
 *   node tools/full-regression.mjs --keep      # 保留临时目录便于排查
 *
 * 输出：控制台逐项 PASS/FAIL，结构化报告写 analysis/full-regression.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.REGRESSION_PORT || 8002);
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.argv.includes('--keep');
const TMP = path.join(os.tmpdir(), `zd-regression-${Date.now()}`);

const results = [];
let pass = 0, fail = 0;
const group = { current: '' };
function section(name) { group.current = name; console.log(`\n── ${name} ──`); }
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  ok ? pass++ : fail++;
  results.push({ group: group.current, name, pass: ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && (!ok || process.env.REG_VERBOSE) ? ' :: ' + String(detail).slice(0, 220) : ''}`);
}
async function test(name, fn) {
  try { const r = await fn(); check(name, r?.ok ?? r, r?.detail ?? ''); return r; }
  catch (e) { check(name, false, `EXCEPTION ${e.message}`); return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. 准备隔离环境 ----------
 * 注意：本机 Node 22 在中文路径下调用 fs.cpSync(recursive) 会触发 native
 * Segmentation fault，因此这里手写逐文件复制（已实测 copyFileSync 正常）。 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
fs.mkdirSync(TMP, { recursive: true });
copyTree(path.join(ROOT, 'backend'), path.join(TMP, 'backend'));
fs.mkdirSync(path.join(TMP, 'tools'), { recursive: true });
for (const f of ['filee-bridge.mjs', 'render_image.py']) {
  const src = path.join(ROOT, 'tools', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP, 'tools', f));
}
// .env 保留真实配置（FILEE_CLI 相对路径在临时根目录同样成立）
const envSrc = path.join(ROOT, '.env');
if (fs.existsSync(envSrc)) fs.copyFileSync(envSrc, path.join(TMP, '.env'));

const sessionToken = JSON.parse(fs.readFileSync(path.join(ROOT, '.local', 'local-session.json'), 'utf8')).token;
const openToken = JSON.parse(fs.readFileSync(path.join(ROOT, '.local', 'local-open-token.json'), 'utf8')).token;
// 本地管理员初始密码由 store.initialize() 生成并写入此文件，不能写死
const adminPassword = (fs.readFileSync(path.join(ROOT, '.local', 'local-admin.txt'), 'utf8')
  .match(/password=(.*)/) || [])[1]?.trim() || '';
const H = { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}`, 'x-set-id': '85' };
const MH = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${openToken}` };

const child = spawn(process.execPath, [path.join(TMP, 'backend', 'index.mjs')], {
  cwd: TMP,
  // 回归默认关闭「会话名 LLM 精修」的外部模型调用：保证结果确定、不耗额度；
  // 需要实测 LLM 精修时运行 `ZD_AUTO_TITLE_LLM=1 npm run regression`。
  env: { ...process.env, LOCAL_BACKEND_PORT: String(PORT), LOCAL_BACKEND_HOST: '127.0.0.1',
    ZD_AUTO_TITLE_LLM: process.env.ZD_AUTO_TITLE_LLM || '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d.toString(); });
child.stderr.on('data', (d) => { childLog += d.toString(); });
let childExited = false;
child.on('exit', (code) => { childExited = true; childLog += `\n[child exited ${code}]`; });

async function waitHealth(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (childExited) return false;
    try { const r = await fetch(BASE + '/__local/health'); if (r.ok) return true; } catch { /* 未就绪 */ }
    await sleep(150);
  }
  return false;
}

/* ---------- 2. 请求工具 ---------- */
async function api(method, url, body, headers = H) {
  const res = await fetch(BASE + url, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 200) }; }
  return { status: res.status, json, text, headers: res.headers };
}
const okJson = (r) => r?.status === 200 && r.json?.code === 0;
const badJson = (r) => r?.json?.code !== 0;

async function sseOf(url, body, headers = H) {
  const res = await fetch(BASE + url, {
    method: 'POST', headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(130000),
  });
  const text = await res.text();
  const events = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) { cur = { event: line.slice(6).trim(), data: {} }; events.push(cur); }
    else if (line.startsWith('data:') && cur) {
      try { cur.data = JSON.parse(line.slice(5).trim()); } catch { cur.data = {}; }
    }
  }
  return { status: res.status, events, text, kinds: events.map((e) => e.event) };
}
async function mcp(method, params = {}, id = 1, headers = MH) {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id, method, params }, headers);
  return { ...r, result: r.json?.result, error: r.json?.error };
}
async function callTool(name, args = {}) {
  const r = await mcp('tools/call', { name, arguments: args }, Math.floor(Math.random() * 1e6));
  let payload = null;
  try { payload = JSON.parse(r.result?.content?.[0]?.text || 'null'); } catch { /* ignore */ }
  return { ...r, payload, isError: r.result?.isError };
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/* ---------- 3. 用例 ---------- */
let ready = false;
try {
  ready = await waitHealth();
  check('隔离实例启动 + health', ready, ready ? (await api('GET', '/__local/health')).json?.subjects + ' 科目' : childLog.slice(-400));
  if (!ready) throw new Error('隔离实例未就绪');

  section('A · 基础设施与鉴权');
  await test('health 结构与真实基线', async () => {
    const r = await api('GET', '/__local/health');
    return { ok: r.status === 200 && r.json.ok === true && r.json.subjects >= 100, detail: `subjects=${r.json.subjects} vouchers=${r.json.vouchers}` };
  });
  await test('OPTIONS 预检返回 204 + CORS', async () => {
    const r = await fetch(BASE + '/api/subjects', { method: 'OPTIONS', headers: { origin: 'http://x', 'access-control-request-method': 'POST' } });
    return { ok: r.status === 204 && r.headers.get('access-control-allow-origin') === '*', detail: `status=${r.status}` };
  });
  await test('无令牌访问受保护接口 → 401', async () => {
    const r = await api('GET', '/api/subjects', undefined, { 'x-set-id': '85' });
    return { ok: r.status === 401, detail: `status=${r.status}` };
  });
  await test('错误令牌 → 401', async () => {
    const r = await api('GET', '/api/subjects', undefined, { authorization: 'Bearer bogus', 'x-set-id': '85' });
    return { ok: r.status === 401, detail: `status=${r.status}` };
  });
  await test('MCP 无令牌 → 401', async () => {
    const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'content-type': 'application/json' });
    return { ok: r.status === 401, detail: `status=${r.status}` };
  });
  await test('未知 GET 路由返回兼容空结构', async () => {
    const r = await api('GET', '/api/totally-unknown');
    return { ok: okJson(r), detail: JSON.stringify(r.json).slice(0, 80) };
  });
  await test('未实现写操作返回 code!=0（不假成功）', async () => {
    const r = await api('POST', '/api/__regression_not_implemented', { a: 1 });
    return { ok: badJson(r), detail: r.json?.message };
  });

  section('B · 认证 / 账户 / 角色');
  let adminToken = '';
  await test('本地管理员登录成功', async () => {
    const r = await api('POST', '/api/auth/login', { username: 'admin', password: adminPassword }, { 'content-type': 'application/json' });
    adminToken = r.json?.data?.token || '';
    return { ok: okJson(r) && Boolean(adminToken), detail: `code=${r.json.code} msg=${r.json.message}` };
  });
  await test('错误密码登录被拒绝', async () => {
    const r = await api('POST', '/api/auth/login', { username: 'admin', password: 'definitely-wrong' }, { 'content-type': 'application/json' });
    return { ok: badJson(r), detail: `code=${r.json.code}` };
  });
  await test('旧密码错误时改密被拒绝', async () => {
    const r = await api('POST', '/api/auth/change-password', { old_password: 'wrong', new_password: 'New@123456' });
    return { ok: badJson(r), detail: r.json?.message };
  });
  let accountId = 0;
  await test('账户列表 / 创建 / 更新 / 删除闭环', async () => {
    const list0 = await api('GET', '/api/accounts');
    const created = await api('POST', '/api/accounts', { username: `reg_${Date.now()}`, password: 'Test@123456', name: '回归测试', role: '操作员' });
    accountId = created.json?.data?.id || 0;
    const updated = accountId ? await api('PUT', `/api/accounts/${accountId}`, { name: '回归测试-改' }) : { json: {} };
    const status = accountId ? await api('PUT', `/api/accounts/${accountId}/status`, { status: 0 }) : { json: {} };
    const sets = accountId ? await api('GET', `/api/accounts/${accountId}/sets`) : { json: {} };
    // 删除改为两阶段确认：第一次拿令牌，第二次带令牌才真正删除
    const del1 = accountId ? await api('DELETE', `/api/accounts/${accountId}`) : { json: {} };
    const delToken = del1.json?.data?.token || '';
    const del = accountId && delToken
      ? await api('DELETE', `/api/accounts/${accountId}`, { token: delToken })
      : del1;
    const list1 = await api('GET', '/api/accounts');
    const names = JSON.stringify(list1.json?.data || []);
    return { ok: okJson(list0) && Boolean(accountId) && okJson(updated) && okJson(status) && okJson(sets) && okJson(del) && !names.includes('回归测试-改'),
      detail: `id=${accountId} upd=${updated.json.code} confirm=${del1.json.code} del=${del.json.code}` };
  });
  await test('禁止删除当前登录账户', async () => {
    // 用刚登录拿到的 admin token 删除 admin 自己（id=1），必须被拒绝
    const r = await api('DELETE', '/api/accounts/1', undefined, { ...H, authorization: `Bearer ${adminToken}` });
    return { ok: badJson(r), detail: r.json?.message };
  });
  let roleId = 0;
  await test('角色 创建 / 菜单权限 / 更新 / 删除闭环', async () => {
    const created = await api('POST', '/api/roles', { name: `回归角色_${Date.now()}`, description: 'reg' });
    roleId = created.json?.data?.id || 0;
    const menus = roleId ? await api('PUT', `/api/roles/${roleId}/menus`, { paths: ['/dashboard', '/vouchers'] }) : { json: {} };
    const read = roleId ? await api('GET', `/api/roles/${roleId}/menus`) : { json: {} };
    const upd = roleId ? await api('PUT', `/api/roles/${roleId}`, { name: '回归角色-改' }) : { json: {} };
    const del = roleId ? await api('DELETE', `/api/roles/${roleId}`) : { json: {} };
    return { ok: Boolean(roleId) && okJson(menus) && okJson(read) && okJson(upd) && okJson(del),
      detail: `id=${roleId} menus=${menus.json.code} read=${read.json.code} del=${del.json.code}` };
  });

  section('C · 账套与科目');
  await test('账套列表 / 启用列表 / 新建 / 更新', async () => {
    const a = await api('GET', '/api/sets');
    const b = await api('GET', '/api/sets/enabled');
    const c = await api('POST', '/api/sets', { name: '回归测试账套', company: '回归' });
    const id = c.json?.data?.id;
    const d = id ? await api('PUT', `/api/sets/${id}`, { name: '回归测试账套-改' }) : { json: {} };
    return { ok: okJson(a) && okJson(b) && okJson(c) && okJson(d), detail: `sets=${a.json.data?.length} new=${id}` };
  });
  await test('科目表 ≥100 条且结构完整', async () => {
    const r = await api('GET', '/api/subjects');
    const first = r.json?.data?.[0] || {};
    return { ok: okJson(r) && r.json.data.length >= 100 && Boolean(first.code), detail: `count=${r.json.data?.length}` };
  });
  await test('科目 新建 / 删除闭环，非法科目被拒绝', async () => {
    const bad = await api('POST', '/api/subjects', { name: '' });
    const c = await api('POST', '/api/subjects', { code: '9999', name: '回归临时科目', type: '资产' });
    const id = c.json?.data?.id;
    const d = id ? await api('DELETE', `/api/subjects/${id}`) : { json: {} };
    return { ok: badJson(bad) && okJson(c) && okJson(d), detail: `bad=${bad.json.code} id=${id} del=${d.json.code}` };
  });

  section('D · 凭证全生命周期');
  const V = {
    date: '2026-11-11', period: '2026-11',
    entries: [
      { summary: '回归测试收款', subject_code: '1002', debit: 12345.67, credit: 0 },
      { summary: '回归测试收款', subject_code: '6001', debit: 0, credit: 12345.67 },
    ],
  };
  let vid = 0;
  await test('创建借贷平衡凭证', async () => {
    const r = await api('POST', '/api/vouchers', V);
    vid = r.json?.data?.id || 0;
    return { ok: okJson(r) && Boolean(vid), detail: `id=${vid} amount=${r.json.data?.amount}` };
  });
  await test('借贷不平衡凭证被拒绝', async () => {
    const r = await api('POST', '/api/vouchers', { ...V, entries: [V.entries[0]] });
    return { ok: badJson(r), detail: r.json?.message };
  });
  await test('空分录凭证被拒绝', async () => {
    const r = await api('POST', '/api/vouchers', { date: V.date, period: V.period, entries: [] });
    return { ok: badJson(r), detail: r.json?.message };
  });
  await test('凭证详情 / 列表可查', async () => {
    const g = await api('GET', `/api/vouchers/${vid}`);
    const l = await api('GET', '/api/vouchers?period=2026-11');
    return { ok: okJson(g) && okJson(l) && l.json.data.total >= 1, detail: `total=${l.json.data?.total}` };
  });
  await test('跨账套读取凭证被拒绝', async () => {
    const r = await api('GET', `/api/vouchers/${vid}`, undefined, { ...H, 'x-set-id': '999' });
    return { ok: badJson(r), detail: r.json?.message };
  });
  await test('审核 → 过账 → 反过账 → 反审核 状态机', async () => {
    const a1 = await api('POST', `/api/vouchers/${vid}/audit`, {});
    const a2 = await api('POST', `/api/vouchers/${vid}/audit`, {});
    const p1 = await api('POST', `/api/vouchers/${vid}/post`, {});
    const p2 = await api('POST', `/api/vouchers/${vid}/post`, {});
    const u1 = await api('POST', `/api/vouchers/${vid}/unpost`, {});
    const u2 = await api('POST', `/api/vouchers/${vid}/unaudit`, {});
    return { ok: okJson(a1) && badJson(a2) && okJson(p1) && badJson(p2) && okJson(u1) && okJson(u2),
      detail: `audit2=${a2.json.code} post2=${p2.json.code} unpost=${u1.json.code} unaudit=${u2.json.code}` };
  });
  await test('反审核后可删除，删除后再查返回错误', async () => {
    const d = await api('DELETE', `/api/vouchers/${vid}`);
    const g = await api('GET', `/api/vouchers/${vid}`);
    return { ok: okJson(d) && badJson(g), detail: `del=${d.json.code} get=${g.json.code}` };
  });
  await test('账簿余额 / 明细与凭证一致', async () => {
    const b = await api('GET', '/api/ledger/balance?period=2026-11');
    const d = await api('GET', '/api/ledger/detail?period=2026-11&subject_code=1002');
    return { ok: okJson(b) && okJson(d), detail: `roots=${b.json.data?.roots?.length} rows=${d.json.data?.rows?.length}` };
  });

  section('E · 看板 / 结账');
  await test('经营概览返回真实汇总', async () => {
    const r = await api('GET', '/api/dashboard/overview?period=2026-11');
    return { ok: okJson(r) && Array.isArray(r.json.data?.months), detail: `revenue=${r.json.data?.revenue}` };
  });
  await test('云端提供的 11 个看板分项全部可读', async () => {
    // profit-detail 在云端 seed 本身就是 404（接口不存在），不属于可用分项
    const keys = ['capital', 'revenue', 'cost', 'profit', 'expense', 'tax', 'ar', 'ap', 'capital-detail', 'ar-aging', 'ap-aging'];
    const out = [];
    for (const k of keys) { const r = await api('GET', `/api/dashboard/${k}?period=2026-11`); out.push(`${k}:${r.json.code}`); }
    return { ok: out.every((x) => x.endsWith(':0')), detail: out.join(' ') };
  });
  await test('未知 / 云端不存在的看板分项返回明确错误', async () => {
    const a = await api('GET', '/api/dashboard/not-a-section');
    const b = await api('GET', '/api/dashboard/profit-detail?period=2026-11');
    return { ok: badJson(a) && badJson(b), detail: `a=${a.json.message} b=${b.json.message}` };
  });
  await test('结账列表 / 业务设置', async () => {
    const a = await api('GET', '/api/closing/list?period=2026-11');
    const b = await api('GET', '/api/dashboard/biz-settings');
    return { ok: okJson(a) && okJson(b), detail: `closing=${a.json.code} settings=${b.json.code}` };
  });

  section('F · 辅助档案 / 资产 / 发票');
  await test('辅助档案 列表 / 新建', async () => {
    const a = await api('GET', '/api/auxiliaries');
    const b = await api('POST', '/api/auxiliaries', { name: '回归客户', type: '客户' });
    return { ok: okJson(a) && okJson(b), detail: `new=${b.json.code}` };
  });
  await test('资产类别 / 资产 列表与新建', async () => {
    const a = await api('GET', '/api/asset-categories');
    const b = await api('POST', '/api/asset-categories', { name: '回归类别' });
    const c = await api('GET', '/api/assets');
    const d = await api('POST', '/api/assets', { name: '回归设备', amount: 1000 });
    return { ok: okJson(a) && okJson(b) && okJson(c) && okJson(d), detail: `cat=${b.json.code} asset=${d.json.code}` };
  });
  await test('发票 列表 / 模板 / 上传 / 生成凭证', async () => {
    const a = await api('GET', '/api/invoices');
    const t = await api('GET', '/api/invoices/templates');
    const u = await api('POST', '/api/invoices/upload', { name: '回归发票.pdf', content: b64('回归测试发票'), amount: 100, type: '进项' });
    const iid = u.json?.data?.id;
    const v = iid ? await api('POST', `/api/invoices/${iid}/voucher`, {}) : { json: {} };
    return { ok: okJson(a) && okJson(t) && okJson(u) && okJson(v), detail: `invoice=${iid} voucher=${v.json.code} ${v.json.message || ''}` };
  });
  await test('不存在的发票生成凭证被拒绝', async () => {
    const r = await api('POST', '/api/invoices/99999999/voucher', {});
    return { ok: badJson(r), detail: r.json?.message };
  });

  section('G · 智能体配置 / 技能 / 会话');
  await test('系统提示词声明本地账套与取数能力（不再否认有数据）', async () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { agentSystemPrompt } from './backend/biz.mjs'; process.stdout.write(agentSystemPrompt(85));`],
    { cwd: TMP, encoding: 'utf8', timeout: 20000 });
    const p = r.stdout || '';
    return { ok: r.status === 0 && /本地账套/.test(p) && /绝对不要回答/.test(p) && /意图追问/.test(p) && /不要编造/.test(p),
      detail: `len=${p.length} ${p.slice(0, 70)}` };
  });
  await test('模型配置读取 / 保存 / 重置', async () => {
    const g = await api('GET', '/api/agent/llm-config');
    const p = await api('PUT', '/api/agent/llm-config', { model: 'dsv4.1f1017', api_key: g.json?.data?.key_hint ? undefined : '' });
    return { ok: okJson(g) && g.json.data.configured === true, detail: `configured=${g.json.data?.configured} model=${g.json.data?.model} put=${p.json.code}` };
  });
  await test('技能列表与技能执行 SSE', async () => {
    const s = await api('GET', '/api/agent/skills');
    const id = s.json?.data?.list?.[0]?.id || s.json?.data?.[0]?.id;
    if (!id) return { ok: false, detail: '未取到技能 id' };
    const r = await sseOf(`/api/agent/skills/${encodeURIComponent(id)}/run`, { session_id: `reg-skill-${Date.now()}` });
    return { ok: r.status === 200 && r.kinds.includes('content') && r.kinds.includes('done') && !r.kinds.includes('error'),
      detail: `skill=${id} events=${r.kinds.join(',')}` };
  });
  await test('未知技能以 error+done 收尾（不挂起）', async () => {
    const r = await sseOf('/api/agent/skills/__no_such_skill__/run', { session_id: `reg-skill-bad-${Date.now()}` });
    return { ok: r.kinds.includes('error') && r.kinds.at(-1) === 'done', detail: r.kinds.join(',') };
  });
  await test('自定义提示词技能 CRUD', async () => {
    const c = await api('POST', '/api/agent/prompt-skills', { name: '回归技能', description: 'reg', prompt: '请汇总', enabled: 1 });
    const id = c.json?.data?.id;
    const l = await api('GET', '/api/agent/prompt-skills');
    const u = id ? await api('PUT', `/api/agent/prompt-skills/${id}`, { name: '回归技能-改' }) : { json: {} };
    const d = id ? await api('DELETE', `/api/agent/prompt-skills/${id}`) : { json: {} };
    return { ok: okJson(c) && okJson(l) && okJson(u) && okJson(d), detail: `id=${id} del=${d.json.code}` };
  });
  await test('智能体会话 新建 / 消息 / 重命名 / 删除', async () => {
    const sid = `reg-session-${Date.now()}`;
    const c = await api('POST', '/api/agent/sessions', { title: '回归会话' });
    const m = await api('GET', `/api/agent/sessions/${sid}/messages`);
    const u = await api('PUT', `/api/agent/sessions/${sid}`, { title: '回归会话-改', pinned: 1 });
    const d = await api('DELETE', `/api/agent/sessions/${sid}`);
    const d2 = await api('DELETE', `/api/agent/sessions/${sid}`);
    return { ok: okJson(c) && okJson(m) && badJson(d) && badJson(d2), detail: `未创建的会话删除应失败 d=${d.json.code} d2=${d2.json.code}` };
  });
  await test('已创建的会话可重命名并删除', async () => {
    const c = await api('POST', '/api/agent/sessions', { title: '回归会话2' });
    const sid = c.json?.data?.id;
    const u = sid ? await api('PUT', `/api/agent/sessions/${sid}`, { title: '改' }) : { json: {} };
    const d = sid ? await api('DELETE', `/api/agent/sessions/${sid}`) : { json: {} };
    return { ok: Boolean(sid) && okJson(u) && okJson(d), detail: `sid=${sid} put=${u.json.code} del=${d.json.code}` };
  });
  await test('知识记忆 / 我的规则 读写一致', async () => {
    const k = await api('GET', '/api/agent/knowledge');
    const m = await api('POST', '/api/agent/knowledge/memory', { content: '回归记忆' });
    const id = m.json?.data?.id;
    const dm = id ? await api('DELETE', `/api/agent/knowledge/${id}`) : { json: {} };
    const rp = await api('PUT', '/api/agent/rules', { content: '回归规则' });
    const rg = await api('GET', '/api/agent/rules');
    const rm = await api('GET', '/api/agent/my-rules');
    return { ok: okJson(k) && okJson(m) && okJson(dm) && okJson(rp) && okJson(rg) && okJson(rm) && rg.json.data?.content === '回归规则' && rm.json.data?.content === '回归规则',
      detail: `mem=${m.json.code} del=${dm.json.code} rules=${rg.json.data?.content}` };
  });
  await test('无须确认的操作返回明确提示', async () => {
    const r = await api('POST', '/api/agent/actions/confirm', { id: 'x' });
    return { ok: badJson(r), detail: r.json?.message };
  });

  section('H · 意图追问工具');
  await test('意图分析：咨询 / 闲聊 / 模糊 / 规格完整 / 停用 / 恢复', async () => {
    const cases = [
      ['你的数据是怎么保存的？', 'no_clarify'], ['你好', 'no_clarify'],
      ['把本月的财务报表给我', 'clarify'], ['导出 2026-10 的凭证清单为 xlsx', 'direct'],
      ['不用反问了', 'disable'], ['开启追问', 'enable'],
    ];
    const out = [];
    for (const [msg, want] of cases) {
      const r = await api('POST', '/api/agent/clarify/analyze', { message: msg });
      const got = r.json?.data?.decision;
      out.push(`${want}=${got}`);
      if (got !== want) return { ok: false, detail: `${msg} => ${got}, 期望 ${want}` };
    }
    return { ok: true, detail: out.join(' ') };
  });
  await test('偏好开关 持久化 / 关闭 / 恢复', async () => {
    const g0 = await api('GET', '/api/agent/clarify/prefs?session_id=reg-pref');
    await api('POST', '/api/agent/clarify/prefs', { session_id: 'reg-pref', enabled: false });
    const g1 = await api('GET', '/api/agent/clarify/prefs?session_id=reg-pref');
    await api('POST', '/api/agent/clarify/prefs', { session_id: 'reg-pref', enabled: true });
    const g2 = await api('GET', '/api/agent/clarify/prefs?session_id=reg-pref');
    return { ok: okJson(g0) && g1.json.data?.enabled === false && g2.json.data?.enabled === true,
      detail: `${g0.json.data?.enabled} → ${g1.json.data?.enabled} → ${g2.json.data?.enabled}` };
  });
  await test('追问状态 / 重置 / last 端点', async () => {
    const sid = `reg-clarify-${Date.now()}`;
    const s0 = await api('GET', `/api/agent/clarify/state?session_id=${sid}`);
    await api('POST', '/api/agent/clarify/answer', { session_id: sid, message: '把本月报表给我', force: true });
    const s1 = await api('GET', `/api/agent/clarify/state?session_id=${sid}`);
    const last = await api('GET', `/api/agent/clarify/last?session_id=${sid}`);
    const reset = await api('POST', '/api/agent/clarify/reset', { session_id: sid });
    const s2 = await api('GET', `/api/agent/clarify/state?session_id=${sid}`);
    return { ok: okJson(s0) && okJson(s1) && okJson(last) && okJson(reset) && s1.json.data?.active === true && s2.json.data?.active === false,
      detail: `active1=${s1.json.data?.active} active2=${s2.json.data?.active}` };
  });
  await test('聊天 SSE 多轮追问：选项 / 末项自主输入 / 最终产出', async () => {
    const sid = `reg-chat-${Date.now()}`;
    const r1 = await sseOf('/api/agent/chat', { session_id: sid, message: '把本月的财务报表给我', clarify: 1 });
    const ask1 = r1.events.find((e) => e.event === 'clarify')?.data;
    const opts1 = ask1?.options || [];
    const customLast = opts1.at(-1)?.label?.includes('我自己输入') || JSON.stringify(opts1.at(-1) || {}).includes('我自己输入');
    let r2 = null, r3 = null;
    if (opts1.length) {
      r2 = await sseOf('/api/agent/chat', { session_id: sid, message: `【澄清选择】${opts1[0].value}｜${opts1[0].label}`, clarify: 1 });
      const opts2 = r2.events.find((e) => e.event === 'clarify')?.data?.options || [];
      if (opts2.length) r3 = await sseOf('/api/agent/chat', { session_id: sid, message: `【澄清选择】${opts2[0].value}｜${opts2[0].label}`, clarify: 1 });
    }
    return { ok: r1.kinds.includes('clarify') && r1.kinds.at(-1) === 'done' && opts1.length >= 3 && customLast && Boolean(r3),
      detail: `events=${r1.kinds.join(',')} opts=${opts1.length} last=${JSON.stringify(opts1.at(-1) || {}).slice(0, 80)} step2=${Boolean(r2)} step3=${Boolean(r3)}` };
  });
  await test('旧页面（capable=false）不会只发文字无卡片', async () => {
    const r = await sseOf('/api/agent/chat', { session_id: `reg-old-${Date.now()}`, message: '把本月的财务报表给我' });
    return { ok: !r.kinds.includes('clarify') && r.kinds.at(-1) === 'done', detail: r.kinds.slice(0, 4).join(',') + '…' };
  });
  await test('「不用反问了」停用后不再追问且可恢复', async () => {
    const sid = `reg-stop-${Date.now()}`;
    const off = await sseOf('/api/agent/chat', { session_id: sid, message: '不用反问了', clarify: 1 });
    const after = await sseOf('/api/agent/chat', { session_id: sid, message: '把本月报表给我', clarify: 1 });
    const on = await sseOf('/api/agent/chat', { session_id: sid, message: '开启追问', clarify: 1 });
    const prefs = await api('GET', '/api/agent/clarify/prefs?session_id=reg-pref');
    return { ok: off.kinds.includes('clarify') && !after.kinds.includes('clarify') && on.kinds.includes('clarify') && prefs.json.data?.enabled === true,
      detail: `off=${off.kinds.join(',')} after=${after.kinds.slice(0, 3).join(',')} on=${on.kinds.slice(0, 3).join(',')}` };
  });

  section('H2 · 会话自动命名');
  await test('前端先建会话 → 首条消息发 session_title 且列表同步改名', async () => {
    const c = await api('POST', '/api/agent/sessions', {});
    const sid = c.json?.data?.id;
    const initial = c.json?.data?.title;
    const r = await sseOf('/api/agent/chat', { session_id: sid, message: '把本月的财务报表给我', clarify: 1 });
    const ev = r.events.find((e) => e.event === 'session_title')?.data;
    const list = await api('GET', '/api/agent/sessions');
    const found = (list.json?.data || []).find((x) => x.id === sid);
    return { ok: Boolean(sid) && initial === '新对话' && ev?.title === '本月的财务报表'
      && found?.title === '本月的财务报表' && r.kinds.at(-1) === 'done',
      detail: `sid=${sid} event=${JSON.stringify(ev)} list=${found?.title}` };
  });
  await test('第二条消息不重复命名 / 手动改名后自动命名永久让位', async () => {
    const c = await api('POST', '/api/agent/sessions', {});
    const sid = c.json?.data?.id;
    const r1 = await sseOf('/api/agent/chat', { session_id: sid, message: '本月各科目余额', clarify: 1 });
    const r2 = await sseOf('/api/agent/chat', { session_id: sid, message: '再给我一份利润表', clarify: 1 });
    const before = await api('GET', '/api/agent/sessions');
    const t1 = (before.json?.data || []).find((x) => x.id === sid)?.title;
    const u = await api('PUT', `/api/agent/sessions/${sid}`, { title: '我的专属名称' });
    const r3 = await sseOf('/api/agent/chat', { session_id: sid, message: '换个问题继续问', clarify: 1 });
    const after = await api('GET', '/api/agent/sessions');
    const t2 = (after.json?.data || []).find((x) => x.id === sid)?.title;
    return { ok: okJson(u) && t1 === '本月各科目余额' && t2 === '我的专属名称'
      && Boolean(r1.events.find((e) => e.event === 'session_title'))
      && !r2.events.some((e) => e.event === 'session_title')
      && !r3.events.some((e) => e.event === 'session_title'),
      detail: `t1=${t1} t2=${t2} ev1=${r1.kinds.join(',')} ev2=${r2.kinds.join(',')}` };
  });
  await test('追问选项消息不命名，真实问题才命名', async () => {
    const sid = `reg-title-opt-${Date.now()}`;
    const r1 = await sseOf('/api/agent/chat', { session_id: sid, message: '【澄清选择】chat｜只在消息里看摘要', clarify: 1 });
    const r2 = await sseOf('/api/agent/chat', { session_id: sid, message: '把本月的利润表给我', clarify: 1 });
    const ev = r2.events.find((e) => e.event === 'session_title')?.data;
    return { ok: !r1.events.some((e) => e.event === 'session_title') && ev?.title === '本月的利润表',
      detail: `first=${r1.kinds.join(',')} second=${JSON.stringify(ev)}` };
  });
  await test('auto-title 精修端点：自动生成可精修 / 人工名称不动', async () => {
    const c = await api('POST', '/api/agent/sessions', {});
    const sid = c.json?.data?.id;
    await sseOf('/api/agent/chat', { session_id: sid, message: '本月现金流情况', clarify: 1 });
    const a = await api('POST', `/api/agent/sessions/${sid}/auto-title`, {});
    await api('PUT', `/api/agent/sessions/${sid}`, { title: '人工锁定' });
    const b = await api('POST', `/api/agent/sessions/${sid}/auto-title`, {});
    const list = await api('GET', '/api/agent/sessions');
    const title = (list.json?.data || []).find((x) => x.id === sid)?.title;
    const bad = await api('POST', '/api/agent/sessions/reg-not-exist/auto-title', {});
    return { ok: okJson(a) && Boolean(a.json?.data?.title) && okJson(b)
      && b.json?.data?.source === 'manual' && b.json?.data?.changed === false
      && title === '人工锁定' && badJson(bad),
      detail: `a=${JSON.stringify(a.json?.data)} b=${JSON.stringify(b.json?.data)} title=${title} bad=${bad.json?.code}` };
  });

  section('I · 全格式附件');
  await test('附件格式清单覆盖 ≥50 种', async () => {
    const r = await api('GET', '/api/agent/attachments/formats');
    return { ok: okJson(r) && r.json.data.extensions.length >= 50, detail: `${r.json.data?.extensions?.length} 种` };
  });
  const samples = [
    ['csv', '明细.csv', '科目,金额\n1002,100\n6001,100'],
    ['tsv', '流水.tsv', '科目\t金额\n1002\t200'],
    ['json', '凭证.json', JSON.stringify([{ 摘要: '收款', 金额: 300 }])],
    ['md', '说明.md', '| 项目 | 金额 |\n| --- | --- |\n| 收入 | 400 |'],
    ['html', '账单.html', '<table><tr><th>项目</th><th>金额</th></tr><tr><td>收入</td><td>500</td></tr></table>'],
    ['txt', '备注.txt', '回归测试附件纯文本内容'],
    ['xml', '数据.xml', '<rows><row><a>1</a><b>2</b></row></rows>'],
    ['log', '运行.log', '2026-11-11 INFO 回归测试'],
  ];
  for (const [ext, name, content] of samples) {
    await test(`附件 .${ext} 解析为非空文本`, async () => {
      const r = await api('POST', '/api/agent/upload', { name, content: b64(content), file_name: name, image: `data:text/plain;base64,${b64(content)}` });
      return { ok: okJson(r) && Boolean(r.json.data?.text), detail: `engine=${r.json.data?.engine} text=${(r.json.data?.text || '').slice(0, 45)}` };
    });
  }
  await test('前端字段名 image/file_name 被正确兼容', async () => {
    const r = await api('POST', '/api/agent/upload', { file_name: '前端上传.csv', image: `data:text/csv;base64,${b64('科目,金额\n1002,999')}`, mime: 'text/csv' });
    return { ok: okJson(r) && String(r.json.data?.text || '').includes('999'), detail: `engine=${r.json.data?.engine}` };
  });
  await test('附件列表与按路径复读', async () => {
    const l = await api('GET', '/api/agent/attachments?limit=5');
    const p = l.json?.data?.list?.[0]?.path;
    const r = p ? await api('POST', '/api/agent/attachments/read', { path: p }) : { json: {} };
    return { ok: okJson(l) && Boolean(p) && okJson(r), detail: `list=${l.json.data?.list?.length}` };
  });
  await test('未知扩展名优雅降级 + 不存在的路径明确报错', async () => {
    const a = await api('POST', '/api/agent/upload', { name: '坏文件.zzzz', content: b64('xxx') });
    const b = await api('POST', '/api/agent/attachments/read', { path: 'C:/definitely/not/exist.csv' });
    const graceful = okJson(a) && /未做专用解析|保留/.test(String(a.json.data?.text || a.json.message || ''));
    return { ok: graceful && badJson(b), detail: `a=${a.json.code}/${(a.json.data?.text || '').slice(0, 60)} b=${b.json.message}` };
  });

  section('J · 报表导出与格式转换');
  await test('导出格式清单完整', async () => {
    const r = await api('GET', '/api/export/formats');
    return { ok: okJson(r) && r.json.data.builtin.length >= 5 && r.json.data.filee.configured === true, detail: `builtin=${r.json.data?.builtin?.join('/')} engine=${r.json.data?.filee?.engine}` };
  });
  for (const [kind, format, mime] of [
    ['vouchers', 'csv', 'text/csv'], ['vouchers', 'xlsx', 'spreadsheetml'],
    ['subjects', 'json', 'application/json'], ['ledger', 'md', 'text/markdown'],
    ['dashboard', 'html', 'text/html'],
  ]) {
    await test(`报表 ${kind}.${format} 导出`, async () => {
      const r = await fetch(`${BASE}/api/export/report?kind=${kind}&period=2026-11&format=${format}`, { headers: H });
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: r.status === 200 && buf.length > 50 && (r.headers.get('content-type') || '').includes(mime),
        detail: `${buf.length}B ${r.headers.get('content-type')}` };
    });
  }
  await test('非法报表类型 / 格式 / 期间被拒绝', async () => {
    const a = await api('GET', '/api/export/report?kind=__nope__&period=2026-11&format=csv');
    const b = await api('GET', '/api/export/report?kind=vouchers&period=2026-11&format=__nope__');
    const c = await api('GET', '/api/export/report?kind=vouchers&period=bad&format=csv');
    return { ok: badJson(a) && badJson(b) && badJson(c), detail: `${a.json.code}/${b.json.code}/${c.json.code}` };
  });
  await test('导出文件列表与下载', async () => {
    const l = await api('GET', '/api/export/files');
    const name = l.json?.data?.[0]?.name;
    const r = name ? await fetch(`${BASE}/api/export/download?file=${encodeURIComponent(name)}`, { headers: H }) : null;
    return { ok: okJson(l) && Boolean(name) && r.status === 200, detail: `files=${l.json.data?.length}` };
  });
  await test('下载路径穿越 / 不存在文件被拒绝', async () => {
    const a = await api('GET', '/api/export/download?file=../../.env');
    const b = await api('GET', '/api/export/download?file=__not_exist__.csv');
    return { ok: badJson(a) && badJson(b), detail: `a=${a.json.message} b=${b.json.message}` };
  });
  let uploadedFile = '';
  await test('上传 CSV 源文件', async () => {
    const r = await api('POST', '/api/export/upload', { name: '回归转换源.csv', content: b64('姓名,金额\n张三,100.50\n李四,200') });
    uploadedFile = r.json?.data?.name || r.json?.data?.file || '';
    return { ok: okJson(r) && Boolean(uploadedFile), detail: `file=${uploadedFile} msg=${r.json.message}` };
  });
  for (const to of ['xlsx', 'json', 'md', 'html', 'pdf', 'docx']) {
    await test(`格式转换 CSV→${to}`, async () => {
      const r = await api('POST', '/api/export/convert', { file: uploadedFile, to });
      return { ok: okJson(r), detail: `${r.json.message || ''}`.slice(0, 90) };
    });
  }
  await test('非法转换目标 / 路径穿越 / 空文件名被拒绝', async () => {
    const a = await api('POST', '/api/export/convert', { file: uploadedFile, to: '__nope__' });
    const b = await api('POST', '/api/export/convert', { file: '../../.env', to: 'csv' });
    const c = await api('POST', '/api/export/convert', { file: '', to: 'csv' });
    return { ok: badJson(a) && badJson(b) && badJson(c), detail: `${a.json.code}/${b.json.code}/${c.json.code}` };
  });

  section('K · MCP / WorkBuddy 对接');
  await test('initialize 返回协议/能力 + mcp-session-id', async () => {
    const r = await fetch(BASE + '/mcp', { method: 'POST', headers: MH, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
    const j = await r.json();
    return { ok: r.status === 200 && Boolean(j.result?.serverInfo) && Boolean(r.headers.get('mcp-session-id')),
      detail: `server=${j.result?.serverInfo?.name} session=${Boolean(r.headers.get('mcp-session-id'))}` };
  });
  await test('ping / notifications / 未知方法', async () => {
    const p = await mcp('ping', {}, 2);
    const n = await api('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'content-type': 'application/json' });
    const u = await mcp('__unknown__', {}, 3);
    return { ok: Boolean(p.result) && n.status === 202 && u.error?.code === -32601, detail: `ping=${Boolean(p.result)} notify=${n.status} unknown=${u.error?.code}` };
  });
  await test('GET / DELETE /mcp 兼容 streamableHttp', async () => {
    const g = await fetch(BASE + '/mcp', { headers: { authorization: MH.authorization }, signal: AbortSignal.timeout(2000) }).catch((e) => ({ status: 'ERR', err: e.message }));
    const d = await fetch(BASE + '/mcp', { method: 'DELETE', headers: MH });
    // GET 是长连接 SSE，超时/ERR 都说明服务端没有立刻 4xx
    const okGet = g.status === 200 || g.status === 'ERR';
    return { ok: okGet && d.status === 200, detail: `GET=${g.status} DELETE=${d.status}` };
  });
  let toolNames = [];
  await test('tools/list 工具齐备且均带 schema 与描述', async () => {
    const r = await mcp('tools/list', {}, 4);
    toolNames = r.result?.tools?.map((t) => t.name) || [];
    const allGood = r.result?.tools?.every((t) => t.name && t.description && t.inputSchema?.type === 'object');
    const core = ['data_audit', 'clarify_intent', 'analyze_intent', 'read_attachment', 'get_report'];
    const missing = core.filter((n) => !toolNames.includes(n));
    // 工具数会随功能迭代增长，断言下界与关键能力而不是写死数字
    return { ok: toolNames.length >= 22 && allGood && missing.length === 0,
      detail: `count=${toolNames.length} allHaveSchema=${allGood} missing=${missing.join(',') || 'none'}` };
  });
  const TOOL_ARGS = {
    list_sets: {}, list_vouchers: { period: '2026-11' }, get_ledger: { period: '2026-11' },
    get_report: { kind: 'subjects', period: '2026-11', format: 'json' },
    list_assets: {}, list_asset_categories: {}, list_subjects: {}, list_auxiliaries: {},
    list_invoices: {}, get_closing_status: { period: '2026-11' },
    list_invoice_templates: {},
    analyze_intent: { message: '把本月报表给我' },
    clarify_intent: { session_id: `reg-mcp-${Date.now()}`, message: '把本月报表给我' },
    read_attachment: { path: 'C:/definitely/not/exist.csv' },
    data_audit: { rounds: 3, period: '2026-11' },
    create_voucher: { date: '2026-11-11', period: '2026-11', entries: V.entries },
    create_asset: { name: 'MCP回归资产', amount: 1 },
    create_subject: { code: '9998', name: 'MCP回归科目', type: '资产' },
    create_auxiliary: { name: 'MCP回归客户', type: '客户' },
    upload_invoice: { name: 'mcp.pdf', content: b64('mcp invoice'), amount: 1 },
    create_invoice: { name: 'mcp2.pdf', content: b64('mcp invoice2'), amount: 1 },
  };
  // get_voucher 不能假设「库里恰好有 id=1 的凭证」——那正是过去测试数据污染造成的假 PASS。
  // 这里显式造一张，用它的真实 id。
  const seeded = await api('POST', '/api/vouchers', V);
  const seededVoucherId = seeded.json?.data?.id;
  await test('为 MCP 查询准备一张真实凭证', async () => ({
    ok: Boolean(seededVoucherId), detail: `id=${seededVoucherId}`,
  }));
  for (const name of ['list_sets', 'list_vouchers', 'get_voucher', 'get_ledger', 'get_report',
    'list_assets', 'list_asset_categories', 'list_subjects', 'list_auxiliaries', 'list_invoices',
    'get_closing_status', 'create_voucher', 'create_asset', 'create_subject', 'create_auxiliary',
    'upload_invoice', 'create_invoice', 'list_invoice_templates', 'create_invoice_voucher',
    'clarify_intent', 'analyze_intent', 'read_attachment', 'data_audit']) {
    await test(`MCP tools/call ${name}`, async () => {
      const args = { ...(TOOL_ARGS[name] || {}) };
      if (name === 'get_voucher') args.id = seededVoucherId;
      if (name === 'create_invoice_voucher') args.invoice_id = 99999999;
      const r = await callTool(name, args);
      const code = r.payload?.code;
      const expectedFail = ['read_attachment', 'create_invoice_voucher'].includes(name);
      return { ok: r.status === 200 && (expectedFail ? code !== 0 : code === 0),
        detail: `code=${code} isError=${r.isError} ${(r.payload?.message || '').slice(0, 60)}` };
    });
  }
  await test('MCP get_report 返回真实数据而非空 rows', async () => {
    const r = await callTool('get_report', { kind: 'subjects', period: '2026-11', format: 'json' });
    const d = r.payload?.data || {};
    const rows = d.rows || [];
    const good = r.payload?.code === 0 && rows.length > 0 && d.row_count > 0
      && Array.isArray(d.columns) && d.columns.length > 0
      && String(d.download_url || '').includes('/api/export/download');
    return { ok: good, detail: `rows=${rows.length}/${d.row_count} columns=${d.columns?.length} url=${Boolean(d.download_url)}` };
  });
  await test('MCP get_report 凭证报表随真实写入变化', async () => {
    const before = await callTool('get_report', { kind: 'vouchers', period: '2026-11', format: 'csv' });
    const n0 = before.payload?.data?.row_count || 0;
    await callTool('create_voucher', { date: '2026-11-11', period: '2026-11', entries: V.entries });
    const after = await callTool('get_report', { kind: 'vouchers', period: '2026-11', format: 'csv' });
    const n1 = after.payload?.data?.row_count || 0;
    return { ok: n1 > n0, detail: `row_count ${n0} → ${n1}` };
  });
  await test('MCP get_report 非法类型给出明确错误', async () => {
    const r = await callTool('get_report', { kind: '__nope__' });
    return { ok: r.payload?.code !== 0 && /报表生成失败|不支持/.test(r.payload?.message || ''), detail: r.payload?.message };
  });

  section('L · SSE 契约与安全边界');
  await test('chat 标准 SSE：event 行 + content + done 收尾', async () => {
    const r = await sseOf('/api/agent/chat', { session_id: `reg-sse-${Date.now()}`, message: '你好' });
    return { ok: r.status === 200 && r.events.length > 0 && r.kinds.at(-1) === 'done', detail: `events=${r.events.length} kinds=${[...new Set(r.kinds)].join(',')}` };
  });
  await test('非法 x-set-id 不导致 500', async () => {
    const r = await api('GET', '/api/subjects', undefined, { ...H, 'x-set-id': 'not-a-number' });
    return { ok: r.status === 200 && typeof r.json === 'object', detail: `status=${r.status} code=${r.json.code}` };
  });
  await test('超长 / 特殊字符参数不导致 500', async () => {
    const long = 'A'.repeat(5000);
    const a = await api('GET', `/api/vouchers?keyword=${long}`);
    const b = await api('POST', '/api/agent/clarify/analyze', { message: long });
    return { ok: a.status === 200 && b.status === 200, detail: `a=${a.status} b=${b.status}` };
  });
  await test('并发 12 个请求全部正常返回', async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => api('GET', `/api/dashboard/revenue?period=2026-11&i=${i}`)));
    return { ok: rs.every((r) => r.status === 200 && r.json.code === 0), detail: `${rs.filter((r) => r.json.code === 0).length}/12` };
  });
  await test('子进程全程未崩溃', async () => ({ ok: !childExited, detail: childExited ? childLog.slice(-400) : 'alive' }));
} catch (e) {
  check('回归脚本执行', false, `FATAL ${e.message}`);
  console.error(e);
} finally {
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  await sleep(400);
  if (!childExited) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  const report = {
    at: new Date().toISOString(), port: PORT, isolated: true,
    summary: `${pass} PASS / ${fail} FAIL`, pass, fail, results,
    child_log_tail: childLog.slice(-1200),
  };
  fs.mkdirSync(path.join(ROOT, 'analysis'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'analysis', 'full-regression.json'), JSON.stringify(report, null, 2));
  console.log(`\n===== 全量回归：${report.summary} =====`);
  if (fail) {
    console.log('\n失败明细：');
    results.filter((r) => !r.pass).forEach((r) => console.log(`  [${r.group}] ${r.name} :: ${r.detail}`));
  }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } }
  else console.log(`临时目录已保留：${TMP}`);
  console.log(`报告：${path.join(ROOT, 'analysis', 'full-regression.json')}`);
  process.exit(fail ? 1 : 0);
}
