#!/usr/bin/env node
/**
 * 按「运行日期」算出该出哪些期间的报表
 *
 *   node tools/report-periods.mjs                # 用今天
 *   node tools/report-periods.mjs --date 2027-01-01
 *
 * 规则（与 AGENT 目录表的时间点一致）：
 *   每月 1 日        → 月报（上一个自然月）
 *   4/1 7/1 10/1 1/1 → 季报（上一个自然季度）
 *   7/1 1/1          → 半年报（上一个自然半年）
 *   1/1              → 年报（上一个自然年）
 *
 * 输出 JSON：{ date, items: [{ kind, label, from, to }] }
 */
const argv = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const dateStr = arg('--date') || new Date().toISOString().slice(0, 10);
const [y, m] = dateStr.split('-').map(Number);

const ym = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}`;

// 上一个自然月
const prev = new Date(y, m - 2, 1);
const pm = { y: prev.getFullYear(), m: prev.getMonth() + 1 };

const items = [];

// 月报：每月 1 日都出
items.push({ kind: '月报', label: ym(pm.y, pm.m), from: ym(pm.y, pm.m), to: ym(pm.y, pm.m) });

// 季报：季度末月的次月 1 日
if ([1, 4, 7, 10].includes(m)) {
  const qEnd = pm.m;                       // 3/6/9/12
  const qStart = qEnd - 2;
  const q = Math.ceil(qEnd / 3);
  items.push({
    kind: '季报', label: `${pm.y}Q${q}`,
    from: ym(pm.y, qStart), to: ym(pm.y, qEnd),
  });
}

// 半年报：7/1（H1）、1/1（H2）
if ([1, 7].includes(m)) {
  const h = pm.m === 6 ? 1 : 2;
  items.push({
    kind: '半年报', label: `${pm.y}H${h}`,
    from: ym(pm.y, h === 1 ? 1 : 7), to: ym(pm.y, h === 1 ? 6 : 12),
  });
}

// 年报：1/1 出上一年
if (m === 1) {
  items.push({
    kind: '年报', label: `${pm.y}`,
    from: ym(pm.y, 1), to: ym(pm.y, 12),
  });
}

console.log(JSON.stringify({ date: dateStr, items }, null, 2));
