/**
 * 企业微信自建应用「多人机器人」接收端（v2.4.0）
 *
 * 作用：让汇报者在企微里直接把表格发给本地助理 → 助理收下 → 解析入库 → 回执确认。
 * 这样历史缺失的数据可以由各汇报人分头补发，不用再等某一个人。
 *
 * 三条链路：
 *   1. 回调验签 + AES 解密（企业微信标准协议，token + EncodingAESKey）
 *   2. 按企微 userid 鉴权（wecom_users 绑定表，未绑定的直接拒绝并留痕）
 *   3. 下载 media → 落到 data/inbox → 触发既有同步管线（四重防重照常生效）→ 回执
 *
 * 运行前置（缺一不可，配在 .env）：
 *   WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET / WECOM_TOKEN / WECOM_AES_KEY
 *   + 企微后台「接收消息」URL 指向本服务的公网 HTTPS 地址（本地机需内网穿透或部署到服务器）
 *
 * 说明：群机器人 webhook 只能发、不能收文件，所以必须走自建应用接收回调；
 *       若要做到「自动补历史聊天记录」，只能开通会话内容存档（另一套协议）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, all, run, now } from './store.mjs';
import { syncWecom } from './wecom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = path.join(ROOT, 'data', 'inbox');
const QYAPI = 'https://qyapi.weixin.qq.com';
const SET_DEFAULT = 85;

/* ---------------- 配置 ---------------- */

export function botConfig() {
  const read = (k) => String(process.env[k] || '').trim();
  const cfg = {
    corpId: read('WECOM_CORP_ID'),
    agentId: read('WECOM_AGENT_ID'),
    secret: read('WECOM_SECRET'),
    token: read('WECOM_TOKEN'),
    aesKey: read('WECOM_AES_KEY'),
    autoSync: read('WECOM_AUTO_SYNC') !== '0',
  };
  cfg.ready = Boolean(cfg.corpId && cfg.secret && cfg.token && cfg.aesKey);
  cfg.missing = [
    ['WECOM_CORP_ID', cfg.corpId], ['WECOM_SECRET', cfg.secret],
    ['WECOM_TOKEN', cfg.token], ['WECOM_AES_KEY', cfg.aesKey],
  ].filter(([, v]) => !v).map(([k]) => k);
  return cfg;
}

/* ---------------- 加解密（企业微信标准） ---------------- */

const keyOf = (aesKey) => Buffer.from(`${aesKey}=`, 'base64');   // 43 字符 + '=' → 32 字节

