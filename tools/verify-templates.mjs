#!/usr/bin/env node
/**
 * verify-templates —— 两个固定版式表格的自动校验（防止有人改动导致版式跑偏）
 *
 * 版式 A：渠道每日经营数据（29 栏）—— 用生成器现生成一份再逐项校验
 * 版式 B：标准月对比表（7 个工作表）—— 校验归档样例的 sheet 结构
 *
 * 用法：node tools/verify-templates.mjs [--verbose]
 * 退出码：0 全部通过；1 有失败项
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipEntries } from '../backend/export.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const results = [];
const ok = (name, extra = '') => results.push({ name, pass: true, extra });
const bad = (name, extra = '') => results.push({ name, pass: false, extra });
const check = (cond, name, extra = '') => (cond ? ok(name, extra) : bad(name, extra));

/* ---------------- 通用 xlsx 读取（零依赖） ---------------- */
function readXlsx(file) {
  const files = unzipEntries(fs.readFileSync(file));
  const wb = files['xl/workbook.xml'] ? files['xl/workbook.xml'].toString('utf8') : '';
  const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  const parts = Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const sx = files['xl/sharedStrings.xml'].toString('utf8');
    for (const m of sx.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
    }
  }
  return { files, sheets, shared, sheetsXml: parts.map((p) => files[p].toString('utf8')) };
}

/** 取某一行的单元格文本（inlineStr / is/t） */
function rowTexts(sheetXml, rowNo, shared = []) {
  const m = sheetXml.match(new RegExp(`<row r="${rowNo}"[^>]*>([\\s\\S]*?)</row>`));
  if (!m) return [];
  return [...m[1].matchAll(/<c\b[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)]
    .map((c) => {
      const body = c[1] || '';
      const inline = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      if (inline) return inline[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      if (v && shared[Number(v[1])] != null) return shared[Number(v[1])];
      return v ? v[1] : '';
    });
}

/* ---------------- 版式 A：渠道日报 29 栏 ---------------- */
const DAILY_COLS = ['日期', '销售额', '退款金额', '退后销售额', '退款率', '买家数', '支付件数', '支付子订单数', '客单价', '支付转化率',
  '访客数(UV)', '浏览量(PV)', 'UV价值', '收藏人数', '加购人数', '加购件数', '关注店铺人数', '老买家数', '新买家数', '老客占比',
  '新访客数', '短视频访客数', '新增会员数', '会员成交人数', '会员成交金额', '复购会员数', '推广消耗', '费比', '费比(退后)'];

function verifyDaily() {
  const tmp = path.join(os.tmpdir(), `zd-verify-daily-${Date.now()}.xlsx`);
  try {
    execFileSync('node', [path.join(ROOT, 'tools', 'make-channel-daily.mjs'),
      '--brand', 'PF79', '--channel', '淘宝+京东', '--from', '2026-11-01', '--to', '2026-11-09',
      '--out', tmp], { stdio: 'pipe' });
  } catch (e) {
    bad('A1 生成渠道日报', String(e.stderr || e.message).slice(0, 160));
    return;
  }
  const { files, sheets, sheetsXml } = readXlsx(tmp);
  const s1 = sheetsXml[0] || '';

  check(sheets.length === 2 && sheets[0] === '每日经营数据' && sheets[1] === '口径说明',
    'A2 两个工作表命名', sheets.join(' / '));

  const merges = [...s1.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]);
  check(merges.includes('A1:AC1'), 'A3 标题合并 A1:AC1', merges.join(','));
  check(merges.includes('A2:AC2'), 'A4 口径行合并 A2:AC2');

  const head = rowTexts(s1, 3).filter((x) => x !== '');
  check(head.length === 29, 'A5 表头 29 列', `实际 ${head.length} 列`);
  const diff = DAILY_COLS.map((c, i) => (head[i] === c ? '' : `${i + 1}:"${head[i]}"≠"${c}"`)).filter(Boolean);
  check(diff.length === 0, 'A6 表头逐列文字一致', diff.slice(0, 5).join(' '));

  check(/<pane[^>]*xSplit="1"[^>]*ySplit="3"/.test(s1), 'A7 冻结窗格 B4');

  const styles = files['xl/styles.xml'] ? files['xl/styles.xml'].toString('utf8') : '';
  check(styles.includes('#,##0.00'), 'A8 金额格式 #,##0.00');
  check(styles.includes('0.00%'), 'A9 比率格式 0.00%');
  check(styles.includes('formatCode="#,##0"'), 'A10 计数格式 #,##0');
  check(styles.includes('DAE3F3'), 'A11 表头底色 #DAE3F3');

  // 找合计行：含「合计/均值」
  const rows = [...s1.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)];
  const totalRowNo = rows.find(([, , body]) => body.includes('合计/均值'))?.[1];
  check(!!totalRowNo, 'A12 存在「合计/均值」行', totalRowNo ? `第 ${totalRowNo} 行` : '未找到');
  const totalBody = totalRowNo ? (rows.find((r) => r[1] === totalRowNo)[2] || '') : '';
  check(/<f>/.test(totalBody), 'A13 合计行带公式');

  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
}

