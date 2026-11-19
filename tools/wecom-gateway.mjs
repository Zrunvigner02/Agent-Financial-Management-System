#!/usr/bin/env node
/**
 * 企业微信「自建应用」回调网关（零依赖）
 *
 * 为什么需要它：
 *   自建应用要求一个公网可访问的 HTTP(S) 回调地址，而本机后端 8000 还带着
 *   登录、凭证、报表等全部接口。直接穿透 8000 = 把整个财务系统暴露到公网。
 *   本网关只把 /api/wecom/callback 这一个路径转发给后端，其余一律 404，
 *   所以隧道指向 8001 即可，公网侧只能碰到企微回调，碰不到业务接口。
 *
 * 用法：
 *   node tools/wecom-gateway.mjs              # 默认 127.0.0.1:8001
 *   WECOM_GATEWAY_PORT=8001 node tools/wecom-gateway.mjs
 *   node tools/wecom-gateway.mjs --check      # 只做连通性自检后退出
 *
 * 环境变量：
 *   WECOM_GATEWAY_HOST   默认 127.0.0.1（不要改 0.0.0.0，网关只给本机隧道用）
 *   WECOM_GATEWAY_PORT   默认 8001
 *   LOCAL_API_ORIGIN     后端地址，默认 http://127.0.0.1:8000
 */
import http from 'node:http';
import { URL } from 'node:url';

const CALLBACK_PATH = '/api/wecom/callback';
const HEALTH_PATH = '/__gateway/health';
const MAX_BODY = 4 * 1024 * 1024; // 企微回调是 XML/JSON 小包，4MB 足够

const HOST = String(process.env.WECOM_GATEWAY_HOST || '127.0.0.1').trim();
const PORT = Number(process.env.WECOM_GATEWAY_PORT || 8001);
const TARGET = new URL(String(process.env.LOCAL_API_ORIGIN || 'http://127.0.0.1:8000').trim());

/* ---------------- 转发 ---------------- */

function forward(req, res, rawBody) {
  const headers = { ...req.headers };
  // 目标主机信息改写，避免后端按 Host 判断异常
  headers.host = TARGET.host;
  delete headers['accept-encoding'];
  if (Buffer.isBuffer(rawBody)) headers['content-length'] = String(rawBody.length);

  const up = http.request(
    {
      hostname: TARGET.hostname,
      port: TARGET.port || 80,
      path: CALLBACK_PATH + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''),
      method: req.method,
      headers,
      timeout: 8000,
    },
    (upRes) => {
      const out = { ...upRes.headers };
      delete out['content-encoding'];
      delete out['content-length'];
      delete out['transfer-encoding'];
      res.writeHead(upRes.statusCode || 502, out);
      upRes.pipe(res);
    }
  );

  up.on('timeout', () => up.destroy(new Error('backend timeout')));
  up.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`backend 不可达：${e.message}`);
    } else {
      res.end();
    }
  });

  if (Buffer.isBuffer(rawBody) && rawBody.length) up.write(rawBody);
  up.end();
}

/* ---------------- 服务 ---------------- */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  const log = (code) => {
    console.log(`[wecom-gw] ${new Date().toISOString()} ${req.method} ${pathname} ← ${req.socket.remoteAddress} → ${code} (${Date.now() - started}ms)`);
  };

  // 健康检查：只给本机隧道/自检用，不暴露业务信息
  if (pathname === HEALTH_PATH) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    log(200);
    return res.end(JSON.stringify({ ok: true, target: TARGET.origin, callback: CALLBACK_PATH }));
  }

  if (pathname !== CALLBACK_PATH) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    log(404);
    return res.end('not found');
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
    log(405);
    return res.end('method not allowed');
  }

  if (req.method === 'GET') {
    return forward(req, res, null);
  }

  // POST：先把 body 收全（企微要求验签使用原始密文，不能解析后重排）
  const chunks = [];
  let size = 0;
  try {
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        log(413);
        return res.end('payload too large');
      }
      chunks.push(c);
    }
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    log(400);
    return res.end('bad body');
  }

  const raw = Buffer.concat(chunks);
  const _end = res.end.bind(res);
  res.end = (...args) => {
    log(res.statusCode);
    return _end(...args);
  };
  forward(req, res, raw);
});

/* ---------------- 自检 ---------------- */

async function selfCheck() {
  const url = `http://${TARGET.hostname}:${TARGET.port || 80}/api/health`;
  let backend = 'down';
  try {
    const r = await fetch(url);
    backend = `up (${r.status})`;
  } catch (e) {
    backend = `down (${e.code || e.message})`;
  }
  const cfg = ['WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_SECRET', 'WECOM_TOKEN', 'WECOM_AES_KEY']
    .map((k) => `${k}=${process.env[k] ? '已填' : '空'}`);
  console.log(`后端 ${TARGET.origin}：${backend}`);
  console.log(`网关监听：http://${HOST}:${PORT}${CALLBACK_PATH}`);
  console.log(`企微配置：${cfg.join('  ')}`);
}

if (process.argv.includes('--check') || process.argv.includes('-c')) {
  await selfCheck();
  process.exit(0);
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  企业微信自建应用 · 回调网关');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  监听      http://${HOST}:${PORT}`);
  console.log(`  仅放行    ${CALLBACK_PATH}`);
  console.log(`  转发到    ${TARGET.origin}`);
  console.log('  其它路径  一律 404（业务接口不会暴露到公网）');
  console.log('  ─────────────────────────────────────────────');
  console.log('  下一步：把隧道指向本端口，然后到企微后台填');
  console.log('          https://<你的隧道域名>/api/wecom/callback');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[wecom-gw] 端口 ${PORT} 已被占用，换一个：WECOM_GATEWAY_PORT=8002 node tools/wecom-gateway.mjs`);
  } else {
    console.error(`[wecom-gw] 启动失败：${e.message}`);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[wecom-gw] 已停止');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
