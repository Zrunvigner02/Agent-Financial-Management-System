import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const MEDIA_EXTS = 'png|jpe?g|gif|webp|bmp|svg|pdf|xlsx?|csv|docx?|pptx?|zip|mp4|md|txt';
function extractPaths(text) {
  const norm = String(text || '').replace(/\\\\/g, '\\');
  const out = new Set();
  const re1 = new RegExp(`([A-Za-z]:[\\\\/][^\\n\\r"'<>|{}]*?\\.(?:${MEDIA_EXTS}))`, 'gi');
  const re2 = new RegExp(`(/[a-z]/Users/[^\\n\\r"'<>|{}]*?\\.(?:${MEDIA_EXTS}))`, 'gi');
  let m;
  while ((m = re1.exec(norm))) out.add(m[1].trim());
  while ((m = re2.exec(norm))) out.add(m[1].replace(/^\/([a-z])\//i, '$1:\\').replace(/\//g, '\\'));
  return [...out];
}
const db = new DatabaseSync('backend/data/jinli.db');
const r = db.prepare('SELECT content FROM agent_messages WHERE id=35').get();
console.log('paths:', extractPaths(r.content));
for (const p of extractPaths(r.content)) console.log(p, 'exists=', fs.existsSync(p));
