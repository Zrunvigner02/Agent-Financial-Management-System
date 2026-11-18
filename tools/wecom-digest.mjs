#!/usr/bin/env node
/**
 * 企微报表「收数 → 入库 → 出报表 → 回报给主人」一体化任务（v2.5.0）
 *
 *   node tools/wecom-digest.mjs                 # 全流程（默认当月）
 *   node tools/wecom-digest.mjs --period=2026-11
 *   node tools/wecom-digest.mjs --no-send       # 只入库出报表，不发消息
 *   node tools/wecom-digest.mjs --dry           # 只统计不写库
 *
 * 架构（老板指定的模式，全程不需要公网入站）：
 *   1. 同事把报表发给企微里的「机器人/助理账号」→ 该账号登录在本机 → 文件落到
 *      Documents/WXWork/<账号>/Cache/File（多账号都会扫）
 *   2. 本命令扫描缓存 → 四重防重 → 入库 sales_daily（口径 wecom）→ 归档到 data/wecom
 *   3. 按 rules/report-rules.md 的样板版式生成报表
 *   4. 把摘要发回主人的企微：
 *      - 优先用「群机器人 webhook」（建个群加机器人即可，无需管理员开应用）
 *      - 或「自建应用消息」发给指定 userid（只走出站，同样不需要回调地址）
 *
 * 发送需要配其中一组（.env）：
 *   WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
 *   或 WECOM_CORP_ID + WECOM_SECRET + WECOM_AGENT_ID + WECOM_OWNER_USERID
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { all, get } = await import('file:///' + path.join(ROOT, 'backend', 'store.mjs').replace(/\\/g, '/'));
const wecom = await import('file:///' + path.join(ROOT, 'backend', 'wecom.mjs').replace(/\\/g, '/'));
const bot = await import('file:///' + path.join(ROOT, 'backend', 'wecom-bot.mjs').replace(/\\/g, '/'));

const ARGS = process.argv.slice(2);
const val = (n, d = '') => {
  const hit = ARGS.find((a) => a.startsWith(`--${n}=`));
  if (hit) return hit.slice(n.length + 3);
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : d;
};
const flag = (n) => ARGS.includes(`--${n}`);

const SET = 85;
const NOW = new Date();
const PERIOD = val('period', `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}`);
const YEAR = PERIOD.slice(0, 4);
const NO_SEND = flag('no-send');
const DRY = flag('dry');

const line = (s = '') => process.stdout.write(s + '\n');
const money = (v) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => (Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(2)}%` : '—');

/* ---------- 1. 入库 ---------- */
line(`① 扫描企微缓存并入库（口径 wecom，期间 ${PERIOD}）`);
const sync = wecom.syncWecom(SET, { apply: !DRY, actor: 'digest' });
if (sync.code !== 0) {
  line(`   失败：${sync.message}`);
  process.exitCode = 1;
  process.exit();
}
const d = sync.data;
line(`   日报 ${d.accepted} 份 / 新增 ${d.rows.new} 行 / 修正 ${d.rows.updated} 行 / 判重 ${d.duplicates}`
  + (d.reconcile?.review?.length ? ` / 待复核 ${d.reconcile.review.length}` : ''));

/* ---------- 2. 出报表 ---------- */
let reportFile = '';
if (!DRY) {
  line('② 按样板版式生成报表');
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'make-sales-report.mjs'), PERIOD, '--source=wecom'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    reportFile = path.join(ROOT, 'exports', `销售报表_${PERIOD}_企微缓存口径.xlsx`);
    line(`   ${fs.existsSync(reportFile) ? reportFile.replace(ROOT + path.sep, '') : '（未生成，检查上一个报错）'}`);
  } catch (e) {
    line(`   生成报表失败：${String(e.message).slice(0, 160)}`);
  }
}

/* ---------- 3. 汇总数字 ---------- */
const stat = (from, to) => get(`SELECT COUNT(*) n, ROUND(SUM(amount),2) a, ROUND(SUM(return_amount),2) r,
    ROUND(SUM(fee),2) f, MIN(date) d1, MAX(date) d2
  FROM sales_daily WHERE set_id = ? AND source = 'wecom' AND date >= ? AND date <= ?`, SET, from, to);

const mStart = `${PERIOD}-01`;
const mEnd = `${PERIOD}-31`;
const yStart = `${YEAR}-01-01`;
const yEnd = `${YEAR}-12-31`;
const M = stat(mStart, mEnd);
const Y = stat(yStart, yEnd);
const net = (x) => Number(x.a || 0) - Number(x.r || 0) - Number(x.f || 0);

const chs = all(`SELECT c.name, COUNT(*) days, ROUND(SUM(d.amount),2) amt, MAX(d.date) last
  FROM sales_daily d JOIN sales_channels c ON c.id = d.channel_id
  WHERE d.set_id = ? AND d.source = 'wecom' AND d.date >= ? GROUP BY c.id ORDER BY amt DESC`, SET, mStart);

