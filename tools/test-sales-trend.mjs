#!/usr/bin/env node
/**
 * 销售看板 · 日销售趋势交互自检
 *
 * 验证：面板存在 → 快捷区间可切 → 滚轮缩放 → 拖动看更早 → 悬停提示 → 无 JS 异常。
 * 同时截图到 .local/trend-board.png 便于人工核对。
 *
 *   node tools/test-sales-trend.mjs
 * 只读：只打开页面和调用 GET 接口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.local', 'trend-profile');
const SHOT = path.join(ROOT, '.local', 'trend-board.png');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:8000';
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name}${extra ? ` -> ${extra}` : ''}`); }
};

if (!CHROME) { console.log('找不到 Chrome / Edge，跳过'); process.exit(0); }

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
      errors.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '').slice(0, 220));
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
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1440,1000', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank',
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

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
  await sleep(4000);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r?.result?.value;
  };

  const opened = await ev(`(() => { const b = document.querySelector('[data-zd-sales]'); if (!b) return 'no-tab'; b.click(); return 'ok'; })()`);
  await sleep(3200);
  check(opened === 'ok', '打开销售看板');
  check(await ev('!!document.querySelector("[data-role=\\"trend\\"]")'), '趋势面板已渲染');

  const label0 = await ev('document.querySelector("[data-tt-label]").textContent');
  check(/\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2} · \d+ 天/.test(String(label0)), '默认区间显示', label0);
  const days0 = Number(String(label0).match(/(\d+) 天/)?.[1] || 0);
  check(days0 === 31, '默认最近 31 天', String(days0));

  // 快捷区间 90 天
  await ev(`(() => { const b = [...document.querySelectorAll('[data-tt-range]')].find((x) => x.getAttribute('data-tt-range') === '90'); if (b) b.click(); return !!b; })()`);
  await sleep(400);
  const label90 = await ev('document.querySelector("[data-tt-label]").textContent');
  check(/(\d+) 天/.test(label90) && Number(label90.match(/(\d+) 天/)[1]) === 90, '切到 90 天', label90);

  // 滚轮放大（deltaY<0）→ 天数变少
  const box = await ev(`(() => { const r = document.querySelector('[data-role="trend-canvas"]').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -240, pointerType: 'mouse' });
  await sleep(500);
  const labelZoom = await ev('document.querySelector("[data-tt-label]").textContent');
  const daysZoom = Number(String(labelZoom).match(/(\d+) 天/)?.[1] || 0);
  check(daysZoom > 0 && daysZoom < 90, '滚轮放大后区间变窄', `${daysZoom} 天`);

  // 拖动（向右拖 = 看更早）
  const before = await ev('document.querySelector("[data-tt-label]").textContent');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= 6; i += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + i * 60, y: box.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(60);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 360, y: box.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(500);
  const after = await ev('document.querySelector("[data-tt-label]").textContent');
  check(after !== before, '拖动后区间改变（可看更早）', `${before} → ${after}`);

  // 悬停提示
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, pointerType: 'mouse' });
  await sleep(300);
  const tip = await ev(`(() => { const t = document.querySelector('[data-tt-tip]'); return t ? { show: t.style.display, text: t.textContent } : null; })()`);
  check(!!tip && tip.show === 'block' && /¥/.test(tip.text || ''), '悬停显示日期与金额', JSON.stringify(tip));

  // 统计行
  const stats = await ev('document.querySelector("[data-tt-stats]").textContent');
  check(/区间销售额/.test(String(stats)), '区间合计实时计算', String(stats).slice(0, 60));

  /* ---------- 月度趋势：拖得动、缩得了 ---------- */
  await ev(`(() => { const c = document.querySelector('[data-dim="3year"]'); if (c) c.click(); return !!c; })()`);
  await sleep(3600);
  const mLabel0 = await ev('document.querySelector("[data-mt-label]")?.textContent || ""');
  check(/-\d{2} ~ .*-\d{2} · \d+ 个月/.test(mLabel0), '月度趋势默认显示', mLabel0);

  const mBox = await ev(`(() => { const el = document.querySelector('[data-role="mtrend-canvas"]'); if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  check(!!mBox, '月度趋势画布可定位');

  await ev(`(() => { const b = [...document.querySelectorAll('[data-mt-range]')].find((x) => x.getAttribute('data-mt-range') === 'all'); if (b) b.click(); return !!b; })()`);
  await sleep(400);
  const mAll = await ev('document.querySelector("[data-mt-label]")?.textContent || ""');
  const mAllN = Number(String(mAll).match(/(\d+) 个月/)?.[1] || 0);
  check(mAllN > 12, '切「全部」后涵盖三年月份', mAll);

  // 先滚轮缩小到较小窗口，才拖得动
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mBox.x, y: mBox.y, deltaX: 0, deltaY: -240, pointerType: 'mouse' });
  await sleep(400);
  const mZoomIn = await ev('document.querySelector("[data-mt-label]")?.textContent || ""');
  const mZoomInN = Number(String(mZoomIn).match(/(\d+) 个月/)?.[1] || 0);
  check(mZoomInN > 0 && mZoomInN < mAllN, '月度趋势滚轮缩放生效', `${mAllN} → ${mZoomInN} 个月`);

  const mBefore = mZoomIn;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mBox.x, y: mBox.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= 5; i += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mBox.x + i * 55, y: mBox.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(60);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mBox.x + 275, y: mBox.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(500);
  const mAfter = await ev('document.querySelector("[data-mt-label]")?.textContent || ""');
  check(mAfter !== mBefore, '月度趋势拖动后区间改变', `${mBefore} → ${mAfter}`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log(`shot -> ${SHOT}`);

  check(errors.length === 0, '无 JS 异常', errors.slice(0, 2).join(' | '));
  ws.close();
} finally {
  chrome.kill();
}

console.log(`\n===== 日趋势交互自检：${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
