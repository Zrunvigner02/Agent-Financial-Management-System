#!/usr/bin/env node
/**
 * 打印旺店通数据的最新/最早日期，供定时任务决定报表区间
 *
 *   node tools/wdt-latest.mjs
 * 输出：2026-11-19（只有一行，便于脚本直接使用）
 *   --json  输出 {min,max,days,rows}
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.ZD_DB_PATH || path.join(ROOT, 'backend', 'data', 'jinli.db');
const SET = Number(process.env.ZD_SET_ID || 85);

const db = new DatabaseSync(DB);
db.exec('PRAGMA query_only = ON');
const r = db.prepare(`SELECT MIN(date) a, MAX(date) b, COUNT(DISTINCT date) d, COUNT(*) n
  FROM sales_effective WHERE set_id = ? AND source = 'wdt'`).get(SET);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ min: r.a || '', max: r.b || '', days: r.d || 0, rows: r.n || 0 }));
} else {
  console.log(r.b || '');
}