const pend = get(`SELECT COUNT(*) n FROM wecom_files WHERE set_id = ? AND status = 'pending'`, SET).n;
const review = all(`SELECT * FROM wecom_reconcile WHERE set_id = ? AND status = 'review'`, SET);

/* ---------- 4. 组装摘要 ---------- */
const md = [];
md.push(`## 销售日报已更新（${PERIOD}）`);
md.push(`> 更新于 ${NOW.toISOString().replace('T', ' ').slice(0, 19)}　口径：企微缓存 / 销售端`);
md.push('');
md.push(`**本次处理**：日报 ${d.accepted} 份，新增 ${d.rows.new} 行，修正 ${d.rows.updated} 行，判重 ${d.duplicates} 份`);
md.push('');
md.push(`**本月（截至 ${M.d2 || '—'}）**`);
md.push(`- 销售额：**${money(M.a)}**　退款：${money(M.r)}　推广费：${money(M.f)}`);
md.push(`- 销售净利额（去退−推广费）：**${money(net(M))}**　净利率：${pct(M.a ? net(M) / M.a : NaN)}`);
md.push('');
md.push(`**本年累计（${YEAR}）**`);
md.push(`- 销售额：**${money(Y.a)}**　退货：${money(Y.r)}　净利额：**${money(net(Y))}**　净利率：${pct(Y.a ? net(Y) / Y.a : NaN)}`);
if (chs.length) {
  md.push('');
  md.push('**本月分渠道**');
  for (const c of chs.slice(0, 8)) {
    md.push(`- ${c.name}：${money(c.amt)}（${c.days} 天，最新 ${c.last}）`);
  }
}
const gaps = [];
if (pend) gaps.push(`${pend} 份报表适配器未接（抖音/小红书）`);
if (review.length) gaps.push(`${review.length} 处汇总与明细不符待复核`);
const stale = chs.filter((c) => c.last && c.last < mEnd.slice(0, 8) + '01');
if (stale.length) gaps.push(`渠道停更：${stale.map((c) => c.name).join('、')}`);
if (gaps.length) {
  md.push('');
  md.push('**需要关注**');
  for (const g of gaps) md.push(`- ${g}`);
}
if (reportFile) {
  md.push('');
  md.push(`**报表**：已生成 \`${path.basename(reportFile)}\`（5 类表，样式照样板）`);
}

const content = md.join('\n');
line('③ 摘要');
line(content.split('\n').map((x) => `   ${x}`).join('\n'));

const outDir = path.join(ROOT, 'exports');
fs.mkdirSync(outDir, { recursive: true });
const digestFile = path.join(outDir, `日报摘要_${PERIOD}_${NOW.toISOString().slice(0, 10)}.md`);
fs.writeFileSync(digestFile, content + '\n');
line(`   已保存：${digestFile.replace(ROOT + path.sep, '')}`);

/* ---------- 5. 发送 ---------- */
async function sendWebhook(url) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content: content.slice(0, 4000) } }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.errcode) throw new Error(`webhook 返回 ${j.errcode}：${j.errmsg}`);
  return '群机器人 webhook';
}

async function sendApp() {
  const cfg = bot.botConfig();
  const owner = String(process.env.WECOM_OWNER_USERID || '').trim();
  if (!cfg.corpId || !cfg.secret || !owner) throw new Error('缺少 WECOM_CORP_ID / WECOM_SECRET / WECOM_OWNER_USERID');
  await bot.sendText(cfg, owner, content.replace(/\*\*/g, '').replace(/`/g, '').slice(0, 1800));
  return `应用消息 → ${owner}`;
}

const webhook = String(process.env.WECOM_WEBHOOK || '').trim();
if (NO_SEND) {
  line('④ 已跳过发送（--no-send）');
} else if (DRY) {
  line('④ 预演模式，不发送');
} else if (webhook) {
  try { line(`④ 已发送：${await sendWebhook(webhook)}`); }
  catch (e) { line(`④ 发送失败：${e.message}`); process.exitCode = 1; }
} else if (process.env.WECOM_CORP_ID && process.env.WECOM_SECRET && process.env.WECOM_OWNER_USERID) {
  try { line(`④ 已发送：${await sendApp()}`); }
  catch (e) { line(`④ 发送失败：${e.message}`); process.exitCode = 1; }
} else {
  line('④ 未配置发送通道，摘要仅保存到本地');
  line('   要自动发到你企微，二选一：');
  line('   · 建个群加「群机器人」，把 Webhook 地址填到 .env 的 WECOM_WEBHOOK');
  line('   · 或自建应用填 WECOM_CORP_ID / WECOM_SECRET / WECOM_AGENT_ID / WECOM_OWNER_USERID');
}