function pkcs7Pad(buf, block = 32) {
  const pad = block - (buf.length % block) || block;
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function pkcs7Unpad(buf, block = 32) {
  const pad = buf[buf.length - 1];
  if (!pad || pad > block) return buf;
  return buf.subarray(0, buf.length - pad);
}

/** msg = random16 + len(4,BE) + xml + receiveid */
export function encodeMsg(cfg, xml, receiveId = '') {
  const random = crypto.randomBytes(16);
  const body = Buffer.from(xml, 'utf8');
  const rid = Buffer.from(receiveId || cfg.corpId, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const plain = pkcs7Pad(Buffer.concat([random, len, body, rid]));
  const cipher = crypto.createCipheriv('aes-256-cbc', keyOf(cfg.aesKey), keyOf(cfg.aesKey).subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

export function decodeMsg(cfg, encrypted) {
  const key = keyOf(cfg.aesKey);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = pkcs7Unpad(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]));
  const len = plain.readUInt32BE(16);
  const xml = plain.subarray(20, 20 + len).toString('utf8');
  const receiveId = plain.subarray(20 + len).toString('utf8');
  return { xml, receiveId };
}

export const signatureOf = (cfg, timestamp, nonce, encrypt) => crypto
  .createHash('sha1')
  .update([cfg.token, timestamp, nonce, encrypt].sort().join(''))
  .digest('hex');

/** 校验签名 + 解密；失败抛错（调用方据此回 403，不泄露细节） */
export function verifyAndDecrypt(cfg, { msg_signature: sig, timestamp, nonce, echostr }) {
  if (!cfg.ready) throw new Error('企微应用未配置');
  const encrypted = echostr;
  if (signatureOf(cfg, timestamp, nonce, encrypted) !== String(sig || '')) throw new Error('签名校验失败');
  const { xml, receiveId } = decodeMsg(cfg, encrypted);
  if (cfg.corpId && receiveId && receiveId !== cfg.corpId) throw new Error('receiveid 不匹配');
  return xml;
}

/* ---------------- XML 取值 ---------------- */

const pick = (xml, tag) => {
  const m = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${tag}>`).exec(xml || '');
  return m ? (m[1] ?? m[2] ?? '').trim() : '';
};

/* ---------------- 账号绑定（多人权限） ---------------- */

export function ensureBotTables() {
  run(`CREATE TABLE IF NOT EXISTS wecom_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '汇报者',
    set_id INTEGER NOT NULL DEFAULT 85,
    can_upload INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_seen TEXT NOT NULL DEFAULT '',
    files_in INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS wecom_msg_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid TEXT NOT NULL DEFAULT '',
    msg_type TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    sha256 TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT '',
    batch_id INTEGER NOT NULL DEFAULT 0,
    raw TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  const cols = all('PRAGMA table_info(wecom_msg_log)').map((c) => c.name);
  if (!cols.includes('raw')) run("ALTER TABLE wecom_msg_log ADD COLUMN raw TEXT NOT NULL DEFAULT ''");
  // 会话消息带上发送人（谁在对话），老库自动补列
  const mcols = all('PRAGMA table_info(agent_messages)').map((c) => c.name);
  if (!mcols.includes('sender')) run("ALTER TABLE agent_messages ADD COLUMN sender TEXT NOT NULL DEFAULT ''");
  // 数据归集台账：谁、什么时候、提交了什么类别的数据
  run(`CREATE TABLE IF NOT EXISTS data_intake (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id INTEGER NOT NULL DEFAULT 85,
    source TEXT NOT NULL DEFAULT 'wecom',
    sender_id TEXT NOT NULL DEFAULT '',
    sender_name TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'other',
    doc_type TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    doc_date TEXT NOT NULL DEFAULT '',
    batch_id INTEGER NOT NULL DEFAULT 0,
    rows INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '',
    sha256 TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  run('CREATE INDEX IF NOT EXISTS idx_intake_date ON data_intake(set_id, doc_date)');
}

function guessDocType(name) {
  const s = String(name || '');
  if (/月报|月度|对比/.test(s)) return 'monthly';
  if (/日报|每日|日销/.test(s)) return 'daily';
  if (/库存|采购|发货/.test(s)) return 'inventory';
  if (/凭证|总账|余额|资产|利润/.test(s)) return 'finance';
  return 'sales';
}
function guessDocDate(name) {
  const s = String(name || '');
  let m = s.match(/(\d{4})[.\-年/](\d{1,2})[.\-月/](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/(\d{4})[.\-年/](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-01`;
  return new Date().toLocaleDateString('sv-SE');
}

function recordIntake(row) {
  try {
    const exist = row.sha256
      ? get('SELECT id FROM data_intake WHERE set_id = ? AND sha256 = ? AND source = ? LIMIT 1', row.set_id, row.sha256, row.source)
      : null;
    if (exist) {
      run('UPDATE data_intake SET status = ?, rows = ?, batch_id = ?, file_path = ? WHERE id = ?',
        row.status || '', row.rows || 0, row.batch_id || 0, row.file_path || '', exist.id);
      return exist.id;
    }
    const info = run(`INSERT INTO data_intake
      (set_id, source, sender_id, sender_name, category, doc_type, file_name, file_path, doc_date, batch_id, rows, status, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.set_id || SET_DEFAULT, row.source || 'wecom', row.sender_id || '', row.sender_name || '',
    row.category || 'other', row.doc_type || '', row.file_name || '', row.file_path || '',
    row.doc_date || '', row.batch_id || 0, row.rows || 0, row.status || '', row.sha256 || '', now());
    return Number(info.lastInsertRowid);
  } catch { return 0; }
}

/* ---------------- 会话留痕：记录与谁对话、载入了谁的报表 ---------------- */
const CHAT_MEDIA_ROOT = path.join(ROOT, 'upstream', 'chat-media', 'wecom');

function publishMedia(filePath, displayName, dayStr) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const dir = path.join(CHAT_MEDIA_ROOT, dayStr);
    fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash('sha1').update(filePath + fs.statSync(filePath).size).digest('hex').slice(0, 8);
    const base = path.basename(filePath).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
    const name = `${hash}_${base}`;
    const dest = path.join(dir, name);
    if (!fs.existsSync(dest)) fs.copyFileSync(filePath, dest);
    return `\n\n[[MEDIA:/chat-media/wecom/${dayStr}/${encodeURIComponent(name)}|${displayName}|file]]`;
  } catch { return ''; }
}

function recordChat(user, role, text, sender) {
  try {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    const dd = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const sid = `wecom-${user.userid}-${day}`;
    run(`INSERT OR IGNORE INTO agent_sessions (id, set_id, title, title_source, created_at)
      VALUES (?, ?, ?, 'manual', ?)`, sid, user.set_id, `企微 · ${user.name || user.userid} · ${dd}`, now());
    run('INSERT INTO agent_messages (session_id, role, content, created_at, sender) VALUES (?, ?, ?, ?, ?)',
      sid, role, text, now(), String(sender || ''));
  } catch { /* 留痕失败不影响主流程 */ }
}

export function listBotUsers() {
  ensureBotTables();
  return all('SELECT * FROM wecom_users ORDER BY id');
}

export function saveBotUser(data = {}) {
  ensureBotTables();
  const userid = String(data.userid || '').trim();
  if (!userid) return { code: 1, message: '请给出企微 userid', data: null };
  const exist = get('SELECT * FROM wecom_users WHERE userid = ?', userid);
  const name = String(data.name || exist?.name || '');
  const role = String(data.role || exist?.role || '汇报者');
  const setId = Number(data.set_id || exist?.set_id || SET_DEFAULT);
  const canUpload = data.can_upload === false ? 0 : 1;
  const enabled = data.enabled === false ? 0 : 1;
  if (exist) {
    run('UPDATE wecom_users SET name = ?, role = ?, set_id = ?, can_upload = ?, enabled = ? WHERE id = ?',
      name, role, setId, canUpload, enabled, exist.id);
    return { code: 0, message: `已更新 ${userid}`, data: { id: exist.id } };
  }
  const info = run(`INSERT INTO wecom_users (userid, name, role, set_id, can_upload, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, userid, name, role, setId, canUpload, enabled, now());
  return { code: 0, message: `已绑定 ${userid}`, data: { id: Number(info.lastInsertRowid) } };
}

const findUser = (userid) => {
  ensureBotTables();
  return get('SELECT * FROM wecom_users WHERE userid = ? AND enabled = 1', userid);
};

/* ---------------- 企微 API ---------------- */

let tokenCache = { value: '', expireAt: 0 };

async function accessToken(cfg) {
  if (tokenCache.value && Date.now() < tokenCache.expireAt) return tokenCache.value;
  const url = `${QYAPI}/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.secret)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`获取 access_token 失败：${j.errmsg || j.errcode || '未知'}`);
  tokenCache = { value: j.access_token, expireAt: Date.now() + (Number(j.expires_in || 7200) - 300) * 1000 };
  return tokenCache.value;
}

async function downloadMedia(cfg, mediaId) {
  const token = await accessToken(cfg);
  const r = await fetch(`${QYAPI}/cgi-bin/media/get?access_token=${token}&media_id=${encodeURIComponent(mediaId)}`,
    { signal: AbortSignal.timeout(60000) });
  const type = String(r.headers.get('content-type') || '');
  if (type.includes('application/json')) {
    const j = await r.json();
    throw new Error(`下载素材失败：${j.errmsg || j.errcode || '未知'}`);
  }
  const disposition = String(r.headers.get('content-disposition') || '');
  const m = /filename="?([^\";]+)"?/.exec(disposition);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, name: m ? decodeURIComponent(m[1]) : '' };
}

export async function sendText(cfg, toUser, content) {
  const token = await accessToken(cfg);
  const r = await fetch(`${QYAPI}/cgi-bin/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      touser: toUser, msgtype: 'text', agentid: Number(cfg.agentId) || undefined,
      text: { content: String(content).slice(0, 1800) }, safe: 0,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.errcode) throw new Error(`发送消息失败：${j.errmsg}`);
  return j;
}

/**
 * 统一报文解析。
 * - 自建应用回调：XML（MsgType/FromUserName/MediaId…）
 * - 智能机器人回调：JSON（msgtype/from.userid/file.media_id…）
 * 字段名不完全一致，这里做容错抽取；原始报文会落库，便于第一次真实消息后校准。
 */
export function normalizeMessage(payload) {
  const raw = String(payload || '').trim();
  if (raw.startsWith('{')) {
    let j = {};
    try { j = JSON.parse(raw); } catch { /* 保持空对象 */ }
    return {
      format: 'json',
      msgType: String(j.msgtype || j.MsgType || ''),
      from: String(j.from?.userid || j.FromUserName || j.userid || ''),
      content: String(j.text?.content || j.Content || j.content || ''),
      event: String(j.event?.eventtype || j.Event || ''),
      mediaId: String(j.file?.media_id || j.image?.media_id || j.voice?.media_id || j.MediaId || ''),
      fileName: String(j.file?.filename || j.file?.name || j.FileName || ''),
      raw,
    };
  }
  return {
    format: 'xml',
    msgType: pick(raw, 'MsgType'),
    from: pick(raw, 'FromUserName'),
    content: pick(raw, 'Content'),
    event: pick(raw, 'Event'),
    mediaId: pick(raw, 'MediaId'),
    fileName: pick(raw, 'FileName'),
    raw,
  };
}

/* ---------------- 收文件 → 入库 ---------------- */

const safeName = (s) => String(s || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);

function saveToInbox(buf, name) {
  const ym = new Date().toISOString().slice(0, 7);
  const dir = path.join(INBOX, ym);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safeName(name));
  fs.writeFileSync(dest, buf);
  return dest;
}

/**
 * 处理一条已解密的消息。返回要回复给用户的文本。
 * @param {object} cfg
 * @param {string} xml 解密后的消息 XML
 */
export async function handleMessage(cfg, payload) {
  ensureBotTables();
  const m = normalizeMessage(payload);
  const msgType = m.msgType;
  const from = m.from;
  const user = findUser(from);

  if (!user) {
    run(`INSERT INTO wecom_msg_log (userid, msg_type, result, created_at) VALUES (?, ?, '未授权', ?)`,
      from, msgType, now());
    return `你还没有被授权使用本助理（企微账号 ${from}）。请联系管理员在「企微机器人」里绑定后再发送。`;
  }
  run('UPDATE wecom_users SET last_seen = ? WHERE id = ?', now(), user.id);

  if (msgType === 'event') {
    const ev = m.event;
    if (ev === 'subscribe' || ev === 'enter_agent') {
      return `你好，我是本地财务助理。直接把 Excel 表格发给我即可入库（支持 xlsx/xls），系统会自动识别报表系列并去重。\n当前身份：${user.name || user.userid}（${user.role}）`;
    }
    return '';
  }

  if (msgType === 'text') {
    const content = m.content;
    const who = user.name || user.userid;
    const reply = /补|历史|缺/.test(content)
      ? '补历史数据：直接把对应月份的日报 Excel 发给我就行，文件名尽量保留「店铺/日期」信息，例如「歌剧魅影旗舰店日报数据-2026.03.15.xlsx」。相同的表发多次不会重复入账。'
      : `收到消息。发 Excel 表格给我即可入库，支持 .xlsx / .xls；当前身份：${who}（${user.role}）`;
    recordChat(user, 'user', `[${who}] ${content}`, who);
    recordChat(user, 'assistant', reply, '助手');
    return reply;
  }

  if (msgType !== 'file') {
    return `暂不支持「${msgType}」类型。请直接发送 Excel 文件（.xlsx/.xls），或截图报表（目前只登记不解析）。`;
  }

  if (!user.can_upload) {
    run(`INSERT INTO wecom_msg_log (userid, msg_type, result, raw, created_at) VALUES (?, ?, '无上传权限', ?, ?)`,
      from, msgType, m.raw.slice(0, 4000), now());
    return '你的账号目前没有上报表权限，请联系管理员开通。';
  }

  const mediaId = m.mediaId;
  const fileName = m.fileName || `wecom_${Date.now()}.xlsx`;
  if (!mediaId) return '没有拿到文件标识（MediaId），请重新发送。';

  try {
    const { buf, name } = await downloadMedia(cfg, mediaId);
    const realName = name || fileName;
    const ext = path.extname(realName).toLowerCase();
    if (!['.xlsx', '.xls', '.csv', '.pdf'].includes(ext)) {
      const savedOther = saveToInbox(buf, realName);
      run(`INSERT INTO wecom_msg_log (userid, msg_type, file_name, result, created_at) VALUES (?, ?, ?, '非表格已登记', ?)`,
        from, msgType, realName, now());
      const who0 = user.name || user.userid;
      const day0 = new Date().toLocaleDateString('sv-SE');
      recordChat(user, 'user', `[${who0}] 上传文件：${realName}`, who0);
      recordChat(user, 'assistant', `📎 已收下文件：${realName}（上传人：${who0}）${publishMedia(savedOther, realName, day0)}`, '助手');
      recordIntake({
        set_id: user.set_id, source: 'wecom', sender_id: user.userid, sender_name: who0,
        category: 'attachment', doc_type: ext.replace('.', ''), file_name: realName, file_path: savedOther,
        doc_date: guessDocDate(realName), status: 'registered',
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      });
      return `已收下「${realName}」，但这个格式暂不解析（支持 xlsx/xls/csv）。文件已存入投递箱备查。`;
    }
    const saved = saveToInbox(buf, realName);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');

    let replyText = '';
    let batchId = 0;
    if (cfg.autoSync) {
      const r = syncWecom(user.set_id, { apply: true, actor: `wecom:${user.userid}` });
      batchId = r.code === 0 ? r.data.batchId : 0;
      if (r.code === 0) {
        const hit = get('SELECT series, status, rows_new, rows_updated, note FROM wecom_files WHERE set_id = ? AND sha256 = ?',
          user.set_id, sha);
        if (hit?.status === 'applied') {
          replyText = `✓ 已入库「${realName}」\n系列：${hit.series || '自动识别'}\n新增 ${hit.rows_new} 行，修正 ${hit.rows_updated} 行`;
        } else if (hit?.status === 'duplicate') {
          replyText = `✓ 已收下「${realName}」，但内容与已入账的报表完全相同，未重复记账。`;
        } else if (hit?.status === 'registered') {
          replyText = `已收下「${realName}」，文件名没匹配到已知报表系列，已登记备查。\n建议按「店铺名+日期」重命名后再发一次，例如 歌剧魅影旗舰店日报数据-2026.03.15.xlsx`;
        } else if (hit?.status === 'failed') {
          replyText = `文件已收下，但解析失败：${hit.note || '格式不符'}。请确认是原始 Excel，而不是截图或 PDF。`;
        } else {
          replyText = `已收下「${realName}」，已进入处理队列。`;
        }
        if (r.data.reconcile?.adopted?.length) {
          const a = r.data.reconcile.adopted[0];
          replyText += `\n（该月合计已按汇总表校准：${a.month} ${a.channel} 差异 ${a.diff}）`;
        }
      } else {
        replyText = `文件已收下，但入库失败：${r.message}`;
      }
    } else {
      replyText = `已收下「${realName}」。自动入库已关闭（WECOM_AUTO_SYNC=0），文件存放在投递箱。`;
    }

    const who = user.name || user.userid;
    const dayStr = new Date().toLocaleDateString('sv-SE');
    const marker = publishMedia(saved, realName, dayStr);
    recordChat(user, 'user', `[${who}] 上传文件：${realName}`, who);
    recordChat(user, 'assistant', `📎 已载入报表：${realName}（上传人：${who}）\n${replyText}${marker}`, '助手');
    const hit2 = get('SELECT status, rows_new FROM wecom_files WHERE set_id = ? AND sha256 = ?', user.set_id, sha);
    const dtype = guessDocType(realName);
    recordIntake({
      set_id: user.set_id, source: 'wecom', sender_id: user.userid, sender_name: who,
      category: dtype === 'finance' ? 'finance' : 'sales', doc_type: dtype,
      file_name: realName, file_path: saved, doc_date: guessDocDate(realName),
      batch_id: batchId, rows: hit2 ? Number(hit2.rows_new || 0) : 0,
      status: hit2 ? hit2.status : 'received', sha256: sha,
    });
    run(`INSERT INTO wecom_msg_log (userid, msg_type, file_name, sha256, result, batch_id, raw, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, from, msgType, realName, sha, replyText.slice(0, 200), batchId, m.raw.slice(0, 4000), now());
    run('UPDATE wecom_users SET files_in = files_in + 1 WHERE id = ?', user.id);
    return replyText;
  } catch (e) {
    run(`INSERT INTO wecom_msg_log (userid, msg_type, file_name, result, raw, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      from, msgType, fileName, `失败：${e.message}`.slice(0, 200), m.raw.slice(0, 4000), now());
    recordChat(user, 'assistant', `处理「${fileName}」失败：${e.message}`, '助手');
    return `处理「${fileName}」失败：${e.message}`;
  }
}

/* ---------------- HTTP 入口 ---------------- */

/**
 * 处理企微回调。GET=配置回调地址时的 URL 校验，POST=真实消息。
 * 返回 { status, body, contentType }
 */
export async function handleCallback({ method, query, rawBody }) {
  const cfg = botConfig();
  if (!cfg.ready) {
    return { status: 503, contentType: 'text/plain; charset=utf-8', body: `企微应用未配置，缺少：${cfg.missing.join(', ')}` };
  }
  const sig = query.msg_signature || query.signature;
  const { timestamp, nonce } = query;

  try {
    if (method === 'GET') {
      const plain = verifyAndDecrypt(cfg, { msg_signature: sig, timestamp, nonce, echostr: query.echostr });
      return { status: 200, contentType: 'text/plain; charset=utf-8', body: plain };
    }

    const encrypt = pick(rawBody, 'Encrypt');
    if (!encrypt) return { status: 400, contentType: 'text/plain; charset=utf-8', body: 'missing Encrypt' };
    if (signatureOf(cfg, timestamp, nonce, encrypt) !== String(sig || '')) {
      return { status: 403, contentType: 'text/plain; charset=utf-8', body: 'bad signature' };
    }
    const { xml } = decodeMsg(cfg, encrypt);
    const from = normalizeMessage(xml).from;

    // 企微要求 5 秒内响应，因此先回空串，再异步处理并主动推送结果
    const done = handleMessage(cfg, xml).catch((e) => {
      console.log(`[wecom-bot] 处理消息失败：${e.message}`);
      return '';
    }).then(async (text) => {
      if (text && from) {
        try { await sendText(cfg, from, text); } catch (e) { console.log(`[wecom-bot] 回执失败：${e.message}`); }
      }
    });
    if (typeof done?.catch === 'function') done.catch(() => {});
    return { status: 200, contentType: 'text/plain; charset=utf-8', body: '' };
  } catch (e) {
    return { status: 403, contentType: 'text/plain; charset=utf-8', body: 'verify failed' };
  }
}

export function botStatus() {
  ensureBotTables();
  const cfg = botConfig();
  return {
    code: 0,
    message: cfg.ready ? '企微应用已配置' : `未配置：${cfg.missing.join(', ')}`,
    data: {
      ready: cfg.ready,
      missing: cfg.missing,
      agentId: cfg.agentId || '',
      autoSync: cfg.autoSync,
      users: listBotUsers(),
      recent: all('SELECT * FROM wecom_msg_log ORDER BY id DESC LIMIT 20'),
      inbox: INBOX.replace(/\\/g, '/'),
    },
  };
}
