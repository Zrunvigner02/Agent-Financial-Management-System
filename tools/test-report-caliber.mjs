#!/usr/bin/env node
/**
 * 报表中心口径自检：财务口径不能再是空的
 *
 *   node tools/test-report-caliber.mjs
 *
 * 验证三件事：
 *   1. 财务口径在「没有已审核凭证」时，自动按销售实发数据实时计算（KPI 非 0）
 *   2. 销售数据做了来源去重（同日期同渠道 wdt 优先，不被 wecom 旧口径重复计入）
 *   3. 页面无 JS 异常，并留一张截图 .local/report-finance.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.local', 'rp-profile');
const SHOT = path.join(ROOT, '.local', 'report-finance.png');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:8000';
const PORT = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
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

/* ---------- 后端口径：去重与数字 ---------- */
const hdr = { authorization: `Bearer ${auth.token}`, 'x-set-id': String(auth.set_id || 85) };
const sales = await fetch(`${API}/api/enterprise/sales?from=2026-11-16&to=2026-11-30&limit=5000`, { headers: hdr }).then((r) => r.json());
const items = (sales.data && sales.data.items) || [];
const sources = [...new Set(items.map((x) => x.source))];
check(items.length > 0, '区间有销售数据', `${items.length} 行`);
check(!(sources.includes('wdt') && sources.includes('wecom')), '同区间不再混用两套来源（已去重）', sources.join('/'));

const sum = (k) => items.reduce((a, x) => a + Number(x[k] || 0), 0);
const amt = sum('amount');
check(amt > 0, '销售额大于 0', amt.toFixed(2));

const income = await fetch(`${API}/api/reports/income?period=2026-11`, { headers: hdr }).then((r) => r.json());
const rows = (income.data && income.data.rows) || [];
const rev = Number((rows.find((r) => String(r.name || '').includes('营业收入')) || {}).v1 || 0);
check(rev === 0, '草稿凭证不计入利润表（口径一致）', `营业收入 v1=${rev}`);

/* ---------- 前端：财务口径渲染 ---------- */
fs.mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1440,1000', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

const waitJson = async (url, tries = 60) => {
  for (let i = 0; i < tries; i += 1) {
    try { return await fetch(url).then((r) => r.json()); } catch { await sleep(250); }
  }
  throw new Error(`连不上 ${url}`);
};

let ws;
try {
  const list = await waitJson(`http://127.0.0.1:${PORT}/json/list`);
  const target = list.find((t) => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || 'exception');
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    id += 1;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(2600);

  await send('Runtime.evaluate', {
    expression: `(() => { const v = { jl_token: ${JSON.stringify(auth.token)},
      jl_username: ${JSON.stringify(auth.username || '')}, jl_name: ${JSON.stringify(auth.name || '')},
      jl_role: ${JSON.stringify(String(auth.roleId ?? auth.role ?? ''))},
      jl_menus: ${JSON.stringify(JSON.stringify(auth.menus || []))},
      jl_set_id: ${JSON.stringify(String(auth.set_id || 85))} };
      for (const [k, val] of Object.entries(v)) { localStorage.setItem(k, val); sessionStorage.setItem(k, val); } return true; })()`,
  });
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(3200);

  const hasFn = await ev('typeof window.__zdOpenReports === "function"');
  check(hasFn === true, '报表中心脚本已加载');

  await ev('window.__zdOpenReports("finance","halfmonth","summary")');
  await sleep(2600);

  const kpi = await ev(`(() => {
    const box = document.querySelector('.zd-rp.show');
    if (!box) return null;
    const nums = [...box.querySelectorAll('.zd-rp-kpi .v')].map((x) => x.textContent.trim());
    const note = (box.querySelector('.zd-rp-note') || {}).textContent || '';
    return { nums, note: note.trim().slice(0, 80) };
  })()`);
  check(!!kpi, '财务口径面板已渲染');
  const sales0 = kpi ? kpi.nums[0] : '';
  check(!!sales0 && sales0 !== '¥0.00', '财务口径销售额不为 0', sales0);
  check(!!kpi && /销售数据|实际发生/.test(kpi.note), '标注了数据来源口径', kpi ? kpi.note : '');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  check(errors.length === 0, '页面无 JS 异常', errors.slice(0, 2).join(' | '));
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  chrome.kill();
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
console.log(`截图：${SHOT}`);
process.exit(fail ? 1 : 0);
