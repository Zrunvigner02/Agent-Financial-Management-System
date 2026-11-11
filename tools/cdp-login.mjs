import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, '.local');
const useLocal = process.env.CDP_USE_LOCAL === '1' || process.argv.includes('--local');
const login = JSON.parse(fs.readFileSync(path.join(LOCAL, useLocal ? 'local-login.json' : 'login.json'), 'utf8')).data;
const openToken = JSON.parse(fs.readFileSync(path.join(LOCAL, useLocal ? 'local-open-token.json' : 'open-token.json'), 'utf8'));
console.log('mode:', useLocal ? 'LOCAL (127.0.0.1:8000)' : 'UPSTREAM (jinliaicaiwu.top)');

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:5173'));
if (!page) throw new Error('no local page target on CDP');

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
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const values = {
  jl_token: login.token,
  jl_username: String(login.username || ''),
  jl_name: String(login.name || ''),
  jl_role: String(login.role || ''),
  jl_menus: JSON.stringify(login.menus || []),
  jl_set_id: String(openToken.set_id || ''),
  jl_set_name: '',
};
const expression = `(() => { const s = sessionStorage; ${Object.entries(values)
  .map(([k, v]) => `s.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
  .join(' ')} return { token: (s.getItem('jl_token') || '').length, set: s.getItem('jl_set_id') }; })()`;

const injected = await send('Runtime.evaluate', { expression, returnByValue: true });
console.log('injected:', JSON.stringify(injected.result?.result?.value ?? injected.error));

await send('Page.navigate', { url: 'http://127.0.0.1:5173/dashboard' });
await new Promise((r) => setTimeout(r, 3500));
const state = await send('Runtime.evaluate', {
  expression: `(async () => {
    const t = sessionStorage.getItem('jl_token');
    const r = await fetch('/api/vouchers?period=2026-11', {
      headers: { Authorization: 'Bearer ' + t, 'X-Set-Id': sessionStorage.getItem('jl_set_id') },
    });
    const j = await r.json();
    return {
      url: location.href,
      title: document.title,
      scripts: document.scripts.length,
      voucher_total: j.data?.total,
      body: document.body.innerText.slice(0, 420),
    };
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log('page:', JSON.stringify(state.result?.result?.value ?? state.error));
ws.close();
