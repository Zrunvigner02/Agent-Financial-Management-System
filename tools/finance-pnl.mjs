#!/usr/bin/env node
/**
 * 财务端销售损益表命令行。
 *
 *   node tools/finance-pnl.mjs --import=<损益表.xlsx>      # 导入（历史月份补录 / 验证基准）
 *   node tools/finance-pnl.mjs --check=<损益表.xlsx>       # 与模板逐项核对
 *   node tools/finance-pnl.mjs --period=2026-10            # 输出损益矩阵
 *   node tools/finance-pnl.mjs --period=2026-Q4            # 季报（按季度聚合）
 *   node tools/finance-pnl.mjs --gaps --period=2026-10     # 取数缺口 + 数据来源分布
 *
 * 口径见 rules/finance-pnl-rules.md。本命令只写 fin_* 表，不碰 sales_daily。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import('file:///' + path.join(ROOT, 'backend', 'finance.mjs').replace(/\\/g, '/'));
const { get } = await import('file:///' + path.join(ROOT, 'backend', 'store.mjs').replace(/\\/g, '/'));

const args = process.argv.slice(2);
const val = (name, def = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (n) => args.includes(`--${n}`);
const asJson = flag('json');
const setId = Number(val('set', 85)) || 85;
const line = (s = '') => process.stdout.write(s + '\n');

const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(2)}%`);

function printPnl(d) {
  line(`期间 ${d.period}${d.months.length > 1 ? `（聚合 ${d.months.join(' + ')}）` : ''}`);
  const rows = [
    ['主营业务收入', 'revenue', null],
    ['成本', 'cost', 'cost_ratio'],
    ['毛利', 'gross_profit', 'gross_margin'],
    ['推广费', 'ad_spend', 'ad_ratio'],
    ['平台扣点', 'platform_fee', 'fee_ratio'],
    ['物流费', 'logistics', 'logistics_ratio'],
    ['变动费用合计', 'variable_total', 'variable_ratio'],
    ['边界利润', 'boundary_profit', 'boundary_margin'],
    ['人力成本', 'labor_cost', 'labor_ratio'],
    ['净利润', 'net_profit', 'net_margin'],
  ];
  const blocks = [...d.brands.map((b) => ({ title: `${b.brand}${b.code ? `（${b.code}）` : ''}`, channels: b.channels, total: b.total })),
    { title: '全部品牌合计', channels: d.all.channels, total: d.all.total }];

  for (const blk of blocks) {
    const chs = Object.keys(blk.channels);
    if (!chs.length) continue;
    line(`\n── ${blk.title} ──`);
    // 每个渠道一列，合计一列
    const W = 18, TW = 24;
    const head = ['科目', ...chs.map((c) => (c.length > 8 ? c.slice(0, 8) : c)), '合计'];
    line(head.map((h, i) => (i === 0 ? h.padEnd(14) : h.padStart(i === head.length - 1 ? TW : W))).join(''));
    for (const [label, key, ratioKey] of rows) {
      const cells = chs.map((ch) => fmt(blk.channels[ch][key]));
      const totalCell = ratioKey ? `${fmt(blk.total[key])} ${pct(blk.total[ratioKey])}` : fmt(blk.total[key]);
      line([label.padEnd(14), ...cells.map((c) => c.padStart(W)), totalCell.padStart(TW)].join(''));
    }
  }
  if (d.missing.length) {
    line(`\n取数缺口 ${d.missing.length} 项（前 12）：`);
    d.missing.slice(0, 12).forEach((m) => line(`  - ${m}`));
  }
}

try {
  const impFile = val('import');
  const checkFile = val('check');
  const period = val('period');

  if (impFile) {
    const r = mod.importWorkbook(setId, fs.readFileSync(impFile), { period, sourceRef: path.basename(impFile) });
    if (asJson) line(JSON.stringify(r, null, 2));
    else if (r.code !== 0) { line(`失败：${r.message}`); process.exitCode = 1; }
    else {
      line(r.message);
      line(`  期间 ${r.data.period}｜品牌 ${r.data.brands.join('/')}｜渠道 ${r.data.channels.length} 个`);
    }
  } else if (checkFile) {
    const r = mod.checkAgainstWorkbook(setId, fs.readFileSync(checkFile), { period });
    if (asJson) line(JSON.stringify(r, null, 2));
    else if (r.code !== 0) { line(`失败：${r.message}`); process.exitCode = 1; }
    else {
      line(r.message);
      if (r.data.diffs.length) {
        line('  品牌/渠道                     科目           模板值        引擎值        差额');
        for (const x of r.data.diffs.slice(0, 40)) {
          line(`  ${(x.brand + '/' + x.channel).padEnd(28)} ${x.item.padEnd(12)} ${String(fmt(x.expect)).padStart(12)} ${String(fmt(x.got)).padStart(12)} ${String(fmt(x.delta)).padStart(12)}`);
        }
      }
    }
  } else if (flag('gaps')) {
    const r = mod.coverage(setId, { period });
    if (asJson) line(JSON.stringify(r, null, 2));
    else if (r.code !== 0) { line(`失败：${r.message}`); process.exitCode = 1; }
    else {
      line(`${r.data.period} 数据来源分布：`);
      for (const b of r.data.byBasis) line(`  ${String(b.basis || '未标注').padEnd(10)} ${String(b.n).padStart(4)} 条   ${fmt(b.amount)}`);
      line('');
      line(r.message);
      for (const g of (r.data.gaps || []).slice(0, 40)) line(`  - ${g.brand}/${g.channel} 未取到 ${g.label}`);
      if (r.data.zeros?.length) {
        line(`\n为 0 的科目（需确认是真 0 还是漏取）${r.data.zeros.length} 项：`);
        r.data.zeros.slice(0, 20).forEach((z) => line(`  - ${z.brand}/${z.channel} ${z.label} = 0`));
      }
    }
  } else {
    let p = period;
    if (!p) {
      const last = get(`SELECT MAX(substr(period,1,7)) p FROM fin_pnl_lines WHERE set_id = ?`, setId);
      p = last?.p || '';
    }
    if (!p) { line('还没有损益数据，先跑 --import=<损益表.xlsx>'); process.exitCode = 1; }
    else {
      const r = mod.computePnl(setId, { period: p, brand: val('brand') });
      if (asJson) line(JSON.stringify(r, null, 2));
      else if (r.code !== 0) { line(`失败：${r.message}`); process.exitCode = 1; }
      else printPnl(r.data);
    }
  }
} catch (e) {
  line(`执行失败：${e.message}`);
  process.exitCode = 1;
}
