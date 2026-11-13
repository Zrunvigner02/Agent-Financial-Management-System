#!/usr/bin/env node
/**
 * 附件清理：默认只预演，加 --apply 才真删。
 *
 *   node tools/prune-attachments.mjs                   # 预览 180 天前的单引用附件
 *   node tools/prune-attachments.mjs --days=90         # 改天数
 *   node tools/prune-attachments.mjs --days=90 --apply # 真正删除
 *   node tools/prune-attachments.mjs --set=85          # 只处理某个账套
 *
 * 只删「引用计数为 1」的附件；被多处引用的始终保留。
 */
import * as att from '../backend/attachment.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

const days = Number(args.days || 180);
const apply = args.apply === true || args.apply === '1';
const setId = Number(args.set || 0);

const r = att.pruneAttachments({ days, dryRun: !apply, setId });
const mb = (r.bytes / 1024 / 1024).toFixed(2);

console.log(`${apply ? '执行清理' : '预演（未删除）'}：${r.days} 天前、单引用附件 ${r.count} 个，合计 ${mb} MB`);
for (const f of r.files.slice(0, 20)) {
  console.log(`  ${f.created_at}  ${(f.size / 1024).toFixed(1)} KB  ${f.name}`);
}
if (r.files.length > 20) console.log(`  … 另有 ${r.files.length - 20} 个`);
if (!apply && r.count) console.log('\n确认无误后加 --apply 执行；被多份引用的附件不会被删除。');
