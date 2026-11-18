/**
 * 企微缓存「断网重连自动补同步」——内嵌在后端进程里运行（v2.2.0）。
 *
 * 为什么放后端：外挂守护进程会被会话回收，只有后端是用户全程开着的长驻进程。
 * 后端活着 → 探测网络 → 断网后恢复就自动补同步，全程无需人工干预。
 *
 * 与 tools/wecom-watch.mjs 共用 .local/wecom-watch.pid 单实例锁：
 * 谁先起来谁干活，另一个自己退出，避免重复同步。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncWecom, verifyWecom } from './wecom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(ROOT, 'logs', 'wecom-watch.log');
const PID_FILE = path.join(ROOT, '.local', 'wecom-watch.pid');

// 本机实测：223.5.5.5:53 不通，这三个可达；任一通即视为在线
const PROBES = [
  ['114.114.114.114', 53],
  ['www.qq.com', 443],
  ['api.deepseek.com', 443],
];

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = `[${stamp()}] [backend-watch] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* 日志失败不影响主流程 */ }
}

function probe(host, port, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    let sock;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock && sock.destroy(); } catch { /* 忽略 */ }
      resolve(v);
    };
    try { sock = net.connect({ host, port }); } catch { return done(false); }
    sock.setTimeout(timeout, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

export async function isOnline(timeout = 3000) {
  for (const [host, port] of PROBES) {
    if (await probe(host, port, timeout)) return true;
  }
  return false;
}

/** 单实例锁：返回 true 表示本进程拿到锁 */
function acquireLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const old = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
      if (old && old !== process.pid) {
        try { process.kill(old, 0); return false; } catch { /* 已退出，可接管 */ }
      }
    }
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
    return true;
  } catch { return true; }
}

/**
 * 启动守护。返回值可 stop()。
 * @param {{ setId?: number, intervalMs?: number, settleMs?: number, secondMs?: number }} opts
 */
export function startWecomWatch(opts = {}) {
  const setId = Number(opts.setId) || 85;
  const intervalMs = Math.max(5000, Number(opts.intervalMs) || 20000);
  const settleMs = opts.settleMs ?? 30000;
  const secondMs = opts.secondMs ?? 240000;

  if (!acquireLock()) {
    log('已有守护进程在运行，本进程不重复启动');
    return { stop() {} };
  }

  let last = null;
  let offlineAt = 0;
  let busy = false;
  let stopped = false;

  async function runSync(tag) {
    if (busy) { log(`上一轮同步未结束，跳过本次（${tag}）`); return; }
    busy = true;
    try {
      const r = syncWecom(setId, { apply: true, actor: `backend:${tag}` });
      if (r.code !== 0) { log(`✗ 同步失败（${tag}）：${r.message}`); return; }
      const d = r.data;
      log(`✓ 同步完成（${tag}）：日报 ${d.accepted} 份 / 新增 ${d.rows.new} / 修正 ${d.rows.updated}`
        + ` / 未变 ${d.rows.same}`
        + (d.duplicates ? ` / 判重 ${d.duplicates}` : '')
        + (d.reconcile?.review?.length ? ` / 待复核 ${d.reconcile.review.length}` : ''));
      try {
        const v = verifyWecom(setId);
        if (v.code === 0 && v.data.problems.length) log(`  核对提示：${v.data.problems.join('；')}`);
      } catch { /* 核对失败不影响同步 */ }
    } catch (e) {
      log(`✗ 同步异常（${tag}）：${e.message}`);
    } finally {
      busy = false;
    }
  }

  async function catchUp(reason) {
    log(`开始补同步（${reason}）`);
    if (settleMs) await sleep(settleMs);
    await runSync(reason);
    if (secondMs) {
      await sleep(secondMs);
      await runSync(`${reason}+2`);
    }
  }

  const timer = setInterval(async () => {
    if (stopped) return;
    const on = await isOnline();
    if (last === null) {
      last = on;
      log(`网络初检：${on ? '在线' : '离线'}`);
      if (on) catchUp('启动');
      else offlineAt = Date.now();
      return;
    }
    if (!last && on) {
      const mins = offlineAt ? ((Date.now() - offlineAt) / 60000).toFixed(1) : '?';
      log(`网络恢复（断网约 ${mins} 分钟）`);
      last = on;
      offlineAt = 0;
      catchUp('网络恢复');
      return;
    }
    if (last && !on) {
      offlineAt = Date.now();
      last = on;
      log('网络断开，暂停同步，等恢复');
    }
  }, intervalMs);
  timer.unref?.();

  log(`守护已启动：探测 ${intervalMs / 1000}s，重连后等 ${settleMs / 1000}s 同步，${secondMs / 1000}s 后二次补同步`);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      try {
        if (fs.existsSync(PID_FILE) && Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE);
      } catch { /* 忽略 */ }
    },
  };
}
