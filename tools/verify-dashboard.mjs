import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:5173';
const PERIOD = process.env.VERIFY_PERIOD || '2026-11';
const token = JSON.parse(fs.readFileSync(path.join(ROOT, '.local/local-session.json'), 'utf8')).token;
const headers = { authorization: `Bearer ${token}`, 'x-set-id': '85', 'content-type': 'application/json' };

const NAMES = [
  'capital', 'revenue', 'cost', 'profit', 'expense', 'tax', 'ar', 'ap',
  'capital-detail', 'ar-aging', 'ap-aging',
];

const report = { at: new Date().toISOString(), base: BASE, period: PERIOD, results: [] };
for (const name of NAMES) {
  try {
    const res = await fetch(`${BASE}/api/dashboard/${name}?period=${PERIOD}`, {
      headers, signal: AbortSignal.timeout(20000),
    });
    const j = await res.json();
    const d = j.data || {};
    const row = {
      name, status: res.status, code: j.code, found: d.found,
      total: d.total ?? null,
      month: d.month ?? d.revenue?.month ?? d.profit?.month ?? null,
      keys: Object.keys(d).length,
    };
    report.results.push(row);
    console.log(`${row.code === 0 && row.found ? 'PASS' : 'FAIL'} ${name} — code=${row.code} found=${row.found} total=${row.total} month=${row.month} keys=${row.keys}`);
  } catch (e) {
    report.results.push({ name, error: e.message });
    console.log(`FAIL ${name} — ${e.message}`);
  }
}
report.passed = report.results.filter((r) => r.code === 0 && r.found === true).length;
report.summary = `${report.passed}/${NAMES.length} sections OK`;
fs.writeFileSync(path.join(ROOT, 'analysis/dashboard-verify.json'), JSON.stringify(report, null, 2));
console.log(`\n=== ${report.summary} ===`);
