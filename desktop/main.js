'use strict';
/**
 * 妆点管账 · 本地离线版 —— Electron 桌面壳
 * 职责：静默拉起 8000 后端 + 5173 前端、免登录注入本地会话、托盘常驻、退出清理。
 * 约束：不弹任何终端窗口；不把凭据写进日志；服务若已在运行则复用而非抢占端口。
 */
const {
  app, BrowserWindow, Tray, Menu, session, shell, ipcMain, nativeImage,
} = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DESK = __dirname;
const ROOT = path.resolve(DESK, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOCAL_DIR = path.join(ROOT, '.local');
const ICON = path.join(DESK, 'icon.ico');
const NODE_EXE = path.join(DESK, 'runtime', 'node.exe');
const BACK_PORT = 8000;
const FRONT_PORT = 5173;
const BACKEND = `http://127.0.0.1:${BACK_PORT}`;
const ORIGIN = `http://127.0.0.1:${FRONT_PORT}`;

let win = null;
let tray = null;
let quitting = false;
let booting = false;
let recovering = false;   // 后端自愈守护的重入保护
let auth = null;         // 登录态（仅内存）
let setId = '';
let headerHookInstalled = false;
const owned = [];        // 本进程亲自拉起的服务；退出时只清理这些

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `desktop-${stamp()}.log`), line);
  } catch { /* 日志失败不影响启动 */ }
}

// ---------- 基础工具 ----------
function loadEnv() {
  const env = { ...process.env };
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* .env 缺失时由各服务自行兜底 */ }
  return env;
}

function probe(port, pathname, timeout = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout }, (res) => {
      res.resume();
      res.on('end', () => done(res.statusCode === 200));
    });
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(port, pathname, maxMs = 30000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await probe(port, pathname)) return true;
    await sleep(350);
  }
  return false;
}

function setStatus(text, percent, isError = false) {
  if (!win || win.isDestroyed()) return;
  const js = `window.__setStatus && window.__setStatus(${JSON.stringify(String(text))},`
    + `${percent == null ? 'null' : Number(percent)}, ${isError ? 'true' : 'false'})`;
  win.webContents.executeJavaScript(js).catch(() => {});
}

// ---------- 服务生命周期 ----------
async function ensureService(name, port, script, healthPath) {
  if (await probe(port, healthPath)) {
    log(`${name} :${port} 已在运行 -> 复用`);
    return 'reused';
  }
  if (!fs.existsSync(NODE_EXE)) {
    throw new Error(`内置 Node 运行时缺失：${NODE_EXE}`);
  }
  log(`启动 ${name} :${port} (${script})`);
  const child = spawn(NODE_EXE, [path.join(ROOT, script)], {
    cwd: ROOT,
    env: loadEnv(),
    windowsHide: true,          // 关键：不弹控制台黑框
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pipe = (stream, tag) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += String(chunk);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const l of lines.slice(-3)) if (l.trim()) log(`  [${tag}] ${l.trim().slice(0, 300)}`);
    });
  };
  pipe(child.stdout, name);
  pipe(child.stderr, name);
  child.on('exit', (code) => log(`${name} 进程退出 code=${code}`));
  child.on('error', (e) => log(`${name} spawn 失败: ${e.message}`));
  owned.push(child);

  if (!await waitHealthy(port, healthPath)) {
    throw new Error(`${name} 启动超时（端口 ${port} 未响应健康检查）`);
  }
  log(`${name} :${port} 健康检查通过`);
  return 'started';
}

function stopOwned() {
  for (const c of owned.splice(0)) {
    try {
      if (!c.killed && c.exitCode == null) c.kill();
      log(`已停止本次启动的服务 pid=${c.pid}`);
    } catch (e) {
      log(`停止服务失败 pid=${c.pid}: ${e.message}`);
    }
  }
}

