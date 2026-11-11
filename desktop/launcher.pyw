"""妆点管账 · 无终端桌面启动器（桌面快捷方式的实际入口）。

1) 清理宿主注入的 ELECTRON_RUN_AS_NODE（否则 Electron 会被当成纯 Node 运行）
2) 优先启动 Electron 原生窗口
3) Electron 缺失时保底：静默拉起本地服务 + Chrome/Edge 应用模式窗口
全程不创建任何控制台窗口。
"""
import os
import sys
import time
import subprocess
import urllib.request
from datetime import date

DESK = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(DESK)
RUNTIME = os.path.join(DESK, 'runtime')
NODE = os.path.join(RUNTIME, 'node.exe')
ELECTRON = os.path.join(DESK, 'node_modules', 'electron', 'dist', 'electron.exe')
LOG_DIR = os.path.join(ROOT, 'logs')
CREATE_NO_WINDOW = 0x08000000
CREATE_BREAKAWAY_FROM_JOB = 0x01000000


def log(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, 'desktop-launcher-%s.log' % date.today().isoformat()),
                  'a', encoding='utf-8') as f:
            f.write('[%s] %s\n' % (time.strftime('%H:%M:%S'), msg))
    except Exception:
        pass


def clean_env():
    env = dict(os.environ)
    for key in ('ELECTRON_RUN_AS_NODE',):
        env.pop(key, None)
    envfile = os.path.join(ROOT, '.env')
    try:
        with open(envfile, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    return env


def healthy(port, timeout=0.8):
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/__local/health' % port,
                                    timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def spawn_hidden(args):
    """优先让进程脱离宿主任务作业(job)，避免宿主会话结束时把桌面应用一起回收。"""
    kw = dict(cwd=ROOT, env=clean_env(), close_fds=True,
              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
              stderr=subprocess.DEVNULL)
    try:
        return subprocess.Popen(
            args, creationflags=CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB, **kw)
    except OSError:
        # 作业不允许 breakaway（例如从资源管理器双击，本来就不在 job 里）
        return subprocess.Popen(args, creationflags=CREATE_NO_WINDOW, **kw)


def ensure_services():
    if not healthy(8000):
        spawn_hidden([NODE, os.path.join(ROOT, 'backend', 'index.mjs')])
        log('spawn backend :8000')
    if not healthy(5173):
        spawn_hidden([NODE, os.path.join(ROOT, 'server.mjs')])
        log('spawn frontend :5173')
    deadline = time.time() + 30
    while time.time() < deadline:
        if healthy(8000) and healthy(5173):
            return True
        time.sleep(0.35)
    return False


def find_browser():
    for p in (r'C:\Program Files\Google\Chrome\Application\chrome.exe',
              r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
              r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
              r'C:\Program Files\Microsoft\Edge\Application\msedge.exe'):
        if os.path.exists(p):
            return p
    return None


def fallback_browser():
    if not ensure_services():
        log('ERROR: 本地服务启动超时，保底模式放弃')
        return
    browser = find_browser()
    if not browser:
        log('ERROR: 未找到 Chrome/Edge')
        return
    profile = os.path.join(ROOT, '.local', 'desktop-chrome-profile')
    args = [browser,
            '--app=http://127.0.0.1:5173/',
            '--user-data-dir=' + profile,
            '--window-size=1500,940',
            '--no-first-run', '--no-default-browser-check',
            '--disable-features=TranslateUI']
    spawn_hidden(args)
    log('fallback: 浏览器应用窗口已打开（需手动登录一次）')


def main():
    log('launcher invoked')
    if os.path.exists(ELECTRON):
        spawn_hidden([ELECTRON, DESK])
        log('electron launched (job-breakaway attempted)')
    else:
        log('electron 缺失，进入保底模式')
        fallback_browser()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        log('FATAL: %r' % (exc,))
