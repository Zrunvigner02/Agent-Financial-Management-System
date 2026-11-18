import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(ROOT, 'upstream');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const UPSTREAM = process.env.UPSTREAM_ORIGIN || 'https://jinliaicaiwu.top';
// 手动 `node server.mjs` 启动时没有 Electron 传来的环境变量，必须回退读 .env，
// 否则 /api/* 会被代理到线上域名，本地令牌 401、页面被踢回登录页。
const LOCAL_API = process.env.LOCAL_API_ORIGIN || envValue('LOCAL_API_ORIGIN');

// .env 热读取：更换 OpenToken 无需重启服务
function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
      .split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : '';
  } catch {
    return '';
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const mime = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

const isProxied = (p) => p.startsWith('/api/') || p === '/mcp' || p.startsWith('/mcp/');

function proxy(req, res, u) {
  let target;
  try {
    target = new URL(LOCAL_API || UPSTREAM);
  } catch {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"code":500,"message":"invalid upstream origin"}');
    return;
  }

  const headers = { ...req.headers, host: target.host };
  // WorkBuddy 对接预留：本地 /mcp 免填鉴权，由环境变量注入 OpenToken
  if (u.pathname.startsWith('/mcp') && !headers.authorization) {
    const wbToken = envValue('WB_MCP_TOKEN');
    if (wbToken) headers.authorization = `Bearer ${wbToken}`;
  }

  const transport = target.protocol === 'https:' ? https : http;
  const upstreamReq = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: req.method,
      headers,
      timeout: 120000,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res); // 保持 SSE / 流式响应
    },
  );

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
  upstreamReq.on('error', (e) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 502, message: `upstream: ${e.message}` }));
  });
  req.pipe(upstreamReq);
}

function serveStatic(req, res, u) {
  let pathname;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  let file = path.resolve(STATIC, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(STATIC + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    file = path.join(STATIC, 'index.html'); // SPA fallback
  }
  const isEntry = /\.(html|js)$/i.test(file);
  res.writeHead(200, {
    'content-type': mime(file),
    // 入口 HTML / 注入脚本绝不缓存：否则旧页面会只显示追问文字却看不到可点选项
    'cache-control': isEntry ? 'no-store, must-revalidate' : 'no-cache',
    'pragma': isEntry ? 'no-cache' : '',
    'x-accel-buffering': 'no',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  if (u.pathname === '/__local/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      static: fs.existsSync(path.join(STATIC, 'index.html')),
      upstream: LOCAL_API || UPSTREAM,
      local_backend: Boolean(LOCAL_API),
      workbuddy_mcp: '/mcp proxied',
      llm_configured: Boolean(envValue('DEEPSEEK_API_KEY')),
      token_injected: Boolean(envValue('WB_MCP_TOKEN')),
    }));
    return;
  }

  // 本地自动登录：读取 .local/local-admin.txt 的账号密码，向本地后端换取会话，
  // 供前端在无 localStorage 登录态时静默写入，实现打开即用、免手动输入账号密码。
  if (u.pathname === '/__local/auto-login' && req.method === 'POST') {
    let username = '', password = '';
    try {
      const txt = fs.readFileSync(path.join(ROOT, '.local/local-admin.txt'), 'utf8');
      for (const line of txt.split(/\r?\n/)) {
        if (line.startsWith('username=')) username = line.slice('username='.length).trim();
        if (line.startsWith('password=')) password = line.slice('password='.length).trim();
      }
    } catch { /* 无凭据文件则忽略 */ }
    const origin = LOCAL_API || `http://127.0.0.1:8000`;
    if (!username || !password || !origin) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 1, message: 'no local credentials' }));
      return;
    }
    const body = JSON.stringify({ username, password });
    const lr = http.request(origin + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (up) => {
      let buf = '';
      up.on('data', (c) => { buf += c; });
      up.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(buf || JSON.stringify({ code: 1, message: 'empty login response' }));
      });
    });
    lr.on('error', (e) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 1, message: e.message }));
    });
    lr.end(body);
    return;
  }

  // 改密成功后同步本地自动登录凭据，避免下次打开页面仍用旧密码登录失败。
  if (u.pathname === '/__local/sync-credentials' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let password = '';
      try { password = (JSON.parse(raw || '{}').password || '').toString(); } catch { /* ignore */ }
      const result = { code: 0, updated: [] };
      if (password) {
        // 更新 .local/local-admin.txt（保留 username 行）
        try {
          const p = path.join(ROOT, '.local/local-admin.txt');
          let user = 'admin';
          for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
            if (line.startsWith('username=')) user = line.slice('username='.length).trim();
          }
          fs.writeFileSync(p, `username=${user}\npassword=${password}\n`, 'utf8');
          result.updated.push('local-admin.txt');
        } catch (e) { result.code = 1; result.message = e.message; }
        // 更新 .local/desktop-credentials.json（Electron 桌面壳用）
        try {
          const p = path.join(ROOT, '.local/desktop-credentials.json');
          const cred = JSON.parse(fs.readFileSync(p, 'utf8'));
          cred.password = password;
          fs.writeFileSync(p, JSON.stringify(cred, null, 2), 'utf8');
          result.updated.push('desktop-credentials.json');
        } catch { /* 桌面凭据文件可不存在，忽略 */ }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (isProxied(u.pathname)) return proxy(req, res, u);
  serveStatic(req, res, u);
});

server.listen(PORT, HOST, () => {
  console.log(`[jinli-local] http://${HOST}:${PORT}  static=${STATIC}  api-> ${LOCAL_API || UPSTREAM}`);
});
