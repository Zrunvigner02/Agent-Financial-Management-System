#!/usr/bin/env node
/**
 * shot-html —— 把本地 HTML 整页截成 PNG（无头 Chrome + CDP，整页不截断）
 *
 * 用途：桌面「振颜丽舍项目资料/可编辑源文件」里那些 HTML 源文件，改完内容重新出图。
 *
 *   node tools/shot-html.mjs "C:/path/下一步计划.html" "C:/path/下一步计划清单.png"
 *   node tools/shot-html.mjs in.html out.png 1080
 *
 * 第三个参数是视口宽度（默认 1080，与源文件 body 宽度一致）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const [input, output, widthArg, heightArg] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法：node tools/shot-html.mjs <input.html> <output.png> [宽度=1080] [高度=自动]');
  process.exit(1);
}
if (!CHROME) {
  console.error('找不到 Chrome / Edge');
  process.exit(1);
}

const SRC = path.resolve(input);
const OUT = path.resolve(output);
const WIDTH = Number(widthArg || 1080);
const PORT = 9335;
const PROFILE = path.join(path.dirname(SRC), '.shot-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return { ws, send, ready };
}

fs.mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--allow-file-access-from-files',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

try {
  let up = false;
  for (let i = 0; i < 40; i += 1) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); up = true; break; } catch { await sleep(400); }
  }
  if (!up) throw new Error('无头浏览器启动超时');

  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const { send, ready, ws } = connect(t.webSocketDebuggerUrl);
  await ready;
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: pathToFileURL(SRC).href });
  await sleep(1200);   // 等字体与布局稳定

  const m = await send('Page.getLayoutMetrics');
  const box = m.cssContentSize || m.contentSize;
  const w = Math.ceil(box.width);
  const h = Number(heightArg) > 0 ? Math.ceil(Number(heightArg)) : Math.ceil(box.height);

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`ok ${w}×${h} -> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
