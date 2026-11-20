#!/usr/bin/env node
/**
 * 推送开关：手动开/关企微日报推送，并检查配置是否齐全。
 *
 *   node tools/push-toggle.mjs status   # 看当前开关与配置
 *   node tools/push-toggle.mjs on       # 打开（PUSH_ENABLED=1）
 *   node tools/push-toggle.mjs off      # 关闭（PUSH_ENABLED=0）
 *   node tools/push-toggle.mjs channel app|robot
 *   node tools/push-toggle.mjs test     # 立即跑一次日报任务（含推送）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnv } from '../backend/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, '.env');
const env = (k, d = '') => process.env[k] || readEnv(k) || d;

function setKey(key, value) {
  let s = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(s)) s = s.replace(re, `${key}=${value}`);
  else s = `${s.replace(/\s*$/, '')}\n${key}=${value}\n`;
  fs.writeFileSync(ENV, s, 'utf8');
}

const cmd = (process.argv[2] || 'status').toLowerCase();
const arg = process.argv[3];

if (cmd === 'on' || cmd === 'off') {
  setKey('PUSH_ENABLED', cmd === 'on' ? '1' : '0');
  console.log(`推送开关已${cmd === 'on' ? '打开' : '关闭'}（PUSH_ENABLED=${cmd === 'on' ? 1 : 0}）`);
} else if (cmd === 'channel') {
  const c = ['app', 'robot'].includes(arg) ? arg : 'app';
  setKey('PUSH_CHANNEL', c);
  console.log(`推送通道已设为 ${c}（app=应用消息，robot=群机器人）`);
} else if (cmd === 'test') {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'daily-report.mjs')], { cwd: ROOT, encoding: 'utf8' });
  console.log((r.stdout || '').trim());
  if (r.stderr) console.log((r.stderr || '').trim());
  process.exit(r.status || 0);
} else {
  const enabled = String(env('PUSH_ENABLED', '0')) === '1';
  const channel = env('PUSH_CHANNEL', 'app');
  const need = channel === 'robot'
    ? [['WECOM_WEBHOOK', env('WECOM_WEBHOOK')]]
    : [['WECOM_CORPID 或 WECOM_CORP_ID', env('WECOM_CORPID') || env('WECOM_CORP_ID')], ['WECOM_AGENTID', env('WECOM_AGENTID')],
      ['WECOM_SECRET', env('WECOM_SECRET')], ['WECOM_TOUSER', env('WECOM_TOUSER')]];
  const missing = need.filter(([, v]) => !v).map(([k]) => k);
  console.log(`开关：${enabled ? '已开启' : '已关闭'}`);
  console.log(`通道：${channel === 'robot' ? '群机器人 webhook' : '自建应用消息'}`);
  console.log(`配置：${missing.length ? `缺 ${missing.join('、')}` : '齐全'}`);
  if (!enabled) console.log('打开命令：npm run push:on');
}
