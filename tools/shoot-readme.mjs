#!/usr/bin/env node
/**
 * shoot-readme —— 用无头 Chrome 给 README 拍界面图（真实数据、当前品牌）
 *
 * 做法：起一个独立的 headless Chrome（remote-debugging），注入本地登录态，逐页截图。
 * 只读接口 + 截图落盘，不改任何业务数据。
 *
 *   node tools/shoot-readme.mjs                 # 拍默认 4 个页面
 *   node tools/shoot-readme.mjs /dashboard /agent
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'images');
const PROFILE = path.join(ROOT, '.local', 'shoot-profile');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:8000';
const PORT = 9333;

const PAGES = {
  '/dashboard': 'dashboard.png',
  '/agent': 'agent.png',
  '/ledger': 'ledger.png',
  '/closing/index': 'closing.png',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function cdpTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

async function newTarget(url) {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${url}`, { method: 'PUT' });
  if (!r.ok) throw new Error(`创建标签页失败 ${r.status}`);
  return r.json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
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
const setId = String(auth.set_id || 85);
const routes = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PAGES);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--window-size=1600,1000',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

try {
  for (let i = 0; i < 40; i += 1) {
    try { await cdpTargets(); break; } catch { await sleep(400); }
  }
  for (const route of routes) {
    const name = PAGES[route] || `${route.replace(/\//g, '-').replace(/^-/, '')}.png`;
    const target = await newTarget('about:blank');
    const { send, ready, ws } = connect(target.webSocketDebuggerUrl);
    await ready;
    await send('Page.enable');
    await send('Runtime.enable');
    // 先落地到同源页面，才有 sessionStorage 可写
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(1500);
    // 注入登录态（与桌面端 sessionInjection 同一套字段）
    await send('Runtime.evaluate', {
      expression: `(() => { const s = sessionStorage;
        s.setItem('jl_token', ${JSON.stringify(auth.token)});
        s.setItem('jl_username', ${JSON.stringify(auth.username || '')});
        s.setItem('jl_name', ${JSON.stringify(auth.name || '')});
        s.setItem('jl_role', ${JSON.stringify(auth.role || '')});
        s.setItem('jl_menus', ${JSON.stringify(JSON.stringify(auth.menus || []))});
        s.setItem('jl_set_id', ${JSON.stringify(setId)});
        s.setItem('jl_set_name', '振颜丽舍');
        return true; })()`,
      awaitPromise: true,
    });
    await send('Page.navigate', { url: `${BASE}${route}` });
    await sleep(4200);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
    console.log(`shot ${route} -> docs/images/${name}`);
    ws.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {});
  }
} finally {
  chrome.kill();
}
