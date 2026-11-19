#!/usr/bin/env node
/**
 * 旺店通坐标「双证」校验：相对客户区坐标 vs 屏幕绝对坐标
 *
 *   npm run wdt:verify
 *
 * 不做任何点击，只让 AutoHotkey 把每个点位按两路各算一次，
 * 对比：一致 / 窗口位移可跟随 / 相对越界需重校准。
 * 退出码 0 正常、3 有需要处理的点。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RPA = path.join(ROOT, 'tools', 'rpa');
const AHK = path.join(ROOT, 'tools', 'bin', 'AutoHotkey64.exe');
const SCRIPT = path.join(RPA, 'wdt-export.ahk');
const CHECK = path.join(RPA, 'wdt-coords-check.txt');
const INI = path.join(RPA, 'wdt-coords.ini');

function bail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(AHK)) bail('缺少 tools/bin/AutoHotkey64.exe');
if (!fs.existsSync(SCRIPT)) bail('缺少 tools/rpa/wdt-export.ahk');
if (!fs.existsSync(INI)) bail('还没校准：先跑 npm run wdt:calibrate');

const r = spawnSync(AHK, [SCRIPT, '--verify'], {
  cwd: RPA, encoding: 'utf8', timeout: 60000, windowsHide: true,
});

let body = '';
if (fs.existsSync(CHECK)) {
  const raw = fs.readFileSync(CHECK);
  body = raw[0] === 0xff && raw[1] === 0xfe
    ? raw.toString('utf16le').replace(/^\uFEFF/, '')
    : raw.toString('utf8').replace(/^\uFEFF/, '');
}

if (!body.trim()) {
  console.error(`✗ 校验没产生结果（退出码 ${r.status}）`);
  if (r.stderr) console.error(r.stderr.slice(0, 400));
  console.error('  常见原因：旺店通没在运行、脚本有语法错误。');
  process.exit(1);
}

console.log(body.trim());

const bad = /有 \d+ 项需要重校准/.test(body);
const ok = /双证全部一致/.test(body);
console.log('');
console.log(ok
  ? '✓ 两个坐标体系完全吻合，可直接自动导出'
  : bad
    ? '⚠ 有坐标需要重校准，建议跑 npm run wdt:calibrate'
    : '✓ 相对坐标可用（窗口有位移时优先用相对，属正常）');
process.exit(bad ? 3 : 0);
