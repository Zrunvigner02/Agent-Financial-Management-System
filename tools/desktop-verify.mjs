/** 桌面端窗口实证：连 Electron CDP，验证路由/会话/业务数据，并截图留证。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DESKTOP_CDP_PORT || 9333);
const OUT = path.join(ROOT, '.local', 'desktop-screenshot.png');

// 桌面端只有在带 --remote-debugging-port=9333 启动时才暴露 CDP。
// 未启用时属于环境限制（不是产品缺陷），给出明确 SKIP 而不是抛出未捕获异常。
let targets;
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  targets = await r.json();
} catch (e) {
  console.log(`DESKTOP_VERIFY=SKIP — 桌面端未开启 CDP 调试端口 ${PORT}（${e.message}）`);
  console.log('启用方式：启动桌面端时加 --remote-debugging-port=9333，或改用 Chrome 9222 页面验证。');
  process.exit(0);
}
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.log(`DESKTOP_VERIFY=SKIP — CDP ${PORT} 已连接但没有可用页面目标`);
  process.exit(0);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
try {
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket 连接桌面窗口失败'));
  });
} catch (e) {
  console.log(`DESKTOP_VERIFY=SKIP — ${e.message}`);
  process.exit(0);
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const expression = `(async () => {
  const s = sessionStorage;
  const token = s.getItem('jl_token') || '';
  let total = null, apiCode = null;
  try {
    const r = await fetch('/api/vouchers?period=2026-11', {
      headers: { Authorization: 'Bearer ' + token, 'X-Set-Id': s.getItem('jl_set_id') || '' },
    });
    const j = await r.json(); apiCode = j.code; total = j.data?.total ?? j.data?.length ?? null;
  } catch (e) { apiCode = 'ERR:' + e.message; }
  return {
    url: location.href,
    title: document.title,
    token_len: token.length,
    set_id: s.getItem('jl_set_id'),
    menus: s.getItem('jl_menus') ? JSON.parse(s.getItem('jl_menus')).length : 0,
    menu_nodes: document.querySelectorAll('.el-menu-item, [class*=menu-item]').length,
    api_code: apiCode,
    voucher_total: total,
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 520),
  };
})()`;

const state = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
const value = state.result?.result?.value ?? state.result?.error ?? state.error;
console.log('=== 桌面窗口状态 ===');
console.log(JSON.stringify(value, null, 2));

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (shot.result?.data) {
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('截图:', OUT, fs.statSync(OUT).size, 'bytes');
}

const ok = value && value.url?.includes('/dashboard') && value.token_len > 0 && value.api_code === 0;
console.log(ok ? 'DESKTOP_VERIFY=PASS' : 'DESKTOP_VERIFY=FAIL');
ws.close();
process.exit(ok ? 0 : 1);
