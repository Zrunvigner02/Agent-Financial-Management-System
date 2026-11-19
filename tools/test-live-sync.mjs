#!/usr/bin/env node
/**
 * 实时同步自检：无头 Chrome 打开真实页面，验证 upstream/live-sync.js 已生效。
 *
 * 检查项：
 *   1. 脚本已注入（window.__zdLive 存在）
 *   2. 轮询状态可读（status() 返回 sig / interval）
 *   3. 点「智能体」Tab 会整页切到 /agent（不是无声无息）
 *   4. 手动 refresh() 触发重载后脚本仍在（重载链路正常）
 *   5. 全程无 JS 异常
 *
 *   node tools/test-live-sync.mjs
 * 只读、不改业务数据；关掉页面即结束。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.local', 'live-sync-profile');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:8000';
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name}${extra ? ` -> ${extra}` : ''}`); }
};

if (!CHROME) {
  console.log('找不到 Chrome / Edge，跳过');
  process.exit(0);
}

async function login() {
  const cred = JSON.parse(fs.readFileSync(path.join(ROOT, '.local', 'desktop-credentials.json'), 'utf8'));
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: cred.username, password: cred.password }),
  });
  const j = await r.json();
  if (!j?.data?.token) throw new Error('本地登录失败');
  return j.data;
}

function connect(wsUrl, errors) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails;
      errors.push(String(d?.exception?.description || d?.text || '').slice(0, 200));
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return { ws, send, ready };
}

const auth = await login();
fs.mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--window-size=1440,900',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

try {
  for (let i = 0; i < 40; i += 1) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(400); }
  }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const errors = [];
  const { send, ready, ws } = connect(t.webSocketDebuggerUrl, errors);
  await ready;
  await send('Page.enable');
  await send('Runtime.enable');

  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(1600);
  await send('Runtime.evaluate', {
    expression: `(() => {
      const v = {
        jl_token: ${JSON.stringify(auth.token)},
        jl_username: ${JSON.stringify(auth.username || '')},
        jl_name: ${JSON.stringify(auth.name || '')},
        jl_role: ${JSON.stringify(String(auth.roleId ?? auth.role ?? ''))},
        jl_menus: ${JSON.stringify(JSON.stringify(auth.menus || []))},
        jl_set_id: ${JSON.stringify(String(auth.set_id || 85))},
      };
      for (const [k, val] of Object.entries(v)) { localStorage.setItem(k, val); sessionStorage.setItem(k, val); }
      return true; })()`,
    awaitPromise: true,
  });

  await send('Page.navigate', { url: `${BASE}/dashboard` });
  await sleep(4200);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r?.result?.value;
  };

  check(await ev('typeof window.__zdLive === "object"'), '脚本已注入（window.__zdLive）');
  const st = await ev('window.__zdLive ? window.__zdLive.status() : null');
  check(!!st && st.interval === 6000, '轮询状态可读', JSON.stringify(st));
  check(await ev('!!document.querySelector(".ws-tabs .ws-tab")'), '已找到顶部 Tab');

  // 点「智能体」→ 应整页切到 /agent
  await ev(`(() => {
    const tabs = [...document.querySelectorAll('.ws-tabs .ws-tab')];
    const t = tabs.find((x) => /智能体/.test(x.textContent || ''));
    if (!t) return 'no-tab';
    t.click();
    return 'clicked';
  })()`);
  await sleep(3600);
  const path1 = await ev('location.pathname');
  check(path1 === '/agent', '点智能体 Tab 后落在 /agent', path1);
  check(await ev('typeof window.__zdLive === "object"'), '切换后脚本仍生效');

  // 手动 refresh：应重载并继续可用
  await ev('window.__zdLive.refresh()');
  await sleep(3600);
  check(await ev('typeof window.__zdLive === "object"'), '自动重载后脚本仍生效');
  // 旧版桌面壳注入的"点此刷新"提示条，必须被页面脚本自动摘掉
  await ev(`(() => { const d = document.createElement('div');
    d.textContent = '有新的助理对话，点此刷新'; document.body.appendChild(d); return true; })()`);
  await sleep(400);
  const legacy = await ev(`[...document.body.children].some((x) => (x.textContent || '').trim() === '有新的助理对话，点此刷新')`);
  check(legacy === false, '旧版「点此刷新」提示条被自动摘除', String(legacy));

  const sig = await ev('window.__zdLive.status().sig');
  check(typeof sig === 'string' && sig.includes(':'), '活跃度签名已建立', String(sig));

  check(errors.length === 0, '无 JS 异常', errors.slice(0, 2).join(' | '));

  ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
} finally {
  chrome.kill();
}

console.log(`\n===== 实时同步自检：${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
