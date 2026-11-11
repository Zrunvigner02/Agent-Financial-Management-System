#!/usr/bin/env node
/**
 * Filee CLI 协议兼容 · 本地零依赖格式转换桥
 *
 * 为什么不是真 Filee：D:\开源项目\Filee 是 C#/.NET 10 项目，本机没有 dotnet SDK、
 * 没有编译产物，LibreOffice/Pandoc 等外部引擎也未安装，无法在本机运行。
 * 因此保留 Filee 的进程级集成契约（spawn CLI、参数白名单、产物目录），
 * 用纯 Node 内置能力 + 本机 Pillow 实现同等的格式转换能力，零外部安装。
 *
 * 协议：
 *   node tools/filee-bridge.mjs convert <src> --to <ext> -o <outdir> [--overwrite]
 *   node tools/filee-bridge.mjs formats
 * 成功：stdout 输出 {"ok":true,"output":"xxx.pdf",...}，exit 0，产物写入 -o 目录
 * 失败：stdout/stderr 输出明确原因，exit 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseTable, zipStore, EXTRA_FORMATS, PARSE_EXTS } from '../backend/export.mjs';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];
const RENDER_SCRIPT = path.join(ROOT, 'tools', 'render_image.py');

const xml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const hx = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const headersOf = (t) => t.columns.map((c) => String(c.label ?? c.key));
const matrixOf = (t) => t.rows.map((r) => t.columns.map((c) => String(r[c.key] ?? '')));
const periodOf = (name) => (String(name).match(/\d{4}-(0[1-9]|1[0-2])/) || [new Date().toISOString().slice(0, 7)])[0];

function findPython() {
  const candidates = [
    process.env.FILEE_PYTHON,
    'D:/tools/Python311/python.exe',
    'C:/Users/Administrator/AppData/Local/Programs/Python/Python311/python.exe',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-c', 'import PIL;print(PIL.__version__)'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (r.status === 0 && !r.error) return c;
  }
  return null;
}

/* ---------------- 文本 / XML 类 ---------------- */

function renderTxt(t, meta) {
  const heads = headersOf(t);
  const rows = matrixOf(t);
  const widths = heads.map((h, i) => Math.max(h.length,
    ...rows.map((r) => (r[i] || '').length), 4));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(Math.min(widths[i], 40), ' ')).join(' | ');
  const bar = widths.map((w) => '-'.repeat(Math.min(w, 40))).join('-+-');
  return Buffer.from([
    `${t.title}  期间 ${meta.period}  生成 ${new Date().toLocaleString('zh-CN')}`,
    line(heads), bar,
    ...(rows.length ? rows.map(line) : ['（本期暂无数据）']),
    '',
  ].join('\r\n'), 'utf8');
}

function renderTsv(t) {
  const esc = (v) => String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from([
    headersOf(t).map(esc).join('\t'),
    ...matrixOf(t).map((r) => r.map(esc).join('\t')),
    '',
  ].join('\r\n'), 'utf8')]);
}

