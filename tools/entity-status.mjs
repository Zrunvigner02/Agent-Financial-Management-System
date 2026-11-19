#!/usr/bin/env node
/**
 * 实体生命周期命令行：不用进页面也能登记「谁离职了 / 哪个品牌不做了」
 *
 *   node tools/entity-status.mjs                       # 看全部
 *   node tools/entity-status.mjs --type staff           # 只看员工
 *   node tools/entity-status.mjs --stop staff 张三 --to 2026-11-16 --reason 离职
 *   node tools/entity-status.mjs --stop brand 世家 --to 2026-11 --reason 品牌不做了
 *   node tools/entity-status.mjs --resume staff 张三
 *
 * 只写状态，不动历史数据；默认账套 85，可用 --set 指定。
 */
import { DEFAULT_SET_ID } from '../backend/store.mjs';
import * as life from '../backend/lifecycle.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const SET = Number(val('--set', DEFAULT_SET_ID)) || DEFAULT_SET_ID;
const TYPE_LABEL = life.TYPE_LABEL;

function usage() {
  console.log(`用法：
  node tools/entity-status.mjs [--type staff|brand|channel|store]
  node tools/entity-status.mjs --stop <类型> <名称> --to 2026-11-16 [--reason 离职] [--no-prorate]
  node tools/entity-status.mjs --resume <类型> <名称>`);
}

function show(type = '') {
  const { items } = life.listStatus(SET, { type }).data;
  if (!items.length) return console.log('还没有停用记录（全部视为有效）。');
  const rows = items.map((x) => `${x.stopped ? '×' : '✓'} ${TYPE_LABEL[x.type] || x.type}  ${String(x.name).padEnd(10)} ${x.stopped ? `最后有效日 ${x.effective_to}` : '启用中'}  ${x.reason || ''}`);
  console.log(`账套 ${SET}：\n${rows.join('\n')}`);
}

const stopType = (() => {
  const i = argv.indexOf('--stop');
  return i >= 0 ? (argv[i + 1] || '').trim() : '';
})();
const resumeType = (() => {
  const i = argv.indexOf('--resume');
  return i >= 0 ? (argv[i + 1] || '').trim() : '';
})();

if (has('--help') || has('-h')) {
  usage();
} else if (stopType) {
  const name = (argv[argv.indexOf('--stop') + 2] || '').trim();
  const out = life.setStatus(SET, {
    type: stopType,
    name,
    action: 'stop',
    effective_to: val('--to') || val('--date'),
    reason: val('--reason', ''),
    prorate: !has('--no-prorate'),
  }, 'cli');
  console.log(out.code === 0 ? `✓ ${out.message}` : `✗ ${out.message}`);
  if (out.code === 0) show(stopType);
} else if (resumeType) {
  const name = (argv[argv.indexOf('--resume') + 2] || '').trim();
  const out = life.setStatus(SET, { type: resumeType, name, action: 'resume' }, 'cli');
  console.log(out.code === 0 ? `✓ ${out.message}` : `✗ ${out.message}`);
  if (out.code === 0) show(resumeType);
} else {
  show(val('--type', ''));
  console.log('\n登记：--stop staff 张三 --to 2026-11-16 --reason 离职');
}
