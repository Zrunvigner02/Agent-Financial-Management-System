import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, '.local');
const OUT = path.join(ROOT, 'backend', 'seed');
const BASE = process.env.UPSTREAM_BASE || 'https://jinliaicaiwu.top';
const token = JSON.parse(fs.readFileSync(path.join(LOCAL, 'session.json'), 'utf8')).token;
const setId = String(JSON.parse(fs.readFileSync(path.join(LOCAL, 'open-token.json'), 'utf8')).set_id || '85');
const PERIOD = process.env.EXPORT_PERIOD || '2026-11';

const NAMES = [
  'capital', 'revenue', 'cost', 'profit', 'expense', 'tax', 'ar', 'ap',
  'capital-detail', 'revenue-detail', 'cost-detail', 'profit-detail',
  'expense-detail', 'tax-detail', 'ar-detail', 'ap-detail',
  'ar-aging', 'ap-aging', 'profit-check',
];

const index = {};
for (const name of NAMES) {
  const url = `/api/dashboard/${name}?period=${PERIOD}`;
  try {
    const res = await fetch(BASE + url, {
      headers: { authorization: `Bearer ${token}`, 'x-set-id': setId, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json();
    fs.writeFileSync(path.join(OUT, `dash_${name}.json`), JSON.stringify(body, null, 2));
    const data = body.data;
    index[name] = {
      status: res.status, code: body.code, message: body.message,
      type: Array.isArray(data) ? 'array' : typeof data,
      length: Array.isArray(data) ? data.length : undefined,
      keys: data && !Array.isArray(data) ? Object.keys(data) : undefined,
    };
    console.log(`${name}: ${res.status} code=${body.code ?? '-'} ${index[name].type}${index[name].length !== undefined ? '(' + index[name].length + ')' : ''} keys=${(index[name].keys || []).slice(0, 12).join(',')}`);
  } catch (e) {
    index[name] = { error: e.message };
    console.log(`${name}: ERR ${e.message}`);
  }
}
fs.writeFileSync(path.join(OUT, '_dashboard_index.json'), JSON.stringify(index, null, 2));
console.log('saved to backend/seed/dash_*.json');
