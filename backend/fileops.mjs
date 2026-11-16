/**
 * 智能体的文件操作能力：附件定位、OCR、格式转换、生成下载链接。
 * 复用 backend/export.mjs（含 Filee 兼容桥）与 backend/ocr.mjs，不重复实现转换逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, all } from './store.mjs';
import * as exp from './export.mjs';
import * as ocr from './ocr.mjs';
import * as att from './attachment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ok = (data, message = '') => ({ code: 0, message, data });
const fail = (message) => ({ code: 1, message, data: null });

function findAttachment(setId, { id, name, file }) {
  if (id) return get('SELECT * FROM agent_attachments WHERE id = ? AND set_id = ?', Number(id), setId);
  const wanted = String(name || file || '').trim();
  if (!wanted) return null;
  return get(`SELECT * FROM agent_attachments WHERE set_id = ? AND (orig_name = ? OR name = ? OR path = ? OR rel_path = ?)
              ORDER BY id DESC LIMIT 1`, setId, wanted, wanted, wanted, wanted);
}

export function attachmentList(setId, { period = '', limit = 20, source = '' } = {}) {
  const r = att.listAttachments(setId, { period, limit, source });
  return ok({ items: r.items, count: r.count, period: period || '' });
}

/** 附件（或任意本地文件）走 OCR */
export async function ocrFile(setId, { attachment_id, id, path: p, name, file } = {}) {
  let target = p || '';
  if (!target) {
    const row = findAttachment(setId, { id: attachment_id || id, name, file });
    if (row) target = row.path;
  }
  if (!target || !fs.existsSync(target)) return fail('找不到要识别的文件：请先上传，或用 attachment_id / path 指定');
  const ext = path.extname(target).slice(1).toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'].includes(ext)) {
    return fail(`.${ext} 不是图片；PDF/Office 有文字层时会直接抽取，无需 OCR`);
  }
  const r = await ocr.recognize(target, { ext });
  if (!r.ok) {
    const st = ocr.status();
    return fail(`${r.error}${st.hint ? `；${st.hint}` : ''}`);
  }
  return ok({ text: r.text, engine: r.engine, path: target, chars: r.text.length }, `已识别 ${r.text.length} 个字符（${r.engine}）`);
}

/** 把附件或导出目录里的文件转成目标格式，返回可直接点击的下载链接 */
export async function convertFile(setId, { attachment_id, id, file, name, to, token } = {}) {
  const target = String(to || '').toLowerCase().replace(/^\./, '');
  if (!target) return fail('请给出目标格式，例如 pdf / docx / xlsx / csv / png');
  if (!/^[a-z0-9]{2,6}$/.test(target)) return fail('目标格式不合法');

  let src = '';
  let stem = '';
  let ext = '';
  const row = findAttachment(setId, { id: attachment_id || id, name, file });
  if (row) {
    src = row.path;
    stem = path.basename(row.orig_name || row.name || 'file', path.extname(row.orig_name || row.name || 'file'));
    ext = row.ext;
  } else if (file) {
    const probe = path.join(exp.EXPORT_DIR, path.basename(String(file)));
    if (fs.existsSync(probe)) {
      src = probe;
      ext = path.extname(probe).slice(1).toLowerCase();
      stem = path.basename(probe, path.extname(probe));
    }
  }
  if (!src || !fs.existsSync(src)) return fail('找不到要转换的文件：请先上传附件，或给出导出目录里的文件名');
  if (exp.EXTRA_FORMATS && ![...exp.BUILTIN_FORMATS, ...exp.EXTRA_FORMATS].includes(target)) {
    return fail(`暂不支持转成 .${target}；支持：${[...exp.BUILTIN_FORMATS, ...exp.EXTRA_FORMATS].join(' / ')}`);
  }

  // exp.convert 只认导出目录里的文件名：先把源文件放进去（同名覆盖）
  fs.mkdirSync(exp.EXPORT_DIR, { recursive: true });
  const staged = path.join(exp.EXPORT_DIR, `${stem}.${ext || 'bin'}`);
  if (path.resolve(staged) !== path.resolve(src)) fs.copyFileSync(src, staged);

  const r = await exp.convert({ file: path.basename(staged), to: target });
  if (!r || r.ok === false) {
    return fail(r?.message || '转换失败');
  }
  const out = r.output || r.filename || '';
  const url = `/api/export/download?dir=converted&file=${encodeURIComponent(out)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  return ok({
    output: out, engine: r.engine || 'builtin', rows: r.rows || 0,
    download: url, from: ext, to: target,
  }, `已生成 ${out}（${target}）`);
}

export function supportedFormats() {
  return ok({
    ...exp.formats(),
    ocr: ocr.status(),
  });
}
