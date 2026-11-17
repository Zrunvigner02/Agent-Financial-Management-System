/**
 * 智能体附件 · 全格式读取器（零外部依赖）
 *
 * 前端上传控件只认图片/PDF 且字段名是 image/file_name，旧后端按 name/content
 * 解构，导致所有附件都被判成「二进制格式，暂不识别」。这里统一兼容字段名，
 * 并把文本、表格、OOXML、PDF、RTF、图片等解析成智能体可直接录入的结构化内容。
 *
 * 输出同时满足两条消费链路：
 *  - 聊天窗口：data.text 被拼进输入框，交给 LLM 生成凭证 / 摘要
 *  - WorkBuddy MCP：read_attachment 返回 table.{columns,rows}，可逐行调用 create_voucher
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, get, all, now } from './store.mjs';
import { parseTable, unzipEntries, PARSE_EXTS } from './export.mjs';
import * as ocr from './ocr.mjs';
import { xlsToTable } from './xls.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 新布局：data/attachments/<账套>/<YYYY-MM>/，随 data 一起备份 */
const ATTACH_ROOT = path.join(ROOT, 'data', 'attachments');
/* 旧布局：保留只读兼容，不再写入 */
const LEGACY_DIR = path.join(ROOT, '.local', 'attachments');
const ATTACH_DIR = ATTACH_ROOT;
export const MAX_SIZE = 20 * 1024 * 1024;
const MAX_TEXT = 12000;
const MAX_ROWS = 200;

const TEXT_EXTS = ['txt', 'text', 'log', 'csv', 'tsv', 'md', 'markdown', 'json', 'xml', 'html', 'htm',
  'yaml', 'yml', 'ini', 'conf', 'sql', 'srt', 'vcf', 'ics', 'py', 'js', 'mjs', 'css', 'bat', 'sh'];
const TABLE_EXTS = ['csv', 'tsv', 'txt', 'json', 'md', 'markdown', 'html', 'htm', 'xlsx'];
const OOXML_EXTS = ['docx', 'docm', 'pptx', 'xlsx', 'xlsm', 'odt', 'ods', 'odp', 'epub'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'heic'];
const OTHER_BINARY = ['pdf', 'rtf', 'xls', 'xlsm', 'doc', 'ppt', 'zip', '7z', 'rar'];

export const SUPPORTED_EXTS = [...new Set([
  ...TEXT_EXTS, ...TABLE_EXTS, ...OOXML_EXTS, ...IMAGE_EXTS, ...OTHER_BINARY,
])];

const safeName = (n) => path.basename(String(n || 'attachment'))
  .replace(/[^\w.\-\u4e00-\u9fa5()（） ]/g, '_').slice(0, 120) || 'attachment';
const extOf = (n) => path.extname(String(n || '')).toLowerCase().replace(/^\./, '');