// ---------- 免登录 ----------
async function desktopLogin() {
  const credFile = path.join(LOCAL_DIR, 'desktop-credentials.json');
  if (!fs.existsSync(credFile)) throw new Error('缺少 .local/desktop-credentials.json');
  const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  const r = await fetch(`${BACKEND}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: cred.username, password: cred.password }),
  });
  const j = await r.json();
  if (!j?.data?.token) throw new Error(`本地登录失败：${j?.message || 'code=' + j?.code}`);
  log(`本地账号登录成功 user=${cred.username} role=${j.data.role || '-'} menus=${(j.data.menus || []).length}`);
  return j.data;
}

async function resolveSetId(token) {
  try {
    const r = await fetch(`${BACKEND}/api/sets/enabled`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    const d = j?.data;
    const first = Array.isArray(d) ? d[0] : (d?.sets || d?.list || [])[0];
    if (first?.id) return String(first.id);
  } catch (e) {
    log(`账套接口回退: ${e.message}`);
  }
  try {
    const t = JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, 'local-open-token.json'), 'utf8'));
    if (t?.set_id) return String(t.set_id);
  } catch { /* ignore */ }
  return '85';
}

function sessionInjection(data, sid) {
  const values = {
    jl_token: String(data.token || ''),
    jl_username: String(data.username || ''),
    jl_name: String(data.name || ''),
    jl_role: String(data.role || ''),
    jl_menus: JSON.stringify(data.menus || []),
    jl_set_id: String(sid),
    jl_set_name: '',
  };
  return `(() => { const s = sessionStorage; ${Object.entries(values)
    .map(([k, v]) => `s.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join(' ')} return (s.getItem('jl_token') || '').length; })()`;
}

function installHeaderHook() {
  if (headerHookInstalled || !auth) return;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = details.requestHeaders || {};
    if (details.url.startsWith(`${ORIGIN}/api/`)) {
      const hasAuth = Object.keys(h).some((k) => k.toLowerCase() === 'authorization');
      const hasSet = Object.keys(h).some((k) => k.toLowerCase() === 'x-set-id');
      if (!hasAuth) h.Authorization = `Bearer ${auth.token}`;
      if (!hasSet) h['X-Set-Id'] = setId;
    }
    callback({ requestHeaders: h });
  });
  headerHookInstalled = true;
  log('API 请求头兜底注入已启用');
}

// ---------- 窗口 / 托盘 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    title: '妆点管账 · 本地版',
    icon: ICON,
    backgroundColor: '#742a54',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(DESK, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();                       // 关窗口 = 收进托盘，服务继续，重开秒进
    try {
      tray?.displayBalloon({
        title: '妆点管账',
        content: '已最小化到托盘，双击图标可重新打开；右键可完全退出',
      });
    } catch { /* 部分系统不支持气泡 */ }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('render-process-gone', () => log('渲染进程异常退出'));
}

function buildTray() {
  const image = nativeImage.createFromPath(ICON);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('妆点管账 · 本地离线版');
  const refreshMenu = () => {
    const settings = app.getLoginItemSettings();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开妆点管账', click: () => { win?.show(); win?.focus(); } },
      { label: '重新加载页面', click: () => win?.reload() },
      { label: '报表导出中心', click: () => { win?.show(); win?.focus(); win?.loadURL(`${ORIGIN}/export.html`); } },
      { type: 'separator' },
      { label: '重启本地服务', click: () => restartServices() },
      { label: '打开桌面端日志', click: () => shell.openPath(path.join(LOG_DIR, `desktop-${stamp()}.log`)) },
      { label: '打开应用目录', click: () => shell.openPath(ROOT) },
      { type: 'separator' },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: !!settings.openAtLogin,
        click: (item) => {
          // 开机自启也走无终端启动器，保证环境变量被清理
          const pyw = 'D:\\tools\\Python311\\pythonw.exe';
          const useLauncher = fs.existsSync(pyw);
          app.setLoginItemSettings({
            openAtLogin: item.checked,
            path: useLauncher ? pyw : process.execPath,
            args: useLauncher ? [path.join(DESK, 'launcher.pyw')] : [DESK],
          });
        },
      },
      { label: '退出并停止服务', click: () => { quitting = true; stopOwned(); app.quit(); } },
    ]));
  };
  refreshMenu();
  tray.on('click', () => { win?.show(); win?.focus(); });
  tray.on('double-click', () => { win?.show(); win?.focus(); });
  tray.on('right-click', refreshMenu);
}

