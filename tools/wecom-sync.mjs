#!/usr/bin/env node
/**
 * 企微缓存同步命令行。
 *
 *   node tools/wecom-sync.mjs                # 预览（默认，绝不写库）
 *   node tools/wecom-sync.mjs --apply        # 落库
 *   node tools/wecom-sync.mjs --verify       # 核对（重复检测 + 渠道/月度汇总）
 *   node tools/wecom-sync.mjs --only=jd_pdd_daily --apply
 *   node tools/wecom-sync.mjs --direct --apply   # 绕过后端直接写库（后端需停）
 *
 * 默认优先走后端 HTTP（避免与正在运行的后端抢 SQLite 写锁），
 * 后端未启动时自动降级为直接写库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.ZD_API_BASE || 'http://127.0.0.1:8000';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const val = (name, def = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const apply = flag('apply');
const verify = flag('verify');
const asJson = flag('json');
const direct = flag('direct');
const only = val('only');
const root = val('root');

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

const session = readJson(path.join(ROOT, '.local', 'local-session.json'));
const setId = Number(val('set', (readJson(path.join(ROOT, '.local', 'local-open-token.json')) || {}).set_id)) || 85;

async function callApi(pathname, payload) {
  if (!session?.token) throw new Error('缺少 .local/local-session.json');
  const res = await fetch(BASE + pathname, {
    method: payload ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-set-id': String(setId),
      'content-type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // 旧版后端会把未知路由返回成「暂未实现」的业务错误，这种情况要降级为直连，而不是当成同步失败
  if (json.code !== 0 && /未实现|未找到|Not Found/.test(String(json.message || ''))) {
    throw new Error(json.message || '接口不存在');
  }
  return json;
}

async function viaApi() {
  if (verify) return callApi('/api/enterprise/wecom/verify');
  return callApi('/api/enterprise/wecom/sync', { apply, only, root });
}

async function viaDirect() {
  const mod = await import('file:///' + path.join(ROOT, 'backend', 'wecom.mjs').replace(/\\/g, '/'));
  if (verify) return mod.verifyWecom(setId);
  return mod.syncWecom(setId, { apply, only, root, actor: 'cli' });
}

const line = (s = '') => process.stdout.write(s + '\n');

function printSync(r) {
  const d = r.data;
  line(`模式：${d.mode === 'apply' ? '落库' : '预览（未写库）'}   口径：${d.source}`);
  line(`缓存目录：${(d.roots || []).join('  |  ')}`);
  line(`扫描 ${d.scanned} 个文件 → 入库日报 ${d.accepted} 份，跳过 ${d.skipped}（已入账/旧快照），待接入 ${d.pending}，失败 ${d.failed}，仅登记 ${d.registered}`);
  line(`行级：新增 ${d.rows.new} / 修正 ${d.rows.updated} / 未变 ${d.rows.same}`);
  if (d.duplicates) line(`内容重复：${d.duplicates} 份（与已入账报表事实相同，已跳过）`);
  if (d.reconcile?.total) {
    const ad = d.reconcile.adopted || [];
    const rv = d.reconcile.review || [];
    line(`汇总校验：${d.reconcile.total} 项，一致 ${d.reconcile.ok}，已按汇总调整 ${ad.length}，待复核 ${rv.length}`);
    for (const a of ad.slice(0, 8)) line(`  ✓ ${a.month} ${a.channel} 汇总 ${a.summary} / 明细 ${a.detail} / 差异 ${a.diff}（已按汇总调整）`);
    for (const a of rv.slice(0, 8)) line(`  ! ${a.month} ${a.channel} 汇总 ${a.summary} / 明细 ${a.detail} / 差异 ${a.diff}（内嵌汇总与明细矛盾，未改数）`);
  }
  if (d.files.length) {
    line('');
    line('系列                 期间        文件                                    行数  新增  修正  未变  状态');
    for (const f of d.files) {
      line(`${String(f.series || '-').padEnd(20)} ${String(f.period || '-').padEnd(11)} ${String(f.name).slice(0, 38).padEnd(38)} ${String(f.rows).padStart(4)} ${String(f.new).padStart(5)} ${String(f.updated).padStart(5)} ${String(f.same).padStart(5)}  ${f.status}${f.note ? ' · ' + f.note : ''}`);
    }
  }
  line('');
  line(r.message);
}

function printVerify(r) {
  const d = r.data;
  line(`口径 ${d.source} 核对结果`);
  line('');
  line('渠道                          天数        销售额         退款        推广费   区间');
  for (const c of d.byChannel) {
    line(`${String(c.name).slice(0, 26).padEnd(26)} ${String(c.days).padStart(5)} ${String(c.amount).padStart(13)} ${String(c.refund).padStart(12)} ${String(c.fee).padStart(11)}   ${c.d1}~${c.d2}`);
  }
  if (d.byMonth.length) {
    line('');
    line('月度            天数        销售额         退款        推广费');
    for (const m of d.byMonth) {
      line(`${String(m.ym).padEnd(12)} ${String(m.days).padStart(5)} ${String(m.amount).padStart(13)} ${String(m.refund).padStart(12)} ${String(m.fee).padStart(11)}`);
    }
  }
  if (d.reconcile?.length) {
    const bad = d.reconcile.filter((r) => r.status !== 'ok');
    line('');
    line(`汇总校准台账：${d.reconcile.length} 条，其中不符 ${bad.length} 条`);
    for (const r of (bad.length ? bad : []).slice(0, 12)) {
      line(`  ${r.month} ${String(r.channel).padEnd(18)} 汇总 ${String(r.summary_amount).padStart(12)} / 明细 ${String(r.detail_amount).padStart(12)} / 差异 ${String(r.diff_amount).padStart(10)}`);
    }
  }
  if (d.duplicateFiles?.length) {
    line('');
    line(`已判重文件 ${d.duplicateFiles.length} 份（未重复入账）：`);
    for (const f of d.duplicateFiles.slice(0, 8)) line(`  · ${f.file_name}`);
  }
  line('');
  line(`重复自然键：${d.duplicate.length} 组${d.duplicate.length ? ' ← 需处理' : ''}`);
  for (const x of d.duplicate.slice(0, 10)) line(`  channel_id=${x.channel_id} ${x.date} ×${x.n}`);
  if (d.problems.length) {
    line('');
    d.problems.forEach((p) => line(`⚠ ${p}`));
  }
  line('');
  line(r.message);
}

try {
  let result;
  if (direct) {
    result = await viaDirect();
  } else {
    try {
      result = await viaApi();
    } catch (e) {
      line(`（HTTP 接口不可用：${e.message}。若后端未重启过，需重启后端才会加载 /api/enterprise/wecom/*；现改为直接读写数据库）`);
      result = await viaDirect();
    }
  }
  if (asJson) {
    line(JSON.stringify(result, null, 2));
  } else if (result.code !== 0) {
    line(`失败：${result.message}`);
    process.exitCode = 1;
  } else if (verify) {
    printVerify(result);
  } else {
    printSync(result);
  }
} catch (e) {
  line(`执行失败：${e.message}`);
  process.exitCode = 1;
}
