/**
 * 极简 BIFF8 (.xls) 读取器：OLE2 容器 → Workbook 流 → 单元格网格。
 * 只做「读表格」：BOUNDSHEET / SST / LABELSST / LABEL / NUMBER / RK / MULRK / FORMULA。
 * 不处理样式、合并单元格、公式（只取缓存值）。
 */
import fs from 'node:fs';

/* ---------- OLE2 ---------- */
function readOle(buf) {
  if (buf.readUInt32LE(0) !== 0xE011CFD0) throw new Error('不是 OLE2 文件');
  const sectorSize = 1 << buf.readUInt16LE(30);
  const miniSize = 1 << buf.readUInt16LE(32);
  const numFat = buf.readUInt32LE(44);
  const dirStart = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const miniFatStart = buf.readUInt32LE(60);
  const difStart = buf.readUInt32LE(68);
  const numDif = buf.readUInt32LE(72);

  const off = (s) => 512 + s * sectorSize;
  const readSector = (s) => buf.subarray(off(s), off(s) + sectorSize);

  // FAT
  const fatSectors = [];
  for (let i = 0; i < 109 && i < numFat; i += 1) fatSectors.push(buf.readUInt32LE(76 + i * 4));
  let next = difStart;
  let guard = 0;
  while (next && next !== 0xFFFFFFFE && guard < numDif + 10) {
    const s = readSector(next);
    const cnt = sectorSize / 4 - 1;
    for (let i = 0; i < cnt; i += 1) {
      const v = s.readUInt32LE(i * 4);
      if (v) fatSectors.push(v);
    }
    next = s.readUInt32LE(sectorSize - 4);
    guard += 1;
  }
  const fat = [];
  for (const fs0 of fatSectors) {
    const s = readSector(fs0);
    for (let i = 0; i < sectorSize / 4; i += 1) fat.push(s.readUInt32LE(i * 4));
  }
  const chain = (start) => {
    const out = [];
    let cur = start;
    let g = 0;
    while (cur < fat.length && cur !== 0xFFFFFFFE && g < 200000) {
      out.push(cur);
      cur = fat[cur];
      g += 1;
    }
    return out;
  };

  // 目录
  const dirData = Buffer.concat(chain(dirStart).map(readSector));
  const entries = [];
  for (let i = 0; i + 127 < dirData.length; i += 128) {
    const nameLen = dirData.readUInt16LE(i + 64);
    const name = dirData.subarray(i, i + Math.max(0, nameLen - 2)).toString('utf16le');
    const type = dirData.readUInt8(i + 66);
    const start = dirData.readUInt32LE(i + 116);
    const size = dirData.readUInt32LE(i + 120);
    if (type) entries.push({ name, type, start, size });
  }

  // mini stream
  const miniFatData = miniFatStart ? Buffer.concat(chain(miniFatStart).map(readSector)) : Buffer.alloc(0);
  const miniFat = [];
  for (let i = 0; i + 3 < miniFatData.length; i += 4) miniFat.push(miniFatData.readUInt32LE(i));
  const root = entries.find((e) => e.type === 5);
  const miniStream = root ? Buffer.concat(chain(root.start).map(readSector)).subarray(0, root.size) : Buffer.alloc(0);

  const readEntry = (e) => {
    if (e.size < miniCutoff) {
      const out = [];
      let cur = e.start;
      let g = 0;
      while (cur < miniFat.length && cur !== 0xFFFFFFFE && g < 200000) {
        out.push(miniStream.subarray(cur * miniSize, (cur + 1) * miniSize));
        cur = miniFat[cur];
        g += 1;
      }
      return Buffer.concat(out).subarray(0, e.size);
    }
    return Buffer.concat(chain(e.start).map(readSector)).subarray(0, e.size);
  };

  const wb = entries.find((e) => e.name === 'Workbook' || e.name === 'Book');
  if (!wb) throw new Error('未找到 Workbook 流');
  return readEntry(wb);
}

