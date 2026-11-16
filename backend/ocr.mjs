/**
 * OCR：图片 / 扫描件的文字识别
 *
 * 提供方链（OCR_MODE 控制）：
 *   auto  —— 先本地 tesseract，失败或没装再走视觉模型 API（默认）
 *   local —— 只用本地 tesseract
 *   api   —— 只用视觉模型 API
 *   off   —— 关闭
 *
 * 本地：`tesseract` 在 PATH 中，或 .env 设置 OCR_CMD / ZD_OCR_CMD 指向可执行文件
 * API：OCR_API_KEY + OCR_API_BASE（OpenAI 兼容）+ OCR_MODEL（如 gpt-4o-mini / qwen-vl-max）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readEnv } from './store.mjs';

const MAX_SIDE_BYTES = 12 * 1024 * 1024;

const env = (k, d = '') => process.env[k] || readEnv(k) || d;

export function mode() {
  const m = String(env('OCR_MODE', 'auto')).toLowerCase();
  return ['auto', 'local', 'api', 'off'].includes(m) ? m : 'auto';
}

function findLocalCmd() {
  const custom = env('OCR_CMD') || env('ZD_OCR_CMD');
  if (custom) return custom;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['tesseract'],
    { encoding: 'utf8', windowsHide: true });
  if (which.status === 0) {
    const first = String(which.stdout || '').split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  }
  return '';
}

function apiConfig() {
  return {
    key: env('OCR_API_KEY'),
    base: env('OCR_API_BASE', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env('OCR_MODEL', 'gpt-4o-mini'),
  };
}

export const recognizeSyncLocal = (file, langs) => localOcr(file, langs);

export function status() {
  const cmd = findLocalCmd();
  const api = apiConfig();
  return {
    mode: mode(),
    local: { available: Boolean(cmd), cmd },
    api: { configured: Boolean(api.key), base: api.base, model: api.model },
    hint: cmd || api.key ? '' : '未检测到 OCR 引擎：安装 tesseract（离线）或在 .env 配 OCR_API_KEY（联网）',
  };
}

function localOcr(file, langs) {
  const cmd = findLocalCmd();
  if (!cmd) return { ok: false, error: '未安装本地 OCR（tesseract）' };
  const args = [file, 'stdout', '-l', langs || env('OCR_LANG', 'chi_sim+eng'), '--psm', '6'];
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, windowsHide: true, shell: false });
  if (r.status !== 0) {
    return { ok: false, error: `tesseract 失败：${String(r.stderr || r.stdout || '').slice(0, 200).trim()}` };
  }
  const text = String(r.stdout || '').replace(/\r/g, '').trim();
  return text ? { ok: true, text, engine: 'tesseract' } : { ok: false, error: '未识别到文字' };
}

async function apiOcr(file, ext) {
  const cfg = apiConfig();
  if (!cfg.key) return { ok: false, error: '未配置 OCR_API_KEY' };
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_SIDE_BYTES) return { ok: false, error: '图片超过 12MB，建议压缩后再识别' };
  const mime = ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
      : ext === 'bmp' ? 'image/bmp'
        : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  try {
    const r = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '请只输出这张图片中的文字，保持原有换行，不要解释、不要总结。如果是发票或票据，保留金额、日期、单位名称、税号等字段。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, error: `视觉模型返回 ${r.status}：${t.slice(0, 160)}` };
    }
    const j = await r.json();
    const text = String(j?.choices?.[0]?.message?.content || '').trim();
    return text ? { ok: true, text, engine: `api:${cfg.model}` } : { ok: false, error: '模型未返回文字' };
  } catch (e) {
    return { ok: false, error: `视觉模型请求失败：${e.message}` };
  }
}

/**
 * 识别一张图片。
 * @returns {Promise<{ok:boolean,text?:string,engine?:string,error?:string,tried:string[]}>}
 */
export async function recognize(file, { ext = '', langs = '' } = {}) {
  const m = mode();
  const tried = [];
  if (m === 'off') return { ok: false, error: 'OCR 已关闭（OCR_MODE=off）', tried };
  if (!file || !fs.existsSync(file)) return { ok: false, error: `文件不存在：${file}`, tried };

  const e = ext || path.extname(file).slice(1).toLowerCase();

  if (m === 'local' || m === 'auto') {
    tried.push('local');
    const r = localOcr(file, langs);
    if (r.ok) return { ...r, tried };
    if (m === 'local') return { ...r, tried };
    tried.push(`local失败:${r.error}`);
  }

  if (m === 'api' || m === 'auto') {
    tried.push('api');
    const r = await apiOcr(file, e);
    if (r.ok) return { ...r, tried };
    return { ...r, tried };
  }
  return { ok: false, error: '没有可用的 OCR 引擎', tried };
}

/** 命令行自检：node tools/ocr-doctor.mjs */
export const __test__ = { localOcr, apiOcr };