async function restartServices() {
  log('托盘请求重启服务');
  stopOwned();
  await sleep(800);
  await bootFlow('重启');
}

// ---------- 主流程 ----------
async function bootFlow(tag = '启动') {
  if (booting) return;
  booting = true;
  try {
    setStatus(`${tag}：正在启动本地数据库服务…`, 18);
    const b = await ensureService('后端', BACK_PORT, path.join('backend', 'index.mjs'), '/__local/health');
    setStatus(`${tag}：正在启动本地页面服务…`, 42);
    const f = await ensureService('前端', FRONT_PORT, 'server.mjs', '/__local/health');
    setStatus(`${tag}：正在准备本地账套…`, 66);
    auth = await desktopLogin();
    setId = await resolveSetId(auth.token);
    installHeaderHook();
    setStatus(`${tag}：正在进入数据看板…`, 86);

    // 先在 http 源下建立页面上下文，注入会话，再进入受路由守卫保护的业务页
    win.hide();
    await win.loadURL(`${ORIGIN}/`);
    const n = await win.webContents.executeJavaScript(sessionInjection(auth, setId));
    if (!n) throw new Error('会话注入失败（sessionStorage 不可写）');
    await win.loadURL(`${ORIGIN}/dashboard`);
    setStatus('就绪', 100);
    win.show();
    win.focus();
    log(`boot ok: backend=${b} frontend=${f} set=${setId} tokenLen=${String(auth.token).length}`);
  } catch (err) {
    log(`BOOT ERROR: ${err && err.stack ? err.stack : err}`);
    setStatus(`启动失败：${err?.message || err}`, 100, true);
    win.show();
  } finally {
    booting = false;
  }
}

// ---------- 应用入口 ----------
// 仅供排障：设置 JINLI_DESKTOP_DEBUG=9333 时才开启 CDP，正式双击不会监听端口
if (process.env.JINLI_DESKTOP_DEBUG) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.JINLI_DESKTOP_DEBUG);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
  app.on('before-quit', () => { quitting = true; stopOwned(); });
  app.on('window-all-closed', (e) => { /* 托盘常驻，忽略默认退出 */ });
  ipcMain.on('desktop:retry', () => { log('用户点击重试'); bootFlow('重试'); });
  ipcMain.on('desktop:quit', () => { quitting = true; stopOwned(); app.quit(); });

  app.whenReady().then(async () => {
    log('===== 桌面端启动 =====');
    createWindow();
    buildTray();
    await win.loadFile(path.join(DESK, 'splash.html'));
    win.show();
    await bootFlow();

    // 后端健康自愈：AI 会话 job 回收、手工 kill、外部重启工具等都可能让 8000 失联，
    // 而 5173 仍活着 → 页面能开但接口全 502。每 20 秒探测一次，失联就由 Electron
    // 自己重新拉起后端并纳入 owned 列表（下次「退出并停止服务」会一并停止）。
    // 这样即使外部托管的后端被回收，应用也能自动恢复到完全自管理的状态。
    setInterval(async () => {
      if (quitting || booting || recovering) return;
      if (await probe(BACK_PORT, '/__local/health')) return;
      recovering = true;
      try {
        log(`后端守护：:${BACK_PORT} 失联，自动拉起`);
        await ensureService('后端守护', BACK_PORT, path.join('backend', 'index.mjs'), '/__local/health');
      } catch (e) {
        log(`后端守护拉起失败：${e.message}`);
      } finally {
        recovering = false;
      }
    }, 20000);
  });
}