function renderXml(t, meta) {
  const cols = headersOf(t);
  const body = matrixOf(t).map((r) => '  <row>' + r.map((v, i) =>
    `<cell name="${xml(cols[i])}">${xml(v)}</cell>`).join('') + '</row>').join('\n');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<report title="${xml(t.title)}" period="${xml(meta.period)}" generated_at="${xml(new Date().toISOString())}">
<columns>${cols.map((c) => `<column>${xml(c)}</column>`).join('')}</columns>
<rows>
${body || '  <row><cell>（本期暂无数据）</cell></row>'}
</rows>
</report>
`, 'utf8');
}

function rtfText(s) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.charCodeAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') out += '\\' + ch;
    else if (code < 128 && code > 31) out += ch;
    else out += `\\u${code > 32767 ? code - 65536 : code}?`;
  }
  return out;
}

function renderRtf(t, meta) {
  const rows = [headersOf(t), ...matrixOf(t)];
  const body = rows.map((r) => r.map(rtfText).join('\\tab ') + '\\par').join('\n');
  return Buffer.from(`{\\rtf1\\ansi\\ansicpg936\\deff0\\uc1
{\\fonttbl{\\f0\\fnil Microsoft YaHei;}{\\f1\\fnil SimSun;}}
\\viewkind4\\pard\\f0\\fs32\\b ${rtfText(t.title)}\\b0\\par
\\fs18 ${rtfText('振颜丽舍 · 妆点管账 ｜ 期间 ' + meta.period + ' ｜ ' + new Date().toLocaleString('zh-CN'))}\\par
\\par
${body || '（本期暂无数据）\\par'}
}`, 'ascii');
}

function renderSvg(t, meta) {
  const cols = headersOf(t), rows = matrixOf(t);
  const colW = cols.map((h, i) => Math.min(260, Math.max(110,
    h.length * 14 + 24, ...rows.slice(0, 60).map((r) => (r[i] || '').length * 13 + 24))));
  const width = colW.reduce((a, b) => a + b, 0) + 48;
  const rowH = 32, headH = 38, top = 92;
  const height = top + headH + Math.max(rows.length, 1) * rowH + 44;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<rect width="100%" height="6" fill="#742a54"/>`,
    `<text x="24" y="40" font-family="Microsoft YaHei,sans-serif" font-size="24" fill="#742a54">${hx(t.title)}</text>`,
    `<text x="24" y="66" font-family="Microsoft YaHei,sans-serif" font-size="12" fill="#96667e">${hx('振颜丽舍 · 妆点管账 ｜ ' + meta.period + ' ｜ ' + new Date().toLocaleString('zh-CN'))}</text>`,
    `<rect x="24" y="${top}" width="${width - 48}" height="${headH}" fill="#f8e7ef"/>`,
  ];
  let x = 24;
  cols.forEach((h, i) => {
    parts.push(`<text x="${x + 10}" y="${top + 25}" font-family="Microsoft YaHei,sans-serif" font-size="14" fill="#742a54">${hx(h)}</text>`);
    x += colW[i];
  });
  (rows.length ? rows : [['（本期暂无数据）'].concat(cols.slice(1).map(() => ''))])
    .forEach((r, ri) => {
      const y = top + headH + ri * rowH;
      if (ri % 2) parts.push(`<rect x="24" y="${y}" width="${width - 48}" height="${rowH}" fill="#fffbfd"/>`);
      parts.push(`<line x1="24" y1="${y + rowH}" x2="${width - 24}" y2="${y + rowH}" stroke="#ead9e2"/>`);
      let cx = 24;
      colW.forEach((w, i) => {
        const txt = String(r[i] ?? '');
        const clipped = txt.length > Math.floor(w / 13) ? txt.slice(0, Math.floor(w / 13)) + '…' : txt;
        parts.push(`<text x="${cx + 10}" y="${y + 21}" font-family="Microsoft YaHei,sans-serif" font-size="13" fill="#4a2438">${hx(clipped)}</text>`);
        cx += w;
      });
    });
  parts.push('</svg>');
  return Buffer.from(parts.join('\n'), 'utf8');
}

