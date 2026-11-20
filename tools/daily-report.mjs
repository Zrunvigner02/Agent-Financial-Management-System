#!/usr/bin/env node
/**
 * 日报定时任务：生成报表 → 按开关推送企微 → 写日志。
 *
 *   node tools/daily-report.mjs            跑一次（计划任务调这个）
 *   node tools/daily-report.mjs --dry-run  只生成不推送
 *
 * 开关与凭证都在 .env：
 *   PUSH_ENABLED=1          1 开 / 0 关（手动开关）
 *   PUSH_CHANNEL=app|robot  app=自建应用消息；robot=群机器人 webhook
 *   WECOM_CORPID / WECOM_AGENTID / WECOM_SECRET / WECOM_TOUSER      （app 模式）
 *   WECOM_WEBHOOK                                                   （robot 模式）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { all } from '../backend/store.mjs';
import { readEnv } from '../backend/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const DRY = process.argv.includes('--dry-run');

const env = (k, d = '') => process.env[k] || readEnv(k) || d;
// 兼容另一套命名：WECOM_CORP_ID / WECOM_SECRET（backend/wecom-bot.mjs 用的就是这套）
const corpId = () => env('WECOM_CORPID') || env('WECOM_CORP_ID');
const pad = (n) => String(n).padStart(2, '0');
const now = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const log = [];
const say = (line) => { log.push(`[${now()}] ${line}`); console.log(line); };

function flush() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const d = new Date();
  const file = path.join(LOG_DIR, `daily-report-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.log`);
  fs.appendFileSync(file, `${log.join('\n')}\n`, 'utf8');
}

/* ---------- 1. 生成报表 ---------- */
const period = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`;
say(`开始：期间 ${period}${DRY ? '（dry-run 不推送）' : ''}`);
const gen = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'make-sales-report.mjs'), period],
  { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
if (gen.status !== 0) {
  say(`报表生成失败：${(gen.stderr || gen.stdout || '').slice(-400)}`);
  flush();
  process.exit(1);
}
let meta = {};
try { meta = JSON.parse((gen.stdout || '').trim().split('\n').slice(-30).join('\n')); } catch { /* 忽略 */ }
const file = meta.file || path.join(ROOT, 'exports', `销售报表_${period}_平台口径.xlsx`);
say(`报表已生成：${path.basename(file)}（${fs.existsSync(file) ? Math.round(fs.statSync(file).size / 1024) : 0} KB）`);

/* ---------- 2. 取摘要 ---------- */
const rows = all(`SELECT ROUND(SUM(d.amount),2) amt, ROUND(SUM(d.return_amount),2) rfd, ROUND(SUM(d.fee),2) fee
  FROM sales_daily d WHERE d.set_id = 85 AND d.source = 'platform' AND substr(d.date,1,7) = ?`, period);
const s = rows[0] || { amt: 0, rfd: 0, fee: 0 };
const profit = Math.round((Number(s.amt) - Number(s.rfd) - Number(s.fee)) * 100) / 100;
const text = [
  `【${period} 销售日报】`,
  `销售额 ${Number(s.amt).toLocaleString('zh-CN')} 元`,
  `退款 ${Number(s.rfd).toLocaleString('zh-CN')} 元`,
  `推广费 ${Number(s.fee).toLocaleString('zh-CN')} 元`,
  `净利 ${profit.toLocaleString('zh-CN')} 元`,
  `明细见附件（分品牌、分渠道、按日）`,
].join('\n');

/* ---------- 3. 推送 ---------- */
async function token(corpid, secret) {
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(secret)}`);
  const j = await r.json();
  if (j.errcode) throw new Error(`gettoken 失败 ${j.errcode} ${j.errmsg}`);
  return j.access_token;
}

async function uploadFile(tk, filePath) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('media', new Blob([buf]), path.basename(filePath));
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${tk}&type=file`,
    { method: 'POST', body: fd });
  const j = await r.json();
  if (j.errcode) throw new Error(`上传素材失败 ${j.errcode} ${j.errmsg}`);
  return j.media_id;
}

async function pushApp(tk) {
  const agentid = env('WECOM_AGENTID');
  const touser = env('WECOM_TOUSER', '@all');
  const r1 = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tk}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ touser, msgtype: 'text', agentid: Number(agentid), text: { content: text } }),
  });
  const j1 = await r1.json();
  if (j1.errcode) throw new Error(`发送文本失败 ${j1.errcode} ${j1.errmsg}`);
  if (j1.invaliduser) say(`注意：以下接收人无效 ${j1.invaliduser}`);
  say(`文本已发送（${touser}）`);

  const mediaId = await uploadFile(tk, file);
  const r2 = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tk}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      touser, msgtype: 'file', agentid: Number(agentid),
      file: { media_id: mediaId },
    }),
  });
  const j2 = await r2.json();
  if (j2.errcode) throw new Error(`发送文件失败 ${j2.errcode} ${j2.errmsg}`);
  if (j2.invaliduser) say(`注意：以下接收人无效 ${j2.invaliduser}`);
  say(`Excel 已发送：${path.basename(file)}`);
}

async function pushRobot() {
  const hook = env('WECOM_WEBHOOK');
  if (!hook) throw new Error('未配置 WECOM_WEBHOOK');
  const r = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
  });
  const j = await r.json();
  if (j.errcode) throw new Error(`群机器人发送失败 ${j.errcode} ${j.errmsg}`);
  say('群机器人文本已发送（群机器人不支持直接发文件，需应用凭证上传素材）');
}

(async () => {
  const enabled = String(env('PUSH_ENABLED', '0')) === '1';
  if (DRY) { say('dry-run：跳过推送'); flush(); return; }
  if (!enabled) { say('推送开关未开启（PUSH_ENABLED=0），报表已生成，未发送'); flush(); return; }

  const channel = String(env('PUSH_CHANNEL', 'app')).toLowerCase();
  try {
    if (channel === 'robot') {
      await pushRobot();
    } else {
      const corpid = corpId();
      const secret = env('WECOM_SECRET');
      if (!corpid || !secret || !env('WECOM_AGENTID')) {
        throw new Error('缺少企业微信配置：WECOM_CORPID(或 WECOM_CORP_ID) / WECOM_SECRET / WECOM_AGENTID');
      }
      const tk = await token(corpid, secret);
      say('access_token 已获取');
      await pushApp(tk);
    }
    say('推送完成');
  } catch (e) {
    say(`推送失败：${e.message}`);
    flush();
    process.exit(2);
  }
  flush();
})();
