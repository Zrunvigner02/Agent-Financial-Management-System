#!/usr/bin/env node
/**
 * 品牌命名自检：页面上不应再出现旧名字
 *
 *   node tools/test-brand.mjs
 *
 * 检查：标题 / 可见文本 / 顶部 Tab 是否已全部改成「振颜丽舍」「智能体」，
 * 且不再出现「妆点」「锦鲤」。截图存 .local/brand-check.png 便于人工核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.local', 'brand-profile');
const SHOT = path.join(ROOT, '.local', 'brand-check.png');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:8000';
const PORT = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OLD = ['妆点', '锦鲤'];

let pass = 0;
let fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name}${extra ? ` -> ${extra}` : ''}`); }
};

if (!CHROME) { console.log('找不到 Chrome / Edge，跳过'); process.exit(0); }

const cred = JSON.parse(fs.readFileSync(path.join(ROOT, '.local', 'desktop-credentials.json'), 'utf8'));
const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: cred.username, password: cred.password }),
}).then((r) => r.json());
const auth = login.data;

fs.mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1440,940', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore', windowsHide: true });

function connect(wsUrl, errors) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(String(m.params?.exceptionDetails?.text || '').slice(0, 160));
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

try {
  for (let i = 0; i < 40; i += 1) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(300); }
  }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const errors = [];
  const { send, ready, ws } = connect(t.webSocketDebuggerUrl, errors);
  await ready;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(1500);
  await send('Runtime.evaluate', {
    expression: `(() => { const v = { jl_token: ${JSON.stringify(auth.token)},
      jl_username: ${JSON.stringify(auth.username || '')}, jl_name: ${JSON.stringify(auth.name || '')},
      jl_role: ${JSON.stringify(String(auth.roleId ?? auth.role ?? ''))},
      jl_menus: ${JSON.stringify(JSON.stringify(auth.menus || []))},
      jl_set_id: ${JSON.stringify(String(auth.set_id || 85))} };
      for (const [k, val] of Object.entries(v)) { localStorage.setItem(k, val); sessionStorage.setItem(k, val); }
      return true; })()`,
  });
  await send('Page.navigate', { url: `${BASE}/dashboard` });
  await sleep(4200);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r?.result?.value;
  };

  const title = await ev('document.title');
  check(String(title).includes('振颜丽舍'), '页面标题已是振颜丽舍', String(title));
  check(!OLD.some((w) => String(title).includes(w)), '标题无旧名', String(title));

  const text = await ev('document.body.innerText.slice(0, 20000)');
  check(!OLD.some((w) => String(text).includes(w)), '页面可见文本无旧名',
    OLD.filter((w) => String(text).includes(w)).join('/'));
  check(String(text).includes('振颜丽舍'), '页面出现振颜丽舍');

  // 财务看板不再注入「时间维度」条（点三年会被误认为跳转报表中心）
  check((await ev('!!document.getElementById("zd-dash-dims")')) === false, '财务看板无时间维度条');

  const tabs = await ev('[...document.querySelectorAll(".ws-tabs .ws-tab")].map((x) => x.textContent.trim())');
  check(Array.isArray(tabs) && tabs.includes('智能体'), '顶部 Tab 为 财务/销售/智能体', JSON.stringify(tabs));
  check(!JSON.stringify(tabs).includes('妆点'), 'Tab 无旧智能体名', JSON.stringify(tabs));

  // 智能体页同样不能有旧名
  await send('Page.navigate', { url: `${BASE}/agent` });
  await sleep(3600);
  const agentTitle = await ev('document.title');
  const agentTabs = await ev('[...document.querySelectorAll(".ws-tabs .ws-tab")].map((x) => x.textContent.trim())');
  check(!OLD.some((w) => String(agentTitle).includes(w)), '智能体页标题无旧名', String(agentTitle));
  check(!JSON.stringify(agentTabs).includes('妆点'), '智能体页 Tab 无旧名', JSON.stringify(agentTabs));
  // 说明：历史对话正文里可能仍带旧品牌字样（那是记录，不是命名），这里只做提示不算失败
  const legacyHits = await ev(`(document.body.innerText.match(/妆点|锦鲤/g) || []).length`);
  console.log(`INFO 智能体页历史正文中旧名出现 ${legacyHits} 次（记录内容，保留）`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log(`shot -> ${SHOT}`);
  check(errors.length === 0, '无 JS 异常', errors.slice(0, 2).join(' | '));
  ws.close();
} finally {
  chrome.kill();
}

console.log(`\n===== 品牌命名自检：${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
