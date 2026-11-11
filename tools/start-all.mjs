import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

function start(name, args, delay = 0) {
  setTimeout(() => {
    const child = spawn(process.execPath, ['--env-file=.env', ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('exit', (code) => console.log(`[${name}] exited with code ${code}`));
    children.push(child);
    console.log(`[${name}] started (pid ${child.pid})`);
  }, delay);
}

start('backend :8000', ['backend/index.mjs'], 0);
start('frontend :5173', ['server.mjs'], 1500);

const shutdown = () => {
  for (const c of children) if (!c.killed) c.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log('[jinli] 一键启动中：先 8000 后端，再 5173 前端；Ctrl+C 停止全部');
