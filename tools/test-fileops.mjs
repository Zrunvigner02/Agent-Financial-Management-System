#!/usr/bin/env node
/**
 * test-fileops —— 智能体文件能力测试（临时库，不碰真实账套）
 *
 *   node tools/test-fileops.mjs
 *
 * 覆盖：附件列表、OCR 状态自检与缺引擎时的清晰报错、附件转格式（内置通道）、
 *       非法目标格式拦截、转换产物可下载。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-fileops-'));
process.env.ZD_DB_PATH = path.join(tmp, 'test.db');

const att = await import('../backend/attachment.mjs');
const fileops = await import('../backend/fileops.mjs');
const ocr = await import('../backend/ocr.mjs');

const SET = 85;
let pass = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name} — ${e.message}`); process.exitCode = 1; }
};

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const csv = '日期,摘要,金额\n2026-11-01,收款,100\n2026-11-02,付款,60\n';

let attachmentId = 0;

await check('上传 CSV 后可按账套列出', () => {
  const r = att.readAttachment({ name: '流水.csv', content: b64(csv), set_id: SET, source: 'chat' });
  attachmentId = r.id || 0;
  const list = fileops.attachmentList(SET, { limit: 10 });
  assert.equal(list.code, 0);
  assert.ok(list.data.count >= 1);
  assert.ok(list.data.items.some((x) => x.name === '流水.csv'));
});

await check('格式能力自检：返回可转目标与 OCR 状态', () => {
  const r = fileops.supportedFormats();
  assert.equal(r.code, 0);
  assert.ok(Array.isArray(r.data.builtin));
  assert.ok(r.data.builtin.includes('xlsx'));
  assert.ok(r.data.ocr && typeof r.data.ocr.mode === 'string');
});

await check('附件转 xlsx（内置通道）产出可下载文件', async () => {
  const id = attachmentId || fileops.attachmentList(SET, { limit: 1 }).data.items[0]?.id;
  const r = await fileops.convertFile(SET, { attachment_id: id, to: 'xlsx' });
  assert.equal(r.code, 0, r.message);
  assert.match(r.data.output, /\.xlsx$/);
  assert.match(r.data.download, /\/api\/export\/download/);
});

await check('非法目标格式被拒', async () => {
  const r = await fileops.convertFile(SET, { attachment_id: attachmentId, to: 'exe' });
  assert.equal(r.code, 1);
});

await check('找不到文件时给出明确提示', async () => {
  const r = await fileops.convertFile(SET, { name: '不存在.csv', to: 'xlsx' });
  assert.equal(r.code, 1);
  assert.match(r.message, /找不到/);
});

await check('OCR：非图片文件直接拒绝并说明原因', async () => {
  const r = await fileops.ocrFile(SET, { name: '流水.csv' });
  assert.equal(r.code, 1);
  assert.match(r.message, /不是图片/);
});

await check('OCR：缺引擎时给出可操作的提示', async () => {
  const st = ocr.status();
  if (st.local.available || st.api.configured) {
    console.log('     （本机已装引擎，跳过缺引擎断言）');
    return;
  }
  assert.match(st.hint, /tesseract|OCR_API_KEY/);
});

console.log(`\n文件能力测试：${pass} PASS`);
