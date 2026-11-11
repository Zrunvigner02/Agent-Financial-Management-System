import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:5173';
const token = JSON.parse(fs.readFileSync(path.join(ROOT, '.local/session.json'), 'utf8')).token;

const ENDPOINTS = [
  '/api/auth/sets',
  '/api/auth/accounts',
  '/api/auth/roles',
  '/api/sets/enabled',
  '/api/tokens',
  '/api/roles',
  '/api/accounts',
  '/api/subjects',
  '/api/vouchers',
  '/api/ledger/balance',
  '/api/dashboard/overview',
  '/api/dashboard/biz-settings',
  '/api/report/balance-sheet',
  '/api/auxiliaries',
  '/api/invoices',
  '/api/agent/sessions',
  '/api/agent/llm-config',
  '/api/agent/skills',
  '/api/agent/my-rules',
];

function shape(v, depth = 0) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) {
    return { kind: 'array', length: v.length, sample: v.length ? shape(v[0], depth + 1) : null };
  }
  if (typeof v === 'object') {
    if (depth >= 2) return { kind: 'object', keys: Object.keys(v).slice(0, 40) };
    return {
      kind: 'object',
      fields: Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shape(x, depth + 1)])),
    };
  }
  return typeof v;
}

const report = { base: BASE, probed_at: new Date().toISOString(), endpoints: [] };
let setId = '';

for (const ep of ENDPOINTS) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (setId) headers['x-set-id'] = String(setId);
  try {
    const res = await fetch(BASE + ep, { headers, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
    const data = body.data ?? body;
    report.endpoints.push({
      path: ep,
      status: res.status,
      code: body.code,
      message: body.message,
      data_shape: shape(data),
    });
    if (ep === '/api/auth/sets') {
      const list = Array.isArray(data) ? data : Array.isArray(data?.sets) ? data.sets : Array.isArray(data?.list) ? data.list : [];
      setId = list[0]?.id ?? '';
    }
    console.log(`${res.status} ${ep} code=${body.code ?? '-'} data=${Array.isArray(data) ? `array(${data.length})` : typeof data}`);
  } catch (e) {
    report.endpoints.push({ path: ep, error: e.message });
    console.log(`ERR ${ep} ${e.message}`);
  }
}

report.set_id_used = String(setId || '');
fs.writeFileSync(path.join(ROOT, 'analysis/api-probe.json'), JSON.stringify(report, null, 2));
console.log('set_id:', setId || '(none)');
console.log('report: analysis/api-probe.json');
