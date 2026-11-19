#!/usr/bin/env node
/**
 * 旺店通开放平台 API 客户端（标准接口 openapi2）
 *
 * 说明：
 *   - 正式环境 https://api.wangdian.cn/openapi2/<接口>.php
 *   - 测试环境 https://sandbox.wangdian.cn/openapi2/<接口>.php
 *   - 鉴权：sid + appkey + timestamp + sign（sign 用官方「长度前缀」算法，不是普通 MD5 拼接）
 *
 * 用法：
 *   node tools/wdt-openapi.mjs --self-test                  # 用官方示例校验签名算法（不需要 key）
 *   node tools/wdt-openapi.mjs --check                      # 调 warehouse_query.php 验证 key 是否可用
 *   node tools/wdt-openapi.mjs --call stock_query.php --param page_size=10 --param page_no=0
 *   node tools/wdt-openapi.mjs --check --sandbox            # 走测试环境
 *
 * 环境变量（写 .env，不要提交）：
 *   WDT_SID=        卖家账号（旺店通分配）
 *   WDT_APPKEY=     接口账号
 *   WDT_APPSECRET=  接口密钥（只参与签名，绝不出现在请求体）
 *   WDT_BASE=       可选，覆盖默认地址
 */
import crypto from 'node:crypto';

const PROD = 'https://api.wangdian.cn/openapi2';
const SAND = 'https://sandbox.wangdian.cn/openapi2';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const allVals = (f) => {
  const out = [];
  argv.forEach((a, i) => { if (a === f && argv[i + 1]) out.push(argv[i + 1]); });
  return out;
};

/* ---------------- 签名（官方 guide_signsf 算法） ---------------- */

/**
 * 1) 参数按键名正序排序（appsecret 不参与）
 * 2) 逐项拼成 `键长2位-键:值长4位-值`（键长/值长按 UTF-8 字节数）
 * 3) 各项用 ; 连接（末尾不加 ;），再在最后直接拼上 appsecret（无分隔符）
 * 4) MD5，32 位小写
 */
export function buildSign(params, appsecret) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  const parts = keys.map((k) => {
    const key = String(k);
    const value = String(params[k]);
    const keyLen = String(Buffer.byteLength(key, 'utf8')).padStart(2, '0');
    const valLen = String(Buffer.byteLength(value, 'utf8')).padStart(4, '0');
    return `${keyLen}-${key}:${valLen}-${value}`;
  });
  const raw = parts.join(';') + appsecret;
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex');
}

function selfTest() {
  const params = {
    appkey: 'test2-xx',
    page_no: '0',
    end_time: '2016-08-01 13:00:00',
    start_time: '2016-08-01 12:00:00',
    page_size: '40',
    sid: 'test2',
    timestamp: '1470042310',
  };
  const got = buildSign(params, '12345');
  const want = 'ad4e6fe037ea6e3ba4768317be9d1309';
  const ok = got === want;
  console.log(`签名自检：${ok ? 'PASS' : 'FAIL'}`);
  console.log(`  计算值 ${got}`);
  console.log(`  官方值 ${want}`);
  process.exit(ok ? 0 : 1);
}

/* ---------------- 请求 ---------------- */

async function call(api, business = {}, { sandbox = false } = {}) {
  const sid = String(process.env.WDT_SID || '').trim();
  const appkey = String(process.env.WDT_APPKEY || '').trim();
  const secret = String(process.env.WDT_APPSECRET || '').trim();
  if (!sid || !appkey || !secret) {
    throw new Error('缺少 WDT_SID / WDT_APPKEY / WDT_APPSECRET（写到 .env 后重启终端）');
  }

  const params = {
    sid,
    appkey,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...business,
  };
  params.sign = buildSign(params, secret);

  const base = String(process.env.WDT_BASE || '').trim() || (sandbox ? SAND : PROD);
  const url = `${base}/${api}`;
  const body = new URLSearchParams(params).toString();

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 原样返回 */ }
  return { status: r.status, url, json, text: json ? '' : text.slice(0, 400) };
}

function parseParams(list) {
  const out = {};
  for (const kv of list) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

/* ---------------- 入口 ---------------- */

async function main() {
  if (has('--self-test')) return selfTest();

  const sandbox = has('--sandbox');
  const api = val('--call', has('--check') ? 'warehouse_query.php' : '');
  if (!api) {
    console.log('用法：--self-test | --check | --call <接口.php> --param k=v');
    process.exit(1);
  }
  const business = parseParams(allVals('--param'));
  if (has('--check')) {
    business.page_size = business.page_size || '10';
    business.page_no = business.page_no || '0';
  }

  try {
    const out = await call(api, business, { sandbox });
    console.log(`POST ${out.url}  HTTP ${out.status}`);
    if (out.json) {
      const code = out.json.code ?? out.json.status;
      console.log(`code=${code}  message=${out.json.message || out.json.msg || ''}`);
      const data = out.json.data;
      if (Array.isArray(data)) {
        console.log(`返回 ${data.length} 条`);
        if (data[0]) console.log('首条字段：', Object.keys(data[0]).join(', ').slice(0, 300));
        console.log('首条内容：', JSON.stringify(data[0]).slice(0, 600));
      } else {
        console.log(JSON.stringify(out.json).slice(0, 800));
      }
    } else {
      console.log('非 JSON 返回：', out.text);
    }
  } catch (e) {
    console.log(`失败：${e.message}`);
    process.exit(1);
  }
}

main();
