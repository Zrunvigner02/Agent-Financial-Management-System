/* DeepSeek 模型解析与连通性探测。
 *
 * 背景（2026-11-11 实测）：GET https://api.deepseek.com/v1/models 只返回
 *   deepseek-flash (DeepSeek-V4.1-Flash) / deepseek-v4-pro (DeepSeek-V4-Pro)。
 *   传 dsv4.1f1017 会 400：The supported API model names are ...
 *   传 deepseek-chat 虽 200，但响应体 model=deepseek-flash（兼容别名）。
 * 因此配置层保留用户可见/指定的名字，请求层统一解析成官方有效 ID。
 * 未知名字原样透传，由上游报错透传到前端，不做静默替换。
 */
import { readEnv } from './store.mjs';

export const MODEL_ALIASES = Object.freeze({
  'dsv4.1f1017': 'deepseek-flash',   // 用户指定名 → DeepSeek V4.1 Flash
  'dsv4.1flash': 'deepseek-flash',
  'ds-v4.1-flash': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash', // 官方兼容别名，显式归一
  'deepseek-reasoner': 'deepseek-v4-pro',
  'dsv4pro': 'deepseek-v4-pro',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-flash': 'deepseek-flash',
});

export const DEFAULT_MODEL = 'deepseek-flash';

/** 把配置里的模型名解析为上游真正接受的 model id */
export function normalizeModel(name) {
  const raw = String(name || '').trim();
  if (!raw) return DEFAULT_MODEL;
  return MODEL_ALIASES[raw.toLowerCase()] ?? raw;
}

/** 给前端展示「配置名 → 实际模型」的对应关系 */
export function describeModel(name) {
  const configured = String(name || '').trim() || DEFAULT_MODEL;
  const effective = normalizeModel(configured);
  return { configured_model: configured, effective_model: effective, aliased: configured !== effective };
}

/** 汇总当前生效配置；DB(agent_config) 优先，.env 兜底 */
export function currentConfig(cfg) {
  // 同时兼容 DB 的 snake_case 与前端表单的 camelCase
  const key = cfg?.api_key || cfg?.apiKey || readEnv('DEEPSEEK_API_KEY') || '';
  const baseUrl = String(cfg?.base_url || cfg?.baseUrl || readEnv('DEEPSEEK_BASE_URL')
    || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const configuredModel = String(cfg?.model || readEnv('DEEPSEEK_MODEL') || 'deepseek-chat').trim();
  return { key, baseUrl, configuredModel, model: normalizeModel(configuredModel) };
}

/** 读取上游错误响应里的可读信息（模型名非法、余额不足、限流等） */
export async function readUpstreamError(r) {
  try {
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      return String(j?.error?.message || j?.message || text).slice(0, 400);
    } catch {
      return text.slice(0, 400);
    }
  } catch {
    return '';
  }
}

/** 真实连通性探测：max_tokens=1，不会像旧实现那样无条件返回「已就绪」 */
export async function testModel(cfg, timeoutMs = 15000) {
  const c = currentConfig(cfg);
  if (!c.key) return { ok: false, message: '未配置 API Key：请在 .env 设置 DEEPSEEK_API_KEY' };
  try {
    const r = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
      body: JSON.stringify({
        model: c.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      const detail = await readUpstreamError(r);
      return {
        ok: false,
        message: `模型 ${c.configuredModel}${c.configuredModel !== c.model ? ` → ${c.model}` : ''} 请求失败（HTTP ${r.status}）${detail ? '：' + detail : ''}`,
      };
    }
    const j = await r.json();
    return {
      ok: true,
      message: `连通正常：${c.configuredModel}${c.configuredModel !== c.model ? ` → ${j.model || c.model}` : ''}`,
      effective_model: j.model || c.model,
    };
  } catch (e) {
    return { ok: false, message: `连通失败：${e.message}` };
  }
}
