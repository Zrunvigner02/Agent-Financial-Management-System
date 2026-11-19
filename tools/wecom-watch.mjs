#!/usr/bin/env node
/**
 * 企微缓存「断网重连自动补同步」守护进程。
 *
 *   node tools/wecom-watch.mjs                 # 常驻：断网→重连时自动同步
 *   node tools/wecom-watch.mjs --once          # 只检查一次，在线就跑一遍同步后退出
 *   node tools/wecom-watch.mjs --interval=15   # 探测间隔（秒，默认 20）
 *   node tools/wecom-watch.mjs --dry           # 只打印将要做什么，不写库
 *
 * 设计要点：
 *   - 断网期间企微客户端收不到消息；网络恢复后客户端会陆续把文件拉回本机缓存，
 *     所以重连后不能立刻只跑一次，要「等一下 → 同步 → 再等几分钟 → 再同步」两次才捞得全。
 *   - 同步本身是幂等的（四重防重），多跑几次不会重复入账，因此宁可多跑。
 *   - 单实例：靠 .local/wecom-watch.pid 防重复启动。
 *   - 日志：logs/wecom-watch.log（只追加，不轮转，便于事后追查）。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(ROOT, 'logs', 'wecom-watch.log');
const PID_FILE = path.join(ROOT, '.local', 'wecom-watch.pid');
const SET = 85;

const args = process.argv.slice(2);
const argVal = (n, d = '') => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const ONCE = args.includes('--once');
const DRY = args.includes('--dry');
const INTERVAL = Math.max(5, Number(argVal('interval', 20)) || 20);
const SETTLE = Math.max(0, Number(argVal('settle', 30)) || 30);   // 重连后等客户端拉文件
const SECOND = Math.max(0, Number(argVal('second', 240)) || 240); // 第二次补同步延时

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  process.stdout.write(line + '\n');
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* 日志写不了不影响主流程 */ }
}

/**
 * 探测外网是否可达：多个目标任一 TCP 通即视为在线。
 * 实测本机 223.5.5.5:53 被挡，所以不能用单一 DNS 目标。
 */
const PROBES = [
  ['114.114.114.114', 53],
  ['www.qq.com', 443],
  ['api.deepseek.com', 443],
];

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

/** 抢单实例锁 */
function acquireLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const old = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
      if (old && old !== process.pid) {
        try { process.kill(old, 0); return false; } catch { /* 进程已消失，可接管 */ }
      }
    }
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
    return true;
  } catch { return true; }
}

function releaseLock() {
  try {
    if (fs.existsSync(PID_FILE) && Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE);
  } catch { /* 忽略 */ }
}

/** 跑一次同步 + 核对 */
async function syncOnce(tag) {
  const mod = await import('file:///' + path.join(ROOT, 'backend', 'wecom.mjs').replace(/\\/g, '/'));
  const r = mod.syncWecom(SET, { apply: !DRY, actor: `watch:${tag}` });
  if (r.code !== 0) { log(`✗ 同步失败（${tag}）：${r.message}`); return false; }
  const d = r.data;
  log(`✓ 同步完成（${tag}）：日报 ${d.accepted} 份 / 新增 ${d.rows.new} 行 / 修正 ${d.rows.updated} 行 / 未变 ${d.rows.same}`
    + (d.duplicates ? ` / 判重 ${d.duplicates}` : '')
    + (d.reconcile?.review?.length ? ` / 待复核 ${d.reconcile.review.length}` : ''));
  try {
    const v = mod.verifyWecom(SET);
    if (v.code === 0 && v.data.problems.length) log(`  核对提示：${v.data.problems.join('；')}`);
  } catch { /* 核对失败不影响同步结果 */ }
  return true;
}

async function catchUp(reason) {
  log(`开始补同步（${reason}）`);
  if (SETTLE) { log(`等 ${SETTLE}s 让企微客户端把离线期间的文件拉回本地`); await sleep(SETTLE * 1000); }
  await syncOnce(reason);
  if (SECOND) {
    log(`${SECOND}s 后做第二次补同步（离线期间的文件可能还在下载）`);
    await sleep(SECOND * 1000);
    await syncOnce(`${reason}+2`);
  }
}

/** 状态机：可注入探针，便于自测断网→重连 */
export async function runLoop({ probeFn, catchUpFn, intervalMs = 20000, maxCycles = Infinity, onState = () => {} } = {}) {
  let last = null;
  let offlineAt = 0;
  let cycles = 0;
  let starts = 0;
  let reconnects = 0;
  for (;;) {
    if (cycles >= maxCycles) break;
    const on = await probeFn();
    if (last === null) {
      last = on;
      if (on) { starts += 1; await catchUpFn('启动'); } else offlineAt = Date.now();
      onState({ type: 'init', online: on });
    } else if (!last && on) {
      reconnects += 1;
      onState({ type: 'reconnect', offlineMinutes: offlineAt ? (Date.now() - offlineAt) / 60000 : null });
      await catchUpFn('网络恢复');
      offlineAt = 0;
      last = on;
    } else if (last && !on) {
      offlineAt = Date.now();
      last = on;
      onState({ type: 'offline' });
    }
    cycles += 1;
    if (cycles < maxCycles) await sleep(intervalMs);
  }
  return { starts, reconnects, cycles };
}

async function selftest() {
  const seq = [true, true, false, false, true, true, false, true];
  let i = 0;
  const calls = [];
  const r = await runLoop({
    probeFn: async () => seq[Math.min(i++, seq.length - 1)],
    catchUpFn: async (why) => { calls.push(why); },
    intervalMs: 0,
    maxCycles: seq.length,
    onState: (e) => log(`  状态：${JSON.stringify(e)}`),
  });
  const ok = r.starts === 1 && r.reconnects === 2 && calls[0] === '启动' && calls.filter((c) => c === '网络恢复').length === 2;
  log(`自测：启动补同步 ${r.starts} 次、重连补同步 ${r.reconnects} 次 → ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  if (args.includes('--selftest')) return selftest();
  if (ONCE) {
    const on = await isOnline();
    log(`连通性检查：${on ? '在线' : '离线'}；模式：${DRY ? '预演' : '实跑'}`);
    if (!on) { log('当前离线，不执行同步（等网络恢复后由守护进程补）'); return; }
    await syncOnce('once');
    return;
  }

  if (!acquireLock()) {
    log('已有守护进程在运行，本进程退出');
    return;
  }
  log(`守护启动：探测间隔 ${INTERVAL}s，重连后等 ${SETTLE}s 再同步，${SECOND}s 后二次补同步，模式 ${DRY ? '预演' : '实跑'}`);

  await runLoop({
    probeFn: () => isOnline(),
    catchUpFn: (why) => catchUp(why),
    intervalMs: INTERVAL * 1000,
    onState: (e) => {
      if (e.type === 'init') log(`初始状态：${e.online ? '在线' : '离线'}`);
      if (e.type === 'offline') log('网络断开，暂停同步，等待恢复');
      if (e.type === 'reconnect') log(`网络已恢复（断网约 ${e.offlineMinutes == null ? '?' : e.offlineMinutes.toFixed(1)} 分钟）`);
    },
  });
}

main().catch((e) => { log(`异常退出：${e.message}`); releaseLock(); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log(`收到 ${sig}，退出`); releaseLock(); process.exit(0); });
}
