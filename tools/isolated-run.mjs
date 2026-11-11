/**
 * 隔离测试运行器 —— 根治「跑一次测试就往用户真实账套写一张凭证」
 *
 * 做法：把项目必要文件逐文件复制到系统临时目录，让测试脚本在副本里运行
 *      （脚本自启的 backend/index.mjs 会指向副本的 DB），跑完删除副本。
 *      运行前后各对生产库做一次独立核验，比对数据快照；任何意外变动都判失败。
 *
 * 用法：
 *   node tools/isolated-run.mjs --scripts .local/test-export.mjs,.local/test-stage8.mjs
 *   node tools/isolated-run.mjs --with-backend --scripts tools/local-smoke.mjs,tools/verify-dashboard.mjs
 *   node tools/isolated-run.mjs            # 默认跑全部 8001 系列
 *
 * 注意：本机 Node 22 在中文路径下 fs.cpSync 会触发 native 段错误，必须逐文件复制。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, runAudit } from '../backend/data-audit.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const WITH_BACKEND = argv.includes('--with-backend');
const KEEP = argv.includes('--keep');
const PORT = 8001;
const PROD_DB = path.join(ROOT, 'backend', 'data', 'jinli.db');
const DEFAULT_SCRIPTS = [
  '.local/test-export.mjs', '.local/test-stage8.mjs', '.local/test-stage9.mjs',
  '.local/test-stage10.mjs', '.local/test-agent-sse.mjs', '.local/test-clarify-v2.mjs',
];
const SCRIPTS = opt('--scripts', DEFAULT_SCRIPTS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

function snapshot() {
  const d = new DatabaseSync(PROD_DB);
  d.exec('PRAGMA query_only = ON');
  try { return runAudit(d, { setId: 85 }).snapshot; } finally { d.close(); }
}

function copyTree(src, dst, opts = {}) {
  const { dirs = null, files = null } = opts;
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), t = path.join(dst, e.name);
    if (e.isDirectory()) {
      if (dirs && !dirs.includes(e.name)) continue;
      copyTree(s, t, { dirs: null, files });
    } else if (!files || files(e.name)) {
      fs.copyFileSync(s, t);
    }
  }
}

function waitHealth(url, ms = 20000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(1200) });
        if (r.ok) return resolve(true);
      } catch { /* 还没起来 */ }
      if (Date.now() > deadline) return reject(new Error('隔离后端启动超时'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function runScript(TMP, rel, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [rel], { cwd: TMP, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); out += '\n[TIMEOUT 300s]'; }, 300000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e) }); });
  });
}

