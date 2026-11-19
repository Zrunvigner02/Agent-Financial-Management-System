#!/usr/bin/env node
/**
 * 旺店通自动导出（RPA）—— 命令行入口
 *
 *   node tools/rpa/run-export.mjs --calibrate      # 第一次：校准坐标（按 F8 逐项记录）
 *   node tools/rpa/run-export.mjs                  # 默认导出最近 30 天到今日
 *   node tools/rpa/run-export.mjs --from 2026-11-01 --to 2026-11-19
 *   node tools/rpa/run-export.mjs --no-import      # 只导出，不入库
 *
 * 做完导出后会自动跑 tools/wdt-watch.mjs --once 入库。
 *
 * 前置：旺店通 ERP 已登录并保持运行；tools/rpa/wdt-coords.ini 已校准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RPA = path.join(ROOT, 'tools', 'rpa');
const AHK = path.join(ROOT, 'tools', 'bin', 'AutoHotkey64.exe');
const COORD = path.join(RPA, 'wdt-coords.ini');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

if (!fs.existsSync(AHK)) {
  console.error(`缺少 ${AHK}，请确认 tools/bin 下有 AutoHotkey64.exe`);
  process.exit(1);
}

if (has('--calibrate')) {
  console.log('开始校准：请在旺店通窗口里按 F8 逐项记录坐标，F9 跳过，Esc 退出。');
  spawnSync(AHK, [path.join(RPA, 'wdt-calibrate.ahk')], { stdio: 'inherit', cwd: RPA });
  process.exit(0);
}

// 补录导出弹窗内的「模板 / 导出」两个点（弹窗此刻开着最好）
if (has('--calibrate-dialog')) {
  console.log('补录导出弹窗：先让「导出」弹窗出现在屏幕上，再按 F8 依次指向 模板1、导出按钮。');
  spawnSync(AHK, [path.join(RPA, 'wdt-calibrate-dialog.ahk')], { stdio: 'inherit', cwd: RPA });
  process.exit(0);
}

if (!fs.existsSync(COORD)) {
  console.error('还没有坐标文件，请先运行：node tools/rpa/run-export.mjs --calibrate');
  process.exit(1);
}

const to = val('--to') || ymd(new Date());
const from = val('--from') || ymd(new Date(Date.now() - 29 * 86400000));

console.log(`导出期间：${from} ~ ${to}`);
const r = spawnSync(AHK, [path.join(RPA, 'wdt-export.ahk'), from, to], { cwd: RPA, encoding: 'utf8' });
console.log('RPA 退出码:', r.status);

const log = path.join(RPA, 'wdt-export.log');
if (fs.existsSync(log)) console.log(fs.readFileSync(log, 'utf8').trim().split('\n').slice(-4).join('\n'));

if (has('--no-import')) process.exit(r.status || 0);

console.log('\n开始入库…');
const imp = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'wdt-watch.mjs'), '--once'], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(imp.stdout || '');
process.stderr.write(imp.stderr || '');
process.exit(imp.status || 0);
