#!/usr/bin/env node
/**
 * make-icon —— 生成「振颜丽舍」图标（PNG + ICO），零依赖
 *
 * 复用 tools/shot-html.mjs 的无头渲染，把内联 SVG 渲成 256×256 PNG，
 * 再把 PNG 包进 ICO（单条 256 记录，Windows 10/11 原生支持 PNG 负载）。
 * 不依赖 Python / ImageMagick。
 *
 *   node tools/make-icon.mjs
 *
 * 产物：desktop/icon.png、desktop/icon.ico、desktop/zhuangdian-icon.ico
 * （后两个沿用旧文件名，避免快捷方式指向失效；内容已是新图）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESK = path.join(ROOT, 'desktop');
const SIZE = 256;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1F5E4C"/>
      <stop offset="100%" stop-color="#46B391"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="256" height="256" fill="url(#g)"/>
  <rect x="14" y="14" width="228" height="228" rx="46" fill="none" stroke="#ffffff" stroke-opacity=".18" stroke-width="3"/>
  <text x="128" y="146" text-anchor="middle" font-family="Microsoft YaHei, PingFang SC, sans-serif"
        font-size="124" font-weight="700" fill="#ffffff" letter-spacing="2">振</text>
  <rect x="86" y="190" width="84" height="6" rx="3" fill="#ffffff" fill-opacity=".55"/>
</svg>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-icon-'));
const htmlPath = path.join(tmp, 'icon.html');
const pngPath = path.join(tmp, 'icon.png');

fs.writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#1F5E4C;width:${SIZE}px;height:${SIZE}px;overflow:hidden}
svg{display:block}</style>${SVG}`, 'utf8');

try {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'shot-html.mjs'), htmlPath, pngPath, String(SIZE), String(SIZE)], {
    stdio: 'inherit',
  });

  const png = fs.readFileSync(pngPath);
  if (!png.length) throw new Error('PNG 为空');

  // PNG → ICO：6 字节头 + 16 字节目录项 + PNG 数据
  const ico = Buffer.alloc(22 + png.length);
  ico.writeUInt16LE(0, 0);        // reserved
  ico.writeUInt16LE(1, 2);        // type=icon
  ico.writeUInt16LE(1, 4);        // 1 张
  ico.writeUInt8(0, 6);           // width 0 = 256
  ico.writeUInt8(0, 7);           // height 0 = 256
  ico.writeUInt8(0, 8);           // 调色板
  ico.writeUInt8(0, 9);           // reserved
  ico.writeUInt16LE(1, 10);       // planes
  ico.writeUInt16LE(32, 12);      // bpp
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(22, 18);
  png.copy(ico, 22);

  fs.writeFileSync(path.join(DESK, 'icon.png'), png);
  fs.writeFileSync(path.join(DESK, 'icon.ico'), ico);
  fs.writeFileSync(path.join(DESK, 'zhuangdian-icon.ico'), ico);
  console.log(`icon ok: desktop/icon.png (${(png.length / 1024).toFixed(1)} KB), icon.ico, zhuangdian-icon.ico`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
