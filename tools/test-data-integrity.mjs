/**
 * 数据严谨性专项回归（在隔离实例上跑，绝不写生产库）
 *
 *   node tools/isolated-run.mjs --with-backend --scripts tools/test-data-integrity.mjs
 *
 * 覆盖：前端「元→万」换算、前端新增凭证字段兼容（items + subject_id）、
 *       录入即校验（科目/金额/借贷）、看板与明细一致性、多轮数据核验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.LOCAL_BASE || 'http://127.0.0.1:8001';
const token = JSON.parse(fs.readFileSync(path.join(ROOT, '.local', 'local-session.json'), 'utf8')).token;
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-set-id': '85' };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const api = async (m, u, b) => {
  const r = await fetch(BASE + u, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b), signal: AbortSignal.timeout(15000) });
  return r.json();
};

// 1. 前端金额单位：本地后端返回「元」，1 万元必须显示 1.00 万而不是 0.01 万
const home = fs.readFileSync(path.join(ROOT, 'upstream', 'assets', 'HomeDashboard-DXZ5jjn_.js'), 'utf8');
const expr = home.match(/Number\(\((\w+)\/1e4\)\.toFixed\(2\)\)/);
check('首页存在「元→万」换算表达式', Boolean(expr), expr ? expr[0] : '未找到');
if (expr) {
  const fn = new Function(expr[1], `return Number((${expr[1]}/1e4).toFixed(2))`);
  check('10000 元 => 1.00 万', fn(10000) === 1, `实际 ${fn(10000)}`);
  check('15000 元 => 1.50 万（不丢小数）', fn(15000) === 1.5, `实际 ${fn(15000)}`);
  check('0 元 => 0.00 万', fn(0) === 0, `实际 ${fn(0)}`);
}
const allChunks = fs.readdirSync(path.join(ROOT, 'upstream', 'assets')).filter((f) => f.endsWith('.js'));
const legacy = allChunks.filter((f) => /Math\.(trunc|round|floor)\([^;]{0,100}?\/1e4\)\/100/
  .test(fs.readFileSync(path.join(ROOT, 'upstream', 'assets', f), 'utf8')));
check('全部前端 chunk 已无「按分换算」残留', legacy.length === 0, legacy.join(', ') || '0 处');

// 2. 前端新增凭证的字段形态（items + subject_id + 元金额）必须能落库
const subject = (await api('GET', '/api/subjects')).data?.find((s) => s.code === '1002');
const subject2 = (await api('GET', '/api/subjects')).data?.find((s) => s.code === '6001');
check('取到 1002 / 6001 科目', Boolean(subject && subject2), `1002.id=${subject?.id} 6001.id=${subject2?.id}`);
const payload = {
  date: '2026-11-11', voucher_no: 1,
  items: [
    { summary: '数据完整性回归', subject_id: subject?.id, debit: 12345.67, credit: 0 },
    { summary: '数据完整性回归', subject_id: subject2?.id, debit: 0, credit: 12345.67 },
  ],
};
const created = await api('POST', '/api/vouchers', payload);
check('前端 items + subject_id 形态创建成功', created.code === 0, created.code === 0 ? `id=${created.data.id} amount=${created.data.amount}` : created.message);
const vid = created.data?.id;
if (vid) {
  const got = await api('GET', `/api/vouchers/${vid}`);
  const es = got.data?.entries || [];
  check('分录科目代码正确落库', es[0]?.subject_code === '1002' && es[1]?.subject_code === '6001',
    es.map((e) => e.subject_code).join('/'));
  check('金额原样保存为元（未缩放）', es[0]?.debit === 12345.67 && es[1]?.credit === 12345.67,
    `借=${es[0]?.debit} 贷=${es[1]?.credit}`);
  const ov = await api('GET', '/api/dashboard/overview?period=2026-11');
  const cur = ov.data?.months?.find((m) => m.period === '2026-11');
  check('看板 revenue = 分录贷方实额', Math.abs(cur.revenue - 12345.67) < 0.005, `revenue=${cur.revenue}`);
  check('看板 profit = revenue - cost - expense', Math.abs(cur.profit - 12345.67) < 0.005, `profit=${cur.profit}`);
  const rev = await api('GET', '/api/dashboard/revenue?period=2026-11');
  check('收入分项与总览一致', Math.abs((rev.data?.revenue?.month ?? 0) - 12345.67) < 0.005, `month=${rev.data?.revenue?.month}`);
}

// 3. 录入即校验：不合法数据必须被拒绝，且不能产生脏数据
const bad = [
  ['不存在的科目', { ...payload, items: [{ summary: 'x', subject_id: 99999999, debit: 1, credit: 0 }, payload.items[1]] }],
  ['借贷不平衡', { ...payload, items: [{ ...payload.items[0], debit: 100 }, { ...payload.items[1], credit: 99 }] }],
  ['负数金额', { ...payload, items: [{ ...payload.items[0], debit: -1 }, { ...payload.items[1], credit: -1 }] }],
  ['三位小数', { ...payload, items: [{ ...payload.items[0], debit: 1.234 }, { ...payload.items[1], credit: 1.234 }] }],
  ['单行同时借贷', { ...payload, items: [{ ...payload.items[0], debit: 1, credit: 1 }, { ...payload.items[1], credit: 2 }] }],
];
for (const [name, body] of bad) {
  const r = await api('POST', '/api/vouchers', body);
  check(`拒绝：${name}`, r.code !== 0, r.message || `code=${r.code}`);
}

// 4. 多轮核验接口：有数据时也必须自洽，且三轮一致
const audit = await api('GET', '/api/data/audit?rounds=3&period=2026-11');
const a = audit.data;
check('数据核验接口三轮一致且全部通过', audit.code === 0 && a.ok && a.consistent && a.error_count === 0,
  `${a.passed}/${a.total} PASS, hash=${a.snapshotHash}`);
check('核验识别到 1 张凭证与 12345.67 元收入',
  a.snapshot?.counts?.vouchers === 1 && Math.abs(a.snapshot?.metrics?.revenue - 12345.67) < 0.005,
  `vouchers=${a.snapshot?.counts?.vouchers} revenue=${a.snapshot?.metrics?.revenue}`);

console.log(`\nRESULT ${pass}/${pass + fail} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
