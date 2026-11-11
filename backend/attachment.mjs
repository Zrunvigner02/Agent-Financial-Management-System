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
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, now } from './store.mjs';
import { parseTable, unzipEntries, PARSE_EXTS } from './export.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATTACH_DIR = path.join(ROOT, '.local', 'attachments');
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
    notes: ['老式 .xls 仅能提取文字片段；如需完整表格，请另存为 .xlsx 后重新上传。'],
  };
}

function imageStrings(buf, ext) {
  const found = [];
  const latin = buf.toString('latin1');
  if (ext === 'png') {
    for (const m of latin.matchAll(/(tEXt|iTXt|zTXt)([\s\S]{0,300}?)(?=IEND|IDAT|tEXt|iTXt|zTXt)/g)) {
      const s = m[2].replace(/[^\x20-\x7E\u4e00-\u9fa5]/g, ' ').trim();
      if (s.length > 2) found.push(s.slice(0, 120));
    }
  }
  for (const m of latin.matchAll(/[\x20-\x7E]{8,}/g)) {
    const s = m[0];
    if (/(comment|description|author|title|ocr|发票|金额|日期)/i.test(s)) found.push(s.slice(0, 160));
  }
  return [...new Set(found)].slice(0, 20).join('\n');
}

function tryOcr(filePath) {
  const cmd = process.env.ZD_OCR_CMD || '';
  if (!cmd) return null;
  try {
    const r = spawnSync(cmd, [filePath], { encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
    return r.status === 0 ? String(r.stdout || '').trim() : null;
  } catch { return null; }
}

function readImage(buf, ext, savedPath) {
  const meta = imageStrings(buf, ext);
  const ocr = tryOcr(savedPath);
  const notes = [];
  let text = meta || '';
  if (ocr) { text = `${meta ? meta + '\n\n' : ''}【OCR 识别】\n${ocr}`; }
  else {
    notes.push('图片没有文字层：本机未配置 OCR（可设环境变量 ZD_OCR_CMD 指向 tesseract 等命令）。原件已保存到 ' + savedPath + '，WorkBuddy 可直接读取该路径用视觉能力识别并录入。');
  }
  return {
    text: text || `（图片 ${ext} 已接收，暂无文字内容）`,
    table: null, engine: ocr ? 'image-ocr' : 'image-meta', notes,
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

  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  const stamp = Date.now();
  const saved = path.join(ATTACH_DIR, `${stamp}_${name}`);
  fs.writeFileSync(saved, buf);

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
  try {
    run(`INSERT INTO agent_attachments (session_id, set_id, name, ext, size, engine, path, rows, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId, setId, name, ext, buf.length, r.engine, saved, rowCount, now());
  } catch { /* 留档失败不影响解析结果 */ }

  const message = rowCount
    ? `已读取 ${name}：${r.engine}，${rowCount} 行 × ${table.columns.length} 列，可让智能体录入`
    : notes.length ? `已接收 ${name}（${notes[0]}）` : `已读取 ${name}：${r.engine}`;
  return {
    text, table, is_invoice: isInvoice, message,
    name, ext, size: buf.length, engine: r.engine, rows: rowCount,
    columns: table ? table.columns.map((c) => c.label) : [],
    saved_path: saved, notes, supported: SUPPORTED_EXTS,
  };
}

export function listAttachments(limit = 20) {
  // store.mjs 未导出 all()，这里直接列出留档目录（写入时同时落库 agent_attachments）
  try {
    return fs.readdirSync(ATTACH_DIR).slice(-limit).reverse().map((f) => {
      const st = fs.statSync(path.join(ATTACH_DIR, f));
      return { name: f.replace(/^\d+_/, ''), size: st.size, path: path.join(ATTACH_DIR, f), mtime: st.mtime.toISOString() };
    });
  } catch { return []; }
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