/* ---------- BIFF8 ---------- */
function readBiff(stream) {
  const records = [];
  for (let p = 0; p + 4 <= stream.length;) {
    const type = stream.readUInt16LE(p);
    const len = stream.readUInt16LE(p + 2);
    records.push({ type, data: stream.subarray(p + 4, p + 4 + len), pos: p });
    p += 4 + len;
  }

  // SST（含 CONTINUE）
  let sst = [];
  const sstIdx = records.findIndex((r) => r.type === 0x00FC);
  if (sstIdx >= 0) {
    let buf = records[sstIdx].data;
    let i = sstIdx + 1;
    while (i < records.length && records[i].type === 0x003C) { buf = Buffer.concat([buf, records[i].data]); i += 1; }
    sst = parseSst(buf);
  }

  // 工作表
  const sheets = [];
  for (const r of records) {
    if (r.type !== 0x0085) continue;
    const cch = r.data.readUInt8(6);
    const flags = r.data.readUInt8(7);
    const name = flags & 1
      ? r.data.subarray(8, 8 + cch * 2).toString('utf16le')
      : r.data.subarray(8, 8 + cch).toString('latin1');
    sheets.push({ name, offset: r.data.readUInt32LE(0) });
  }

  const sheetGrids = sheets.map((sh) => {
    const startIdx = records.findIndex((r) => r.pos === sh.offset);
    const grid = new Map();
    if (startIdx < 0) return { name: sh.name, rows: [] };
    for (let i = startIdx; i < records.length; i += 1) {
      const { type, data } = records[i];
      if (type === 0x000A && i > startIdx) break; // EOF
      try {
        if (type === 0x00FD) { // LABELSST
          const row = data.readUInt16LE(0); const col = data.readUInt16LE(2); const isst = data.readUInt32LE(6);
          setCell(grid, row, col, sst[isst] ?? '');
        } else if (type === 0x0204) { // LABEL
          const row = data.readUInt16LE(0); const col = data.readUInt16LE(2);
          const cch = data.readUInt16LE(6); const flags = data.readUInt8(8);
          const v = flags & 1 ? data.subarray(9, 9 + cch * 2).toString('utf16le') : data.subarray(9, 9 + cch).toString('latin1');
          setCell(grid, row, col, v);
        } else if (type === 0x0203) { // NUMBER
          setCell(grid, data.readUInt16LE(0), data.readUInt16LE(2), data.readDoubleLE(6));
        } else if (type === 0x027E) { // RK
          setCell(grid, data.readUInt16LE(0), data.readUInt16LE(2), decodeRk(data.readInt32LE(6)));
        } else if (type === 0x00BD) { // MULRK
          const row = data.readUInt16LE(0);
          const colFirst = data.readUInt16LE(2);
          const n = (data.length - 6) / 6;
          for (let k = 0; k < n; k += 1) {
            const rk = data.readInt32LE(4 + k * 6 + 2);
            setCell(grid, row, colFirst + k, decodeRk(rk));
          }
        } else if (type === 0x0006) { // FORMULA（取缓存数值）
          const row = data.readUInt16LE(0); const col = data.readUInt16LE(2);
          const b = data.subarray(6, 14);
          if (b[6] === 0xFF && b[7] === 0xFF) continue; // 字符串/错误，忽略
          setCell(grid, row, col, b.readDoubleLE(0));
        }
      } catch { /* 单条记录异常不影响其它 */ }
    }
    const rows = [...grid.entries()].sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1]);
    return { name: sh.name, rows };
  });

  return sheetGrids.map(({ name, rows }) => {
    const out = [];
    for (const [[r, c], v] of rows) {
      if (!out[r]) out[r] = [];
      out[r][c] = v;
    }
    return { name, grid: out.filter(Boolean) };
  });
}

function decodeRk(rk) {
  const isInt = rk & 0x02;
  const div100 = rk & 0x01;
  let v;
  if (isInt) v = rk >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeInt32LE((rk & 0xFFFFFFFC) | 0, 4);
    v = b.readDoubleLE(0);
  }
  return div100 ? v / 100 : v;
}

function setCell(grid, row, col, value) {
  const k = `${row}:${col}`;
  if (value === '' || value == null) return;
  grid.set([row, col], value);
}

function parseSst(buf) {
  const out = [];
  const total = buf.readUInt32LE(0);
  let p = 8;
  for (let n = 0; n < total && p + 3 < buf.length; n += 1) {
    const cch = buf.readUInt16LE(p);
    const flags = buf.readUInt8(p + 2);
    const rich = flags & 0x08;
    const ext = flags & 0x04;
    const wide = flags & 0x01;
    p += 3;
    let runs = 0;
    let extLen = 0;
    if (rich) { runs = buf.readUInt16LE(p); p += 2; }
    if (ext) { extLen = buf.readUInt32LE(p); p += 4; }
    const bytes = wide ? cch * 2 : cch;
    const str = wide ? buf.subarray(p, p + bytes).toString('utf16le') : buf.subarray(p, p + bytes).toString('latin1');
    out.push(str);
    p += bytes;
    if (rich) p += runs * 4;
    if (ext) p += extLen;
  }
  return out;
}

export function readXlsFile(file) {
  const buf = fs.readFileSync(file);
  return readBiff(readOle(buf));
}

if (process.argv[1] && process.argv[1].endsWith('xls-read.mjs')) {
  const f = process.argv[2];
  const sheets = readXlsFile(f);
  for (const s of sheets) {
    console.log(`\n=== ${s.name} rows=${s.grid.length}`);
    for (const row of s.grid.slice(0, 12)) {
      console.log(row.map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)).join(' | ').slice(0, 220));
    }
  }
}
