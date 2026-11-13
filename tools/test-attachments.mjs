#!/usr/bin/env node
/**
 * test-attachments —— 附件保存与去重单元测试（临时数据库 + 临时目录，不碰真实账套）
 *
 *   node tools/test-attachments.mjs
 *
 * 覆盖：落盘位置（data/attachments/<账套>/<年月>/）、文件命名、内容哈希去重、
 *       引用计数、列表查询、按月份过滤、清理预演与执行。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-att-'));
process.env.ZD_DB_PATH = path.join(tmp, 'test.db');

const att = await import('../backend/attachment.mjs');
const store = await import('../backend/store.mjs');

const ROOT = process.cwd();
const SET = 85;
let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name} — ${e.message}`); process.exitCode = 1; }
};
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

check('上传后落到 data/attachments/账套/年月 目录，文件存在', () => {
  const r = att.readAttachment({ name: '流水.csv', content: b64('日期,摘要,金额\n2026-11-01,收款,100\n'), set_id: SET, source: 'chat' });
  assert.ok(fs.existsSync(r.saved_path), '文件应已落盘');
  const rel = path.relative(ROOT, r.saved_path).replace(/\\/g, '/');
  assert.match(rel, new RegExp(`^data/attachments/${SET}/\\d{4}-\\d{2}/`), `实际路径：${rel}`);
  assert.match(path.basename(r.saved_path), /_\w{8}\.csv$/);
  assert.equal(r.dedup, false);
});

check('同一文件重复上传去重：不再新增文件，引用计数 +1', () => {
  const content = b64('日期,摘要,金额\n2026-11-01,收款,100\n');
  const first = store.get('SELECT * FROM agent_attachments ORDER BY id DESC LIMIT 1');
  const r2 = att.readAttachment({ name: '流水-副本.csv', content, set_id: SET });
  assert.equal(r2.dedup, true);
  assert.equal(r2.saved_path, first.path);
  const row = store.get('SELECT * FROM agent_attachments WHERE id = ?', first.id);
  assert.equal(row.ref_count, 2);
});

check('元数据落库：哈希、原文件名、来源、相对路径', () => {
  const row = store.get('SELECT * FROM agent_attachments ORDER BY id DESC LIMIT 1');
  assert.equal(row.sha256.length, 64);
  assert.equal(row.source, 'chat');
  assert.match(row.rel_path, /^data\/attachments\//);
  assert.ok(row.orig_name);
});

check('列表查询：按账套返回、带存在性标记', () => {
  const r = att.listAttachments(SET, { limit: 20 });
  assert.ok(r.count >= 1);
  const item = r.items.find((x) => !x.legacy);
  assert.ok(item);
  assert.equal(item.exists, true);
  assert.equal(item.ref_count, 2);
});

check('按月份过滤：当月能查到，别的月份查不到', () => {
  const month = new Date().toLocaleDateString('sv-SE').slice(0, 7);
  assert.ok(att.listAttachments(SET, { period: month }).count >= 1);
  assert.equal(att.listAttachments(SET, { period: '1999-01' }).count, 0);
});

check('清理预演不删文件，执行才删（被多份引用的保留）', () => {
  att.readAttachment({ name: '一次性.csv', content: b64('a,b\n9,9\n'), set_id: SET });
  const single = store.get('SELECT * FROM agent_attachments WHERE ref_count = 1 ORDER BY id DESC LIMIT 1');
  assert.ok(single, '应存在单引用附件');

  const pre = att.pruneAttachments({ days: 0, dryRun: true });
  assert.equal(pre.dry_run, true);
  assert.ok(pre.count >= 1);
  assert.ok(fs.existsSync(single.path), '预演不应删除文件');

  const run1 = att.pruneAttachments({ days: 0, dryRun: false });
  assert.equal(run1.dry_run, false);
  assert.ok(run1.count >= 1);
  assert.equal(fs.existsSync(single.path), false, '执行后单引用文件应被删除');

  const shared = store.get('SELECT * FROM agent_attachments WHERE ref_count > 1 LIMIT 1');
  assert.ok(shared, '被多份引用的附件应保留');
  assert.ok(fs.existsSync(shared.path));
});

console.log(`\n附件测试：${pass} PASS`);
