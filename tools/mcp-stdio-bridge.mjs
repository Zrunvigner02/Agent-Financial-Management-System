/**
 * 振颜丽舍 · MCP stdio 桥（零依赖兜底方案）
 *
 * 有些 MCP 客户端对纯 HTTP POST 的 streamableHttp 支持不全；本桥把 stdio 上的
 * 换行分隔 JSON-RPC 逐条转发到本地后端 POST /mcp，再把响应写回 stdout。
 * 不需要 npx、不需要联网、不需要额外进程，仅使用 Node 内置 fetch。
 *
 * 环境变量：
 *   ZD_MCP_URL  默认 http://127.0.0.1:8000/mcp
 *   ZD_TOKEN    开放接口令牌（软件「设置 → 开放接口」里生成）
 */
const URL = process.env.ZD_MCP_URL || 'http://127.0.0.1:8000/mcp';
const TOKEN = process.env.ZD_TOKEN || '';

let buf = '';
let inflight = 0;
let ended = false;
process.stdin.setEncoding('utf8');

function reply(obj) {
  process.stdout.write(JSON.stringify(obj).replace(/\n/g, '') + '\n');
}

function forward(msg) {
  inflight += 1;
  const done = () => { inflight -= 1; if (ended && inflight === 0) process.exit(0); };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  fetch(URL, { method: 'POST', headers, body: JSON.stringify(msg) })
    .then(async (r) => {
      const text = await r.text();
      // 上游若返回 SSE 帧，取其中的 data: JSON
      let body = text;
      const dataLine = text.split(/\r?\n/).find((l) => l.startsWith('data:'));
      if (dataLine) body = dataLine.slice(5).trim();
      try { reply(JSON.parse(body)); }
      catch { reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { content: [{ type: 'text', text: body }] } }); }
      done();
    })
    .catch((e) => {
      reply({
        jsonrpc: '2.0', id: msg.id ?? null,
        error: { code: -32000, message: `连接振颜丽舍本地服务失败：${e.message}（请确认桌面端已启动、令牌有效）` },
      });
      done();
    });
}

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg && msg.id !== undefined) forward(msg);   // 通知类消息无需响应
  }
});

process.stdin.on('end', () => { ended = true; if (inflight === 0) process.exit(0); });
