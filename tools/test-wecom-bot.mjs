#!/usr/bin/env node
/**
 * test-wecom-bot —— 企微多人机器人接收端测试（临时库，不联网）
 *
 *   node tools/test-wecom-bot.mjs
 *
 * 覆盖：AES 加解密往返、签名校验、XML/JSON 双格式解析、未绑定用户拦截、绑定后放行。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-bot-'));
process.env.ZD_DB_PATH = path.join(tmp, 'test.db');
process.env.WECOM_CORP_ID = 'wwtest1234567890';
process.env.WECOM_AGENT_ID = '1000002';
process.env.WECOM_TOKEN = 'testtoken123';
process.env.WECOM_AES_KEY = crypto.randomBytes(32).toString('base64').slice(0, 43);
process.env.WECOM_SECRET = 'test-secret';
process.env.WECOM_AUTO_SYNC = '0';

const bot = await import('../backend/wecom-bot.mjs');

const cfg = bot.botConfig();
let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name} — ${e.message}`); process.exitCode = 1; }
};

const XML = (from, type = 'text', extra = '') => `<xml><ToUserName><![CDATA[wwtest1234567890]]></ToUserName>
<FromUserName><![CDATA[${from}]]></FromUserName><CreateTime>1730000000</CreateTime>
<MsgType><![CDATA[${type}]]></MsgType>${extra}</xml>`;

check('配置：五项齐备后 ready 为真', () => {
  assert.equal(cfg.ready, true, `缺失 ${cfg.missing.join(',')}`);
});

check('加解密：encodeMsg → decodeMsg 往返一致', () => {
  const xml = XML('zhangsan', 'text', '<Content><![CDATA[你好]]></Content>');
  const encrypted = bot.encodeMsg(cfg, xml);
  const out = bot.decodeMsg(cfg, encrypted);
  assert.equal(out.xml, xml);
  assert.equal(out.receiveId, cfg.corpId);
});

check('签名：正确签名通过，错误签名被拒', () => {
  const xml = XML('zhangsan');
  const encrypted = bot.encodeMsg(cfg, xml);
  const ts = '1730000000';
  const nonce = 'abc123';
  const sig = bot.signatureOf(cfg, ts, nonce, encrypted);
  const plain = bot.verifyAndDecrypt(cfg, { msg_signature: sig, timestamp: ts, nonce, echostr: encrypted });
  assert.equal(plain, xml);
  assert.throws(() => bot.verifyAndDecrypt(cfg, { msg_signature: 'deadbeef', timestamp: ts, nonce, echostr: encrypted }), /签名/);
});

check('解析：XML 报文抽取得出 msgType/from/mediaId', () => {
  const m = bot.normalizeMessage(XML('lisi', 'file', '<MediaId><![CDATA[MEDIA_1]]></MediaId><FileName><![CDATA[三月日报.xlsx]]></FileName>'));
  assert.equal(m.format, 'xml');
  assert.equal(m.msgType, 'file');
  assert.equal(m.from, 'lisi');
  assert.equal(m.mediaId, 'MEDIA_1');
  assert.equal(m.fileName, '三月日报.xlsx');
});

check('解析：智能机器人 JSON 报文同样抽得出来', () => {
  const m = bot.normalizeMessage(JSON.stringify({
    msgtype: 'file', from: { userid: 'wangwu' }, file: { media_id: 'MEDIA_2', filename: '京东日更.xls' },
  }));
  assert.equal(m.format, 'json');
  assert.equal(m.msgType, 'file');
  assert.equal(m.from, 'wangwu');
  assert.equal(m.mediaId, 'MEDIA_2');
  assert.equal(m.fileName, '京东日更.xls');
});

await (async () => {
  const unknown = await bot.handleMessage(cfg, XML('stranger'));
  check('鉴权：未绑定 userid 一律拒绝并留痕', () => {
    assert.match(unknown, /还没有被授权/);
    const log = bot.listBotUsers();
    assert.equal(log.length, 0, '不应自动建账号');
  });

  bot.saveBotUser({ userid: 'zhangsan', name: '张三', role: '汇报者' });
  check('绑定：写入后可见且默认允许上传', () => {
    const list = bot.listBotUsers();
    assert.equal(list.length, 1);
    assert.equal(list[0].userid, 'zhangsan');
    assert.equal(list[0].can_upload, 1);
  });

  const hello = await bot.handleMessage(cfg, XML('zhangsan'));
  check('放行：已绑定用户发文本得到发送指引', () => {
    assert.match(hello, /Excel/);
  });

  const noUp = await bot.handleMessage(cfg, XML('zhangsan', 'file', '<MediaId><![CDATA[M]]></MediaId><FileName><![CDATA[a.xlsx]]></FileName>'));
  bot.saveBotUser({ userid: 'zhangsan', can_upload: false });
  const blocked = await bot.handleMessage(cfg, XML('zhangsan', 'file', '<MediaId><![CDATA[M]]></MediaId><FileName><![CDATA[a.xlsx]]></FileName>'));
  check('权限：关掉上传权限后被拒', () => {
    assert.match(blocked, /没有上报表权限/);
  });

  check('状态：能报出配置与绑定用户', () => {
    const st = bot.botStatus();
    assert.equal(st.data.ready, true);
    assert.ok(Array.isArray(st.data.users));
    assert.ok(st.data.inbox.endsWith('/data/inbox'));
  });
})();

console.log(`\n===== 企微机器人测试：${pass} PASS =====`);