/* ---------------- 通用工具 ---------------- */

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    const b = Buffer.from(buf.slice(2));
    for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
    return b.toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return Buffer.from(buf.slice(2)).swap16().toString('utf16le');
  }
  const b = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF ? buf.slice(3) : buf;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch {
    try { return new TextDecoder('gbk').decode(b); }
    catch { return b.toString('latin1'); }
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function xmlToText(xml) {
  return decodeEntities(String(xml)
    .replace(/<w:tab[^>]*\/>|<w:br[^>]*\/>|<text:tab[^>]*\/>|<text:line-break[^>]*\/>/gi, '\t')
    .replace(/<a:br[^>]*\/>/gi, '\n')
    .replace(/<\/(?:w:tc|table:table-cell|td|th)>/gi, ' | ')
    .replace(/<\/(?:w:p|text:p|text:h|p|li|tr|table:table-row|div|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .split('\n').map((l) => l.replace(/[ \t|]+$/g, '').trim())
    .filter((l) => l && l !== '|').join('\n');
}

function xmlToRows(xml) {
  const rows = [];
  const trRe = /<(?:w:tr|table:table-row|tr)\b[^>]*>([\s\S]*?)<\/(?:w:tr|table:table-row|tr)>/gi;
  const tdRe = /<(?:w:tc|table:table-cell|td|th)\b[^>]*>([\s\S]*?)<\/(?:w:tc|table:table-cell|td|th)>/gi;
  for (const tr of xml.matchAll(trRe)) {
    const cells = [...tr[1].matchAll(tdRe)].map((c) => xmlToText(c[1]).replace(/\n/g, ' ').trim());
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function asTable(headers, rows) {
  const columns = headers.map((h, i) => ({ key: String(h || `列${i + 1}`), label: String(h || `列${i + 1}`), type: 'text' }));
  const data = rows.map((r) => {
    const o = {};
    columns.forEach((c, i) => { o[c.key] = String(r[i] ?? ''); });
    return o;
  });
  return { columns, rows: data };
}

function tableToMarkdown(table, limit = MAX_ROWS) {
  if (!table || !table.columns?.length) return '';
  const head = `| ${table.columns.map((c) => c.label).join(' | ')} |`;
  const sep = `| ${table.columns.map(() => '---').join(' | ')} |`;
  const body = table.rows.slice(0, limit).map((r) => `| ${table.columns.map((c) => String(r[c.key] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
  const more = table.rows.length > limit ? `\n（仅展示前 ${limit} 行，共 ${table.rows.length} 行；完整数据可通过 MCP read_attachment 获取）` : '';
  return [head, sep, ...body].join('\n') + more;
}

/* ---------------- 各类解析器 ---------------- */

function readText(buf, ext) {
  const text = decodeText(buf);
  let table = null;
  if (TABLE_EXTS.includes(ext)) {
    try {
      const t = parseTable(buf, ext, `upload.${ext}`);
      table = { columns: t.columns, rows: t.rows };
    } catch { /* 非表格文本按纯文本处理 */ }
  }
  return { text, table, engine: table ? `table-${ext}` : `text-${ext}` };
}

function readOoxml(buf, ext) {
  const files = unzipEntries(buf);
  const names = Object.keys(files);
  let xml = '';
  if (ext === 'docx' || ext === 'docm') xml = files['word/document.xml']?.toString('utf8') || '';
  else if (ext === 'odt' || ext === 'ods' || ext === 'odp') xml = files['content.xml']?.toString('utf8') || '';
  else if (ext === 'pptx' || ext === 'ppt') {
    xml = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]))
      .map((n, i) => `第 ${i + 1} 页\n${xmlToText(files[n].toString('utf8'))}`).join('\n\n');
  }   else if (ext === 'epub') {
    xml = names.filter((n) => /\.(x?html|htm)$/i.test(n)).slice(0, 20)
      .map((n) => xmlToText(files[n].toString('utf8'))).join('\n\n');
  } else if (ext === 'xlsm' || ext === 'xlsx') {
    xml = files['xl/worksheets/sheet1.xml']?.toString('utf8') || '';
  }
  if (!xml && (ext === 'docx' || ext === 'odt' || ext === 'ods' || ext === 'xlsm')) {
    xml = names.filter((n) => /\.xml$/i.test(n)).map((n) => xmlToText(files[n].toString('utf8'))).join('\n');
  }
  const rawText = ext === 'pptx' || ext === 'ppt' || ext === 'epub' ? xml : xmlToText(xml);
  let table = null;
  const rows = (ext === 'pptx' || ext === 'ppt' || ext === 'epub') ? [] : xmlToRows(xml);
  if (rows.length > 1) table = asTable(rows[0], rows.slice(1));
  const text = table ? `${rawText}\n\n【文档内表格】\n${tableToMarkdown(table)}` : rawText;
  return { text: text || `（${ext} 中未提取到文字，可能是扫描件或纯图片文档）`, table, engine: `ooxml-${ext}` };
}

function pdfString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const n = s[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] || '')) oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += n;
  }
  const bytes = Buffer.from(out, 'latin1');
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return Buffer.from(bytes.slice(2)).swap16().toString('utf16le');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { try { return new TextDecoder('gbk').decode(bytes); } catch { return out; } }
}

function readPdf(buf) {
  const latin = buf.toString('latin1');
  const parts = [];
  for (const m of latin.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let data = Buffer.from(m[1], 'latin1');
    try { data = zlib.inflateSync(data); } catch { /* 未压缩流 */ }
    const s = data.toString('latin1');
    if (!/(Tj|TJ)/.test(s)) continue;
    const strings = [];
    for (const sm of s.matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
      const v = pdfString(sm[1]).replace(/\s+/g, ' ').trim();
      if (v) strings.push(v);
    }
    if (strings.length) parts.push(strings.join(' '));
  }
  let text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const readable = text ? (text.match(/[\u4e00-\u9fa5a-zA-Z0-9]/g) || []).length / text.length : 0;
  const notes = [];
  if (!text) notes.push('PDF 未提取到文字层，可能是扫描件：已保留原件，可交给 WorkBuddy 用视觉能力识别，或先做 OCR。');
  else if (readable < 0.55) notes.push('PDF 使用嵌入字体/CID 编码，部分文字可能乱码；原件已保留，可用 WorkBuddy 视觉读取核对。');
  if (text) text = text.slice(0, MAX_TEXT);
  return { text, table: null, engine: 'pdf-text-layer', notes };
}

function readRtf(buf) {
  const text = decodeEntities(buf.toString('latin1')
    .replace(/\\par[d]?\b/g, '\n').replace(/\\tab\b/g, '\t')
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '').replace(/[{}]/g, ''))
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  return { text, table: null, engine: 'rtf-strip' };
}

/** 老式 .xls（OLE2/BIFF）：零依赖提取 UTF-16LE / ASCII 字符串，尽量还原单元格文本 */
function readXls(buf) {
  // 与导入管线共用同一个 BIFF8 解析器，避免「上传的 xls 只能读文字、导入却能读表」两套行为
  try {
    const { table, sheets, sheet } = xlsToTable(buf);
    if (table && table.rows.length) {
      const head = table.columns.map((c) => c.label).join(' | ');
      const body = table.rows.slice(0, 200).map((r) => table.columns.map((c) => r[c.key]).join(' | ')).join('\n');
      return {
        text: `【工作表：${sheet || sheets[0] || ''}】\n${head}\n${body}`,
        table, engine: 'biff8',
        notes: sheets.length > 1 ? [`该 .xls 共 ${sheets.length} 个工作表：${sheets.join('、')}（已解析第一个）`] : [],
      };
    }
  } catch { /* 退回字符串提取 */ }
  const parts = [];
  let cur = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const c = buf.readUInt16LE(i);
    const ok = (c >= 0x20 && c <= 0x7E) || (c >= 0x4E00 && c <= 0x9FFF)
      || (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF);
    if (ok) cur += String.fromCharCode(c);
    else { if (cur.length >= 3) parts.push(cur); cur = ''; }
  }
  if (cur.length >= 3) parts.push(cur);
  const ascii = buf.toString('latin1').match(/[\x20-\x7E]{5,}/g) || [];
  const text = [...new Set([...parts, ...ascii])].slice(0, 400).join('\n');
  return {
    text: text || '（.xls 中未提取到文字）', table: null, engine: 'biff-strings',
    notes: ['老式 .xls 解析失败，仅提取文字片段；建议另存为 .xlsx 后重试。'],
  };
}

function readBinaryFallback(buf, ext) {
  const strings = (buf.toString('latin1').match(/[\x20-\x7E]{6,}/g) || []).slice(0, 200);
  const utf16 = decodeText(buf);
  const cn = (utf16.match(/[\u4e00-\u9fa5]{2,}/g) || []).slice(0, 100);
  return {
    text: [...new Set([...cn, ...strings])].join('\n').slice(0, MAX_TEXT), table: null,
    engine: 'binary-strings',
    notes: [`.${ext} 未做专用解析，已从二进制提取可读字符串；原件已保留，可交给 WorkBuddy 读取。`],
  };
}

/* ---------------- 主入口 ---------------- */

/**
 * @param {object} input 兼容前端 {image,file_name,mime}、REST {content,name}、MCP {path}
 */
export function readAttachment(input = {}) {
  const name = safeName(input.file_name || input.filename || input.name || input.path || 'attachment');
  const ext = extOf(name);
  let buf;
  if (input.path) {
    if (!fs.existsSync(input.path)) throw new Error(`文件不存在：${input.path}`);
    buf = fs.readFileSync(input.path);
  } else {
    const b64 = String(input.image || input.content || input.base64 || input.data || '');
    if (!b64) throw new Error('附件内容为空');
    buf = Buffer.from(b64.replace(/^data:[^,]+,/, ''), 'base64');
  }
  if (!buf.length) throw new Error('附件内容为空');
  if (buf.length > MAX_SIZE) throw new Error(`附件超过 ${MAX_SIZE / 1024 / 1024}MB 上限`);

  // 内容哈希去重：同一文件重复上传只留一份，引用计数 +1
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const dup = get(
    `SELECT * FROM agent_attachments WHERE sha256 = ? AND (set_id = ? OR ? = 0) ORDER BY id DESC LIMIT 1`,
    sha, Number(input.set_id || 85), Number(input.set_id || 0),
  );
  let saved;
  let relPath;
  if (dup && dup.path && fs.existsSync(dup.path)) {
    saved = dup.path;
    relPath = dup.rel_path || '';
    try { run('UPDATE agent_attachments SET ref_count = COALESCE(ref_count, 1) + 1 WHERE id = ?', dup.id); } catch { /* 兼容旧库 */ }
  } else {
    const setDir = String(Number(input.set_id || 85) || 85);
    const month = new Date().toLocaleDateString('sv-SE').slice(0, 7);
    const dir = path.join(ATTACH_ROOT, setDir, month);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').slice(0, 16);
    const base = safeName(name).replace(/\.[^.]+$/, '') || 'attachment';
    const fname = `${stamp}_${base}_${sha.slice(0, 8)}${ext ? `.${ext}` : ''}`;
    saved = path.join(dir, fname);
    fs.writeFileSync(saved, buf);
    relPath = path.relative(ROOT, saved).replace(/\\/g, '/');
  }

  let r;
  try {
    if (OOXML_EXTS.includes(ext) && !TABLE_EXTS.includes(ext)) r = readOoxml(buf, ext);
    else if (ext === 'xlsx') r = readText(buf, ext);
    else if (ext === 'pdf') r = readPdf(buf);
    else if (ext === 'rtf') r = readRtf(buf);
    else if (ext === 'xls' || ext === 'doc' || ext === 'ppt') r = readXls(buf);
    else if (IMAGE_EXTS.includes(ext)) r = readImage(buf, ext, saved);
    else if (TEXT_EXTS.includes(ext) || PARSE_EXTS.includes(ext)) r = readText(buf, ext);
    else r = readBinaryFallback(buf, ext || 'bin');
  } catch (e) {
    r = { text: '', table: null, engine: 'error', notes: [`解析失败：${e.message}`] };
  }

  const notes = r.notes || [];
  const table = r.table || null;
  const rowCount = table ? table.rows.length : 0;
  const isInvoice = /(发票|invoice|税|价税合计|购买方|销售方|开票)/i.test(`${name} ${String(r.text).slice(0, 1200)}`);
  const header = [
    `【附件：${name}】`,
    `格式：.${ext || '未知'} · 读取引擎：${r.engine} · 大小：${buf.length} B${rowCount ? ` · 表格 ${rowCount} 行 × ${table.columns.length} 列` : ''}`,
    '以下内容来自文件真实解析，可直接用于录入凭证 / 核对数据：',
    '',
  ].join('\n');
  const body = table ? tableToMarkdown(table) : String(r.text || '').slice(0, MAX_TEXT);
  const text = `${header}${body || '（未提取到文字内容）'}${notes.length ? `\n\n【提示】\n${notes.map((n) => '· ' + n).join('\n')}` : ''}`.slice(0, MAX_TEXT);

  const sessionId = String(input.session_id || '');
  const setId = Number(input.set_id || 85);
  let newId = dup ? dup.id : null;
  if (!dup) {
    try {
      const ins = run(`INSERT INTO agent_attachments
           (session_id, set_id, name, ext, size, engine, path, rows, created_at, sha256, orig_name, rel_path, source, ref_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      sessionId, setId, name, ext, buf.length, r.engine, saved, rowCount, now(),
      sha, String(input.file_name || input.filename || input.name || name), relPath,
      String(input.source || 'chat'));
      newId = Number(ins.lastInsertRowid) || null;
    } catch { /* 留档失败不影响解析结果 */ }
  }

  const message = rowCount
    ? `已读取 ${name}：${r.engine}，${rowCount} 行 × ${table.columns.length} 列，可让智能体录入`
    : notes.length ? `已接收 ${name}（${notes[0]}）` : `已读取 ${name}：${r.engine}`;
  return {
    text, table, is_invoice: isInvoice, message,
    name, ext, size: buf.length, engine: r.engine, rows: rowCount,
    columns: table ? table.columns.map((c) => c.label) : [],
    saved_path: saved, saved_rel: relPath, sha256: sha, dedup: Boolean(dup), id: newId, notes, supported: SUPPORTED_EXTS,
  };
}

/**
 * 附件列表：默认按账套查库（含去重与来源），可选按月份过滤。
 * 旧目录 .local/attachments 里的历史文件仍会并进来（标记 legacy）。
 */
export function listAttachments(setId = 85, { limit = 50, period = '', source = '' } = {}) {
  const where = ['set_id = ?'];
  const params = [Number(setId) || 85];
  if (period) { where.push("substr(created_at, 1, 7) = ?"); params.push(period); }
  if (source) { where.push('source = ?'); params.push(source); }
  let rows = [];
  try {
    rows = all(`SELECT * FROM agent_attachments WHERE ${where.join(' AND ')}
      ORDER BY id DESC LIMIT ?`, ...params, Math.min(500, Number(limit) || 50));
  } catch { rows = []; }
  const items = rows.map((r) => ({
    id: r.id, name: r.orig_name || r.name, ext: r.ext, size: r.size,
    engine: r.engine, rows: r.rows, path: r.path, rel_path: r.rel_path || '',
    sha256: r.sha256 || '', ref_count: r.ref_count || 1, source: r.source || 'chat',
    session_id: r.session_id, created_at: r.created_at,
    exists: Boolean(r.path && fs.existsSync(r.path)),
  }));
  if (!period && items.length < limit && fs.existsSync(LEGACY_DIR)) {
    const legacy = fs.readdirSync(LEGACY_DIR).slice(-20).reverse().map((f) => {
      const st = fs.statSync(path.join(LEGACY_DIR, f));
      return { name: f.replace(/^\d+_/, ''), size: st.size, path: path.join(LEGACY_DIR, f),
        created_at: st.mtime.toISOString().slice(0, 19).replace('T', ' '), legacy: true };
    });
    return { items: [...items, ...legacy], count: items.length + legacy.length };
  }
  return { items, count: items.length };
}

/** 清理：删除超过 N 天且引用计数为 1 的附件（先预览后执行） */
export function pruneAttachments({ days = 180, dryRun = true, setId = 0 } = {}) {
  const cutoff = new Date(Date.now() - Number(days) * 86400000).toLocaleString('sv-SE').slice(0, 19);
  const where = ["created_at < ?", 'COALESCE(ref_count, 1) <= 1'];
  const params = [cutoff];
  if (setId) { where.push('set_id = ?'); params.push(Number(setId)); }
  let rows = [];
  try { rows = all(`SELECT * FROM agent_attachments WHERE ${where.join(' AND ')}`, ...params); } catch { rows = []; }
  let bytes = 0;
  const removed = [];
  for (const r of rows) {
    const size = Number(r.size || 0);
    bytes += size;
    removed.push({ id: r.id, name: r.orig_name || r.name, size, created_at: r.created_at, path: r.path });
    if (!dryRun) {
      try { if (r.path && fs.existsSync(r.path)) fs.unlinkSync(r.path); } catch { /* 文件已不在 */ }
      try { run('DELETE FROM agent_attachments WHERE id = ?', r.id); } catch { /* 忽略 */ }
    }
  }
  return { dry_run: Boolean(dryRun), days: Number(days), count: removed.length, bytes, files: removed };
}

/** MCP tools/call 入口 */
export function callTool(args = {}) {
  const r = readAttachment({
    path: args.path || '',
    name: args.name || args.file_name || '',
    content: args.content || args.image || '',
    session_id: args.session_id || '',
    set_id: args.set_id,
  });
  const { saved_path, supported, ...data } = r;
  return { code: 0, data: { ...data, saved_path, supported_count: supported.length } };
}
