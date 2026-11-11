import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, '.local');
const OUT = path.join(ROOT, 'backend', 'seed');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:5173';
const token = JSON.parse(fs.readFileSync(path.join(LOCAL, 'session.json'), 'utf8')).token;
const setId = String(JSON.parse(fs.readFileSync(path.join(LOCAL, 'open-token.json'), 'utf8')).set_id || '85');

fs.mkdirSync(OUT, { recursive: true });

const SAMPLES = {
  sets_enabled: '/api/sets/enabled',
  subjects: '/api/subjects',
  vouchers: '/api/vouchers',
  dashboard_overview: '/api/dashboard/overview',
  dashboard_biz_settings: '/api/dashboard/biz-settings',
  ledger_balance: '/api/ledger/balance?period=2026-10',
  ledger_detail: '/api/ledger/detail?period=2026-10',
  roles: '/api/roles',
  organization_tree: '/api/organization/tree',
  auxiliaries: '/api/auxiliaries',
  invoices: '/api/invoices',
  closing_list: '/api/closing/list',
  agent_llm_config: '/api/agent/llm-config',
  agent_skills: '/api/agent/skills',
  agent_my_rules: '/api/agent/my-rules',
  agent_sessions: '/api/agent/sessions',
  tokens: '/api/tokens',
};

const index = {};
for (const [name, url] of Object.entries(SAMPLES)) {
  try {
    const res = await fetch(BASE + url, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-set-id': setId,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(25000),
    });
    const body = await res.json();
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(body, null, 2));
    const data = body.data;
    index[name] = {
      url,
      status: res.status,
      code: body.code,
      data_type: Array.isArray(data) ? 'array' : typeof data,
      length: Array.isArray(data) ? data.length : undefined,
      keys: data && !Array.isArray(data) ? Object.keys(data).slice(0, 30) : undefined,
      sample_keys: Array.isArray(data) && data[0] && typeof data[0] === 'object' ? Object.keys(data[0]).slice(0, 30) : undefined,
    };
    console.log(`${name}: ${res.status} code=${body.code ?? '-'} ${index[name].data_type}${index[name].length !== undefined ? '(' + index[name].length + ')' : ''}`);
  } catch (e) {
    index[name] = { url, error: e.message };
    console.log(`${name}: ERR ${e.message}`);
  }
}
fs.writeFileSync(path.join(OUT, '_index.json'), JSON.stringify(index, null, 2));
console.log('seed dir: backend/seed');
