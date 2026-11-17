#!/usr/bin/env node
/**
 * CLI 入口：解析 .xls 并打印前几行。
 * 实现已下沉到 backend/xls.mjs，保证后端与工具共用同一解析器。
 *
 *   node tools/xls-read.mjs <file.xls>
 */
export { readXlsBuffer, readXlsFile, xlsToTable } from '../backend/xls.mjs';

import { readXlsFile } from '../backend/xls.mjs';

if (process.argv[1] && process.argv[1].endsWith('xls-read.mjs')) {
  const f = process.argv[2];
  if (!f) {
    console.error('用法：node tools/xls-read.mjs <file.xls>');
    process.exit(1);
  }
  const sheets = readXlsFile(f);
  for (const s of sheets) {
    console.log(`\n=== ${s.name} rows=${s.grid.length}`);
    for (const row of s.grid.slice(0, 12)) {
      console.log(row.map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)).join(' | ').slice(0, 220));
    }
  }
}
