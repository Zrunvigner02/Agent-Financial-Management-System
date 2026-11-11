/**
 * 清空本地库里的演示/冒烟测试凭证，让看板回到「未导入数据」的全零状态。
 * 默认 dry-run 只列出将删除的内容；加 --apply 才真正删除（删前自动备份 DB）。
 * 用法: node tools/reset-demo-data.mjs [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'backend', 'data', 'jinli.db');
const APPLY = process.argv.includes('--apply');

if (!fs.existsSync(DB)) {
  console.error('数据库不存在:', DB);
  process.exit(1);
}

const db = new DatabaseSync(DB);
const vouchers = db.prepare(`
  SELECT v.id, v.date, v.no, v.status, v.creator,
         (SELECT COUNT(*) FROM voucher_entries e WHERE e.voucher_id = v.id) AS lines,
         (SELECT SUM(e.debit) FROM voucher_entries e WHERE e.voucher_id = v.id) AS debit
  FROM vouchers v ORDER BY v.id`).all();
const closings = db.prepare('SELECT COUNT(*) AS n FROM closings').get().n;

console.log(`数据库: ${DB}`);
console.log(`凭证 ${vouchers.length} 张 / 结账记录 ${closings} 条`);
for (const v of vouchers) {
  console.log(`  #${v.id} ${v.date} 记-${v.no} ${v.status} 借方 ${v.debit ?? 0} 元 / ${v.lines} 行 (${v.creator})`);
}

if (!APPLY) {
  console.log('\n[dry-run] 未改动。确认后加 --apply 执行（自动备份）。');
  db.close();
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = path.join(ROOT, 'backend', 'data', `jinli.db.bak-${stamp}`);
db.close();
fs.copyFileSync(DB, backup);
console.log(`\n已备份 -> ${backup} (${fs.statSync(backup).size} bytes)`);

const w = new DatabaseSync(DB);
w.exec('BEGIN');
try {
  w.exec('DELETE FROM voucher_entries');
  w.exec('DELETE FROM vouchers');
  w.exec('DELETE FROM closings');
  w.exec("DELETE FROM sqlite_sequence WHERE name IN ('vouchers','voucher_entries')");
  w.exec('COMMIT');
} catch (err) {
  w.exec('ROLLBACK');
  w.close();
  console.error('清理失败，已回滚:', err.message);
  process.exit(1);
}
const left = w.prepare('SELECT COUNT(*) AS n FROM vouchers').get().n;
w.close();
console.log(`已清理，剩余凭证 ${left} 张；看板各指标将归零（数据来自凭证实时汇总）。`);