/* ---------------- OOXML / ODF 类（zip + XML，全部 store 模式） ---------------- */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const pkgRels = (target) => `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;

function renderDocx(t, meta) {
  const cols = headersOf(t), rows = matrixOf(t);
  const cell = (v) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">${xml(v)}</w:t></w:r></w:p></w:tc>`;
  const tr = (r) => `<w:tr>${r.map(cell).join('')}</w:tr>`;
  const doc = `${XML_DECL}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>${xml(t.title)}</w:t></w:r></w:p>
<w:p><w:r><w:t>${xml('振颜丽舍 · 妆点管账 ｜ 期间 ' + meta.period + ' ｜ ' + new Date().toLocaleString('zh-CN'))}</w:t></w:r></w:p>
<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>
<w:top w:val="single" w:sz="4" w:color="EAD9E2"/><w:bottom w:val="single" w:sz="4" w:color="EAD9E2"/>
<w:left w:val="single" w:sz="4" w:color="EAD9E2"/><w:right w:val="single" w:sz="4" w:color="EAD9E2"/>
<w:insideH w:val="single" w:sz="4" w:color="EAD9E2"/><w:insideV w:val="single" w:sz="4" w:color="EAD9E2"/>
</w:tblBorders></w:tblPr>
${tr(cols)}${(rows.length ? rows : [['（本期暂无数据）'].concat(cols.slice(1).map(() => ''))]).map(tr).join('\n')}
</w:tbl><w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>
</w:body></w:document>`;
  return zipStore([
    { name: '[Content_Types].xml', data: `${XML_DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: '_rels/.rels', data: pkgRels('word/document.xml') },
    { name: 'word/_rels/document.xml.rels', data: `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>` },
    { name: 'word/document.xml', data: doc },
  ]);
}

const odfManifest = (mime, extra = '') => `${XML_DECL}
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${mime}"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
${extra}</manifest:manifest>`;
const odfStyles = `${XML_DECL}
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"><office:styles/></office:document-styles>`;

function odfTable(t) {
  const cols = headersOf(t), rows = matrixOf(t);
  const cells = (r) => r.map((v) => `<table:table-cell office:value-type="string"><text:p>${xml(v)}</text:p></table:table-cell>`).join('');
  const tr = (r) => `<table:table-row>${cells(r)}</table:table-row>`;
  return `<table:table table:name="${xml(t.title)}"><table:table-column table:number-columns-repeated="${cols.length}"/>
${tr(cols)}${(rows.length ? rows : [['（本期暂无数据）'].concat(cols.slice(1).map(() => ''))]).map(tr).join('\n')}
</table:table>`;
}

function renderOdf(t, meta, kind) {
  const mime = kind === 'ods'
    ? 'application/vnd.oasis.opendocument.spreadsheet'
    : 'application/vnd.oasis.opendocument.text';
  const container = kind === 'ods' ? 'spreadsheet' : 'text';
  const inner = kind === 'ods'
    ? odfTable(t)
    : `<text:h text:outline-level="1">${xml(t.title)}</text:h><text:p>${xml('振颜丽舍 · 妆点管账 ｜ 期间 ' + meta.period)}</text:p>${odfTable(t)}`;
  const content = `${XML_DECL}
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:${container}>${inner}</office:${container}></office:body></office:document-content>`;
  // mimetype 必须是 zip 第一项且不压缩（zipStore 全 store，符合 ODF 规范）
  return zipStore([
    { name: 'mimetype', data: Buffer.from(mime, 'ascii') },
    { name: 'META-INF/manifest.xml', data: odfManifest(mime) },
    { name: 'content.xml', data: content },
    { name: 'styles.xml', data: odfStyles },
  ]);
}

const EXTRA_RENDERERS = {
  txt: renderTxt,
  tsv: renderTsv,
  xml: (t, m) => renderXml(t, m),
  rtf: (t, m) => renderRtf(t, m),
  svg: (t, m) => renderSvg(t, m),
  docx: (t, m) => renderDocx(t, m),
  ods: (t, m) => renderOdf(t, m, 'ods'),
  odt: (t, m) => renderOdf(t, m, 'odt'),
};

/* ---------------- CLI ---------------- */

const fail = (msg) => {
  console.error(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(1);
};

function parseArgs(argv) {
  const out = { src: argv[1] || '', to: '', dir: '', overwrite: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--to') out.to = argv[++i] || '';
    else if (argv[i] === '-o' || argv[i] === '--output') out.dir = argv[++i] || '';
    else if (argv[i] === '--overwrite') out.overwrite = true;
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'formats' || argv[0] === '--formats') {
    console.log(JSON.stringify({
      ok: true, engine: 'zd-filee-bridge',
      from: PARSE_EXTS,
      to: EXTRA_FORMATS,
      note: '本地零依赖转换桥（Filee CLI 协议兼容）；内置互转另有 csv/xlsx/json/md/html',
    }, null, 2));
    return;
  }
  if (argv[0] !== 'convert' || !argv[1]) {
    fail('用法: filee-bridge convert <src> --to <ext> -o <outdir> [--overwrite] | formats');
  }
  const a = parseArgs(argv);
  const ext = String(a.to).toLowerCase().replace(/^\./, '');
  if (!EXTRA_FORMATS.includes(ext)) {
    fail(`不支持目标格式 .${ext}；支持：${EXTRA_FORMATS.join(' / ')}`);
  }
  const src = path.resolve(a.src);
  if (!fs.existsSync(src)) fail(`源文件不存在：${src}`);
  const from = path.extname(src).toLowerCase().slice(1);
  if (!PARSE_EXTS.includes(from)) {
    fail(`不支持把 .${from} 作为源格式；支持：${PARSE_EXTS.join(' / ')}`);
  }
  const dir = path.resolve(a.dir || path.dirname(src));
  fs.mkdirSync(dir, { recursive: true });
  const outName = `${path.basename(src, path.extname(src))}.${ext}`;
  const outPath = path.join(dir, outName);
  if (fs.existsSync(outPath) && !a.overwrite) fail(`目标文件已存在且未指定 --overwrite：${outName}`);

  const table = parseTable(fs.readFileSync(src), from, src);
  const meta = { period: periodOf(path.basename(src)), title: table.title || '报表' };
  const heads = headersOf(table);
  const rows = matrixOf(table);

  if (IMAGE_EXTS.includes(ext)) {
    const py = findPython();
    if (!py) fail('未找到带 Pillow 的 Python（可设置环境变量 FILEE_PYTHON 指向 python.exe）');
    const payload = JSON.stringify({ title: meta.title, period: meta.period, headers: heads, rows });
    const r = spawnSync(py, [RENDER_SCRIPT, outPath, ext], {
      input: Buffer.from(payload, 'utf8'), encoding: 'utf8', windowsHide: true,
      cwd: ROOT, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) {
      fail(`渲染 ${ext.toUpperCase()} 失败：${r.error?.message || (r.stderr || r.stdout || '').trim().slice(0, 500)}`);
    }
    let info = {};
    try { info = JSON.parse((r.stdout || '').trim()); } catch { /* 忽略无法解析的输出 */ }
    if (info.ok === false || !fs.existsSync(outPath)) fail(`渲染 ${ext.toUpperCase()} 未产出文件：${info.error || '未知原因'}`);
  } else {
    const buf = EXTRA_RENDERERS[ext](table, meta);
    fs.writeFileSync(outPath, buf);
  }

  console.log(JSON.stringify({
    ok: true, engine: 'zd-filee-bridge', output: outName,
    bytes: fs.statSync(outPath).size, rows: rows.length, columns: heads.length,
  }, null, 2));
}

try {
  main();
} catch (e) {
  fail(`${e.message}\n${e.stack?.split('\n').slice(1, 3).join('\n') || ''}`);
}
