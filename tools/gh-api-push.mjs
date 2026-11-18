#!/usr/bin/env node
/**
 * 通过 GitHub REST API 提交（绕过 git pack 经代理损坏的问题）
 * 用法：
 *   node tools/gh-api-push.mjs --dry          # 只比对，不写入（无需令牌）
 *   node tools/gh-api-push.mjs --push         # 需要令牌
 * 令牌来源：环境变量 GITHUB_TOKEN，或 .local/gh_token.txt
 * 说明：只在现有 main 之上快进提交；删除文件会显式列出，需 --allow-delete 才执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'Zrunvigner02';
const REPO = 'Agent-Financial-Management-System';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry') || !args.has('--push');
const ALLOW_DELETE = args.has('--allow-delete');

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const f = path.join(ROOT, '.local', 'gh_token.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
}
const TOKEN = token();

function curlJson(method, url, body) {
  const cfg = path.join(os.tmpdir(), `zd-gh-${process.pid}.cfg`);
  const lines = ['silent', 'show-error', 'location', 'max-time = 60', 'noproxy = "*"'];
  if (TOKEN) lines.push(`header = "Authorization: Bearer ${TOKEN}"`);
  lines.push('header = "User-Agent: zd-api-push"', 'header = "Accept: application/vnd.github+json"');
  fs.writeFileSync(cfg, lines.join('\n') + '\n', { mode: 0o600 });
  const argv = ['--config', cfg, '-X', method];
  const bodyFile = path.join(os.tmpdir(), `zd-gh-${process.pid}-${Date.now()}.body.json`);
  if (body !== undefined) {
    // 用文件传 body，避免命令行过长（ENAMETOOLONG）
    fs.writeFileSync(bodyFile, JSON.stringify(body), { mode: 0o600 });
    argv.push('-H', 'Content-Type: application/json', '--data-binary', `@${bodyFile}`);
  }
  argv.push(url);
  try {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const out = execFileSync('curl', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return out ? JSON.parse(out) : {};
      } catch (e) {
        lastErr = e;
        const msg = String(e.stderr || e.message || '');
        // 5xx / 隧道失败 才重试，4xx（鉴权/参数）直接抛
        if (/CONNECT tunnel|\(5\d\d\)|Empty reply|timed out|Recv failure|SSL/i.test(msg)) {
          execFileSync('node', ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${800 * (attempt + 1)})`]);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  } finally {
    try { fs.unlinkSync(cfg); } catch { /* ignore */ }
    try { fs.unlinkSync(bodyFile); } catch { /* ignore */ }
  }
}

function gitLsFiles() {
  const raw = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw.split('\0').filter(Boolean);
}
function blobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

async function main() {
  const ref = curlJson('GET', `${API}/git/ref/heads/${BRANCH}`);
  const headSha = ref.object.sha;
  const commit = curlJson('GET', `${API}/git/commits/${headSha}`);
  const baseTree = commit.tree.sha;
  const remoteTree = curlJson('GET', `${API}/git/trees/${baseTree}?recursive=1`);
  const remote = new Map();
  for (const e of remoteTree.tree || []) if (e.type === 'blob') remote.set(e.path, { sha: e.sha, mode: e.mode });

  const files = gitLsFiles();
  const local = new Map();
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    const buf = fs.readFileSync(abs);
    const mode = (st.mode & 0o111) ? '100755' : '100644';
    local.set(rel.split(path.sep).join('/'), { sha: blobSha(buf), mode, buf });
  }

  const added = [], changed = [], same = [];
  for (const [p, v] of local) {
    const r = remote.get(p);
    if (!r) added.push(p);
    else if (r.sha !== v.sha) changed.push(p);
    else same.push(p);
  }
  const deleted = [];
  for (const p of remote.keys()) if (!local.has(p)) deleted.push(p);

  console.log(`远端 head: ${headSha}`);
  console.log(`文件：本地 ${local.size} / 远端 ${remote.size}`);
  console.log(`新增 ${added.length}，修改 ${changed.length}，未变 ${same.length}，远端有而本地无 ${deleted.length}`);
  if (deleted.length) console.log('将删除（需 --allow-delete）：', deleted.slice(0, 30).join(', '), deleted.length > 30 ? '…' : '');
  if (DRY) { console.log('DRY 模式，不写入。'); return; }
  if (!TOKEN) { console.error('缺少令牌：请设置 GITHUB_TOKEN 或写入 .local/gh_token.txt'); process.exit(2); }
  if (deleted.length && !ALLOW_DELETE) console.log('（默认保留远端这些文件，不删除；如需删除加 --allow-delete）');

  const treeEntries = [];
  let n = 0;
  for (const p of [...added, ...changed]) {
    const v = local.get(p);
    const blob = curlJson('POST', `${API}/git/blobs`, { content: v.buf.toString('base64'), encoding: 'base64' });
    if (!blob || !blob.sha) {
      console.error(`创建 blob 失败（${p}）：${blob && blob.message ? blob.message : '未知错误'}`);
      console.error('常见原因：令牌权限不足，需 Contents = Read and write。');
      process.exit(4);
    }
    treeEntries.push({ path: p, mode: v.mode, type: 'blob', sha: blob.sha });
    n += 1;
    if (n % 25 === 0) console.log(`  已上传 ${n}/${added.length + changed.length}`);
  }
  if (ALLOW_DELETE) for (const p of deleted) treeEntries.push({ path: p, mode: '100644', type: 'blob', sha: null });
  if (!treeEntries.length) { console.log('没有需要提交的变更。'); return; }

  const tree = curlJson('POST', `${API}/git/trees`, { base_tree: baseTree, tree: treeEntries });
  if (!tree || !tree.sha) { console.error('创建 tree 失败：' + (tree && tree.message || '未知')); process.exit(5); }
  const msg = `release: v1.9.0 — 销售口径独立前端、报表中心、UI统一、对话同步与聊天媒体\n\n由本地 WorkBuddy 通过 GitHub API 提交。`;
  const newCommit = curlJson('POST', `${API}/git/commits`, { message: msg, tree: tree.sha, parents: [headSha] });
  if (!newCommit || !newCommit.sha) { console.error('创建 commit 失败：' + (newCommit && newCommit.message || '未知')); process.exit(6); }
  curlJson('PATCH', `${API}/git/refs/heads/${BRANCH}`, { sha: newCommit.sha, force: false });
  console.log(`已推送：${newCommit.sha}`);
  console.log(`https://github.com/${OWNER}/${REPO}/commit/${newCommit.sha}`);
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