/* ---------------- 版式 B：标准月对比表 ---------------- */
const SAMPLE = path.join(ROOT, '..', '..', '..', 'WorkBuddy', 'Claw', '报表', '标准模板', '标准样例-月对比表-日报汇总.xlsx');
const EXPECT_SHEETS = ['总月报表26年11月', '歌剧月对比表', '歌剧日汇总', '歌剧主打单品分析各渠道', 'PF月对比表', 'PF 日汇总表', 'PF主打单品渠道分析表'];

function verifySample() {
  const sample = fs.existsSync(SAMPLE) ? SAMPLE
    : path.join('C:/Users/zylspc/WorkBuddy/Claw/报表/标准模板/标准样例-月对比表-日报汇总.xlsx');
  if (!fs.existsSync(sample)) { bad('B1 标准样例存在', sample); return; }
  const { sheets, sheetsXml, shared } = readXlsx(sample);
  check(sheets.length === 7, 'B2 七个工作表', `实际 ${sheets.length}：${sheets.join(' / ')}`);
  check(EXPECT_SHEETS.every((s) => sheets.includes(s)), 'B3 工作表名称齐全',
    EXPECT_SHEETS.filter((s) => !sheets.includes(s)).join(',') || '');
  const s1 = sheetsXml[0] || '';
  const merges = [...s1.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]);
  check(merges.length > 0, 'B4 总月报表含合并表头', `${merges.length} 处`);
  // 表头行未必在第 4 行：取前 12 行里非空单元格最多的一行
  let best = { row: 0, n: 0 };
  for (let r = 1; r <= 12; r += 1) {
    const n = rowTexts(s1, r, shared).filter(Boolean).length;
    if (n > best.n) best = { row: r, n };
  }
  check(best.n >= 8, 'B5 总月报表存在表头行', `第 ${best.row} 行，${best.n} 列非空`);
  const headRow = rowTexts(s1, best.row, shared).filter(Boolean);
  check(headRow.some((x) => /月份|日期|销售额|项目|指标/.test(x)), 'B6 表头含关键字段',
    headRow.slice(0, 6).join('|'));
}

/* ---------------- 主流程 ---------------- */
console.log('== 版式 A：渠道每日经营数据（29 栏）==');
verifyDaily();
console.log('== 版式 B：标准月对比表（7 表）==');
verifySample();

let fail = 0;
for (const r of results) {
  if (!r.pass) fail += 1;
  console.log(`${r.pass ? '✓' : '✗'} ${r.name}${r.extra ? `（${r.extra}）` : ''}`);
}
console.log(`\n版式校验：${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
