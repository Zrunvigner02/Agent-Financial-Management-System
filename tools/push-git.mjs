#!/usr/bin/env node
/**
 * 直连推送（绕过系统代理，规避代理破坏 git pack 流的问题）
 *
 * 用法：
 *   node tools/push-git.mjs            # 推当前分支到 origin main
 *   node tools/push-git.mjs --check    # 只校验令牌写权限，不推送
 *
 * 令牌来源：环境变量 GITHUB_TOKEN，或 .local/gh_token.txt（已被 .gitignore 排除）
 * 说明：本机代理 127.0.0.1:51092 对 api.github.com 可用、对 git pack 流不稳定，
 *       github.com 直连已验证稳定，所以这里显式清空代理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'Zrunvigner02';
const REPO = 'Agent-Financial-Management-System';
const BRANCH = 'main';
const CHECK_ONLY = process.argv.includes('--check');

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const f = path.join(ROOT, '.local', 'gh_token.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
}

const TOK = token();
if (!TOK) {
  console.error('缺少令牌：设置 GITHUB_TOKEN，或写入 .local/gh_token.txt');
  process.exit(2);
}

const GIT = (args, extra = {}) => execFileSync('git', ['-C', ROOT, ...args], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  ...extra,
});
const CFG = ['-c', 'http.proxy=', '-c', 'https.proxy=', '-c', 'http.postBuffer=524288000'];
const URL = `https://x-access-token:${TOK}@github.com/${OWNER}/${REPO}.git`;

// 只读校验令牌是否有写权限：尝试创建一个空 tree 引用（不会改动数据）
function checkWritePermission() {
  const probe = JSON.stringify({ content: 'zd-permission-probe', encoding: 'utf8' });
  const tmp = path.join(ROOT, '.local', '.probe.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, probe, { mode: 0o600 });
  let out = '';
  try {
    out = execFileSync('curl', [
      '-sS', '-m', '30', '--noproxy', '*', '-X', 'POST',
      '-H', `Authorization: Bearer ${TOK}`,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'User-Agent: zd-push-check',
      '-H', 'Content-Type: application/json',
      '--data-binary', `@${tmp}`,
      `https://api.github.com/repos/${OWNER}/${REPO}/git/blobs`,
    ], { encoding: 'utf8' });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  let j = {};
  try { j = JSON.parse(out); } catch { /* ignore */ }
  if (j.sha) return { ok: true, msg: '令牌具备 contents:write' };
  if (j.status === 403 || /not accessible/i.test(j.message || '')) {
    return { ok: false, msg: `写权限不足：${j.message || '403'}` };
  }
  return { ok: false, msg: j.message || out.slice(0, 200) || '未知错误' };
}

const perm = checkWritePermission();
console.log(`权限检查：${perm.ok ? '通过' : '未通过'} —— ${perm.msg}`);
if (!perm.ok) {
  console.error('\n请在 GitHub 上把该令牌的权限改为 Contents: Read and write：');
  console.error('  https://github.com/settings/personal-access-tokens');
  console.error('  → 点开令牌 → Repository permissions → Contents → Read and write → Save');
  console.error('（编辑权限后令牌字符串不变，无需重新给我）');
  process.exit(3);
}
if (CHECK_ONLY) process.exit(0);

const head = GIT(['rev-parse', '--short', 'HEAD']).trim();
console.log(`准备推送 ${head} → origin/${BRANCH}`);
try {
  const out = GIT([...CFG, 'push', URL, `HEAD:refs/heads/${BRANCH}`]);
  console.log(out.trim() || '推送完成');
  console.log(`https://github.com/${OWNER}/${REPO}/commits/${BRANCH}`);
} catch (e) {
  console.error('推送失败：');
  console.error(String(e.stderr || e.stdout || e.message).trim().slice(0, 800));
  process.exit(1);
}
