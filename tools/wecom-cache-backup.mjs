#!/usr/bin/env node
/**
 * 企微缓存备份：把企业微信收到的文件按天备份进项目
 *
 * 背景：企微「文件存储位置」已通过目录联接接到 D:\振颜丽舍\wecom\WXWork，
 *       项目可以直接读到，无需用户再改客户端设置。
 *
 * 做什么：
 *   - 扫描 WXWork\<企业ID>\ 下的 Cache / Data / Backup / WeDrive / Avator；
 *   - 按内容 sha256 去重，新文件复制到 备份/wecom/<YYYY-MM-DD>/，保留原目录层级；
 *   - 跳过加密库（*.db / *.db-wal / *.db-shm）与临时文件，避免把无用的密文搬来搬去；
 *   - 写 备份/wecom/index.json：谁、哪天、哪些文件、多大。
 *
 * 读不到什么（已知限制，不假装能做到）：
 *   企微的 message.db / file.db 是 SQLCipher 加密库，本项目不解密，
 *   所以聊天正文要靠 A 方案（AIBot 会话同步）或 B 方案（自建应用回调）拿，
 *   这里只负责「文件本体 + 台账」，保证原件不丢。
 *
 *   node tools/wecom-cache-backup.mjs                 # 增量备份
 *   node tools/wecom-cache-backup.mjs --dry            # 只看会备份什么
 *   node tools/wecom-cache-backup.mjs --prune 30       # 删除 30 天前的备份副本
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.WECOM_CACHE_DIR || path.join(os.homedir(), 'Documents', 'WXWork');
const OUT = path.join(ROOT, '备份', 'wecom');
const INDEX = path.join(OUT, 'index.json');
const MAX_MB = Number(process.env.WECOM_BACKUP_MAX_MB || 200);

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
// 只在企微真的开着的时候备份：没开就跳过，不报错、不刷屏
const IF_RUNNING = argv.includes('--if-running');
const pruneIdx = argv.indexOf('--prune');
const PRUNE_DAYS = pruneIdx >= 0 ? Number(argv[pruneIdx + 1] || 30) : 0;

const SKIP_EXT = new Set(['.db', '.db-wal', '.db-shm', '.tmp', '.lock', '.log']);
const SKIP_DIR = new Set(['CefCache', 'EML', 'Index', 'TempFile']);
const SUBDIRS = ['Cache', 'Data', 'Backup', 'WeDrive'];   // 头像/表情不入库，省空间

/** 企微客户端是否在运行（没开就不备份，避免空跑） */
function wecomRunning(proc = process.env.WECOM_PROC || 'WXWork.exe') {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${proc}`, '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 8000,
    });
    // 进程不存在时 tasklist 会输出「信息: 没有运行的任务匹配指定标准。」
    return out.toLowerCase().includes(proc.toLowerCase());
  } catch {
    return false;
  }
}

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const human = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return { files: {}, runs: [] }; }
}
function saveIndex(idx) {
  fs.mkdirSync(path.dirname(INDEX), { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2), 'utf8');
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(p, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;
      out.push(p);
    }
  }
  return out;
}

function main() {
  if (IF_RUNNING && !wecomRunning()) {
    console.log('企微未运行，本次跳过（不做空备份）');
    process.exit(0);
  }
  if (!fs.existsSync(SRC)) {
    console.log(`找不到企微目录：${SRC}`);
    console.log('若已迁移，请确认 Documents\\WXWork 联接存在，或设置 WECOM_CACHE_DIR 指向实际位置。');
    process.exit(IF_RUNNING ? 0 : 1);
  }

  const idx = loadIndex();
  const day = today();
  const dayDir = path.join(OUT, day);
  const corps = fs.readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{10,}$/.test(e.name))
    .map((e) => e.name);

  let scanned = 0;
  let copied = 0;
  let skippedDup = 0;
  let skippedBig = 0;
  let bytes = 0;

  for (const corp of corps) {
    for (const sub of SUBDIRS) {
      const base = path.join(SRC, corp, sub);
      if (!fs.existsSync(base)) continue;
      for (const file of walk(base)) {
        scanned += 1;
        let buf;
        try {
          const st = fs.statSync(file);
          if (st.size > MAX_MB * 1024 * 1024) { skippedBig += 1; continue; }
          buf = fs.readFileSync(file);
        } catch { continue; }
        const hash = sha256(buf);
        if (idx.files[hash]) { skippedDup += 1; continue; }
        const rel = path.relative(SRC, file);
        const target = path.join(dayDir, rel);
        if (!DRY) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, buf);
        }
        idx.files[hash] = { rel: rel.replace(/\\/g, '/'), size: buf.length, at: new Date().toISOString(), day };
        copied += 1;
        bytes += buf.length;
      }
    }
  }

  if (!DRY) {
    idx.runs = [{ at: new Date().toISOString(), scanned, copied, skipped_dup: skippedDup, skipped_big: skippedBig, bytes }, ...(idx.runs || [])].slice(0, 60);
    saveIndex(idx);
  }

  console.log(`${DRY ? '[试运行] ' : ''}企微缓存备份`);
  console.log(`  来源    ${SRC}`);
  console.log(`  企业    ${corps.length} 个`);
  console.log(`  扫描    ${scanned} 个文件`);
  console.log(`  新增    ${copied} 个（${human(bytes)}）`);
  console.log(`  已存在  ${skippedDup} 个（按内容去重）`);
  if (skippedBig) console.log(`  过大跳过 ${skippedBig} 个（>${MAX_MB}MB）`);
  console.log(`  落盘    ${dayDir}`);

  if (PRUNE_DAYS > 0 && !DRY) {
    const cutoff = new Date(Date.now() - PRUNE_DAYS * 86400000).toISOString().slice(0, 10);
    let removed = 0;
    for (const d of fs.readdirSync(OUT)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d >= cutoff) continue;
      fs.rmSync(path.join(OUT, d), { recursive: true, force: true });
      removed += 1;
    }
    console.log(`  清理    ${removed} 个超过 ${PRUNE_DAYS} 天的备份目录`);
  }
}

main();