const before = snapshot();
console.log(`[隔离运行] 生产库快照已采集 hash=${JSON.stringify(before).length}B，目标目录 ${os.tmpdir()}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-iso-'));
let backend = null;
let failed = 0;
const results = [];

try {
  // 1. 逐文件复制（不用 fs.cpSync：中文路径下会 native 崩溃）
  copyTree(path.join(ROOT, 'backend'), path.join(TMP, 'backend'), {
    dirs: ['seed', 'data'], files: (n) => /\.(mjs|json|db)$/.test(n),
  });
  // tools 需带 render_image.py（格式转换桥依赖），不能只复制 .mjs
  copyTree(path.join(ROOT, 'tools'), path.join(TMP, 'tools'), { files: () => true });
  // .local 里的 .txt 是管理员初始密码等凭据，历史脚本会读；跳过 png/xlsx 等大产物
  copyTree(path.join(ROOT, '.local'), path.join(TMP, '.local'),
    { files: (n) => /\.(mjs|json|txt|log|csv|md|sse)$/.test(n) });
  copyTree(path.join(ROOT, 'upstream'), path.join(TMP, 'upstream'), { dirs: ['assets'] });
  for (const f of ['package.json', '.env', '.env.example', 'server.mjs']) {
    const s = path.join(ROOT, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(TMP, f));
  }
  for (const d of ['analysis', 'logs']) fs.mkdirSync(path.join(TMP, d), { recursive: true });
  console.log(`[隔离运行] 副本就绪：${TMP}`);

  const env = { ...process.env, ZD_ISOLATED: '1' };
  // 2. 需要外部服务的脚本由运行器统一提供隔离后端
  if (WITH_BACKEND) {
    backend = spawn(process.execPath, ['backend/index.mjs'], {
      cwd: TMP,
      env: { ...env, LOCAL_BACKEND_PORT: String(PORT), LOCAL_BACKEND_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let blog = '';
    backend.stdout.on('data', (d) => { blog += d.toString(); });
    backend.stderr.on('data', (d) => { blog += d.toString(); });
    await waitHealth(`http://127.0.0.1:${PORT}/__local/health`);
    env.LOCAL_BASE = `http://127.0.0.1:${PORT}`;
    env.VERIFY_BASE = `http://127.0.0.1:${PORT}`;
    console.log(`[隔离运行] 隔离后端已启动于 ${PORT}`);
  }

  // 3. 串行执行（历史脚本都硬编码 8001，并发会互相抢占）
  for (const rel of SCRIPTS) {
    if (!fs.existsSync(path.join(TMP, rel))) {
      console.log(`SKIP ${rel} — 副本中不存在`);
      results.push({ rel, code: -2, tail: '文件不存在' });
      failed++;
      continue;
    }
    const r = await runScript(TMP, rel, env);
    const lines = r.out.trim().split('\n');
    const tail = lines.filter((l) => /^(FAIL|RESULT|PASS \/|=== |DATA_AUDIT|\d+\/\d+ passed)/.test(l)).slice(-6).join(' | ');
    const failLines = r.out.split('\n').filter((l) => l.startsWith('FAIL')).length;
    const ok = r.code === 0 && failLines === 0;
    if (!ok) failed++;
    results.push({ rel, code: r.code, failLines, tail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${rel} rc=${r.code} fail=${failLines}${tail ? ` — ${tail.slice(0, 220)}` : ''}`);
  }
} catch (e) {
  console.error('[隔离运行] 异常：', e.message);
  failed++;
} finally {
  if (backend) { try { backend.kill('SIGKILL'); } catch { /* 已退出 */ } }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  else console.log(`[隔离运行] 保留副本：${TMP}`);
}

// 4. 生产库变动核验：counts / 指标 / 账套名 / 科目数逐字段比对
const after = snapshot();
const changes = [];
for (const t of Object.keys(before.counts || {})) {
  if ((after.counts?.[t] ?? -1) !== before.counts[t]) changes.push(`${t}: ${before.counts[t]} -> ${after.counts?.[t]}`);
}
for (const k of Object.keys(before.metrics || {})) {
  if (Math.abs((after.metrics?.[k] ?? 0) - before.metrics[k]) > 0.005) changes.push(`${k}: ${before.metrics[k]} -> ${after.metrics?.[k]}`);
}
if (JSON.stringify(before.setNames) !== JSON.stringify(after.setNames)) changes.push('账套名称发生变动');
if (before.subjectCount !== after.subjectCount) changes.push(`科目数 ${before.subjectCount} -> ${after.subjectCount}`);
if (changes.length) failed++;

console.log('\n=== 隔离运行汇总 ===');
for (const r of results) console.log(`  ${r.code === 0 && r.failLines === 0 ? 'PASS' : 'FAIL'} ${r.rel}`);
console.log(`${changes.length ? 'FAIL' : 'PASS'} 生产账套零变动 — ${changes.length ? changes.join('; ') : '测试前后快照完全一致'}`);
console.log(`ISOLATED_RUN ${failed === 0 ? 'OK' : 'FAILED'} (${results.length} 脚本, ${failed} 失败)`);
process.exit(failed === 0 ? 0 : 1);
