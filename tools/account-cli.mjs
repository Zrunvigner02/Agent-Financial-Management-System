#!/usr/bin/env node
/**
 * account-cli —— 本地账号管理命令行（不需要开服务，直连 SQLite）
 *
 * 为什么有这个工具：网页/桌面端的注册入口只给本机用，且删除账号要走两阶段确认；
 * 命令行适合「运维视角」的批量、可审计操作，尤其是删除这种不可逆动作。
 *
 *   node tools/account-cli.mjs list
 *   node tools/account-cli.mjs register <用户名> --password <密码> [--role admin|user] [--name 张三]
 *   node tools/account-cli.mjs passwd <用户名> --password <新密码>
 *   node tools/account-cli.mjs role <用户名> admin|user
 *   node tools/account-cli.mjs status <用户名> on|off
 *   node tools/account-cli.mjs sets <用户名> 85,86          # 空字符串表示不限制
 *   node tools/account-cli.mjs unlock <用户名>             # 清除登录失败锁定
 *   node tools/account-cli.mjs delete <用户名>             # 三次人工确认后才执行（软删除）
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as biz from '../backend/biz.mjs';
import { db, get, all, run, now, hashPassword } from '../backend/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, arg1] = process.argv.slice(2);
const opt = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? String(process.argv[i + 1] || '') : '';
};
const out = (o, code = 0) => { console.log(JSON.stringify(o, null, 2)); process.exit(code); };
const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); resolve(String(a || '').trim()); });
});

if (!fs.existsSync(path.join(ROOT, 'backend', 'data', 'jinli.db'))) {
  out({ ok: false, error: '找不到账套数据库，请先启动一次本系统' }, 1);
}

if (cmd === 'list' || !cmd) {
  out({ ok: true, accounts: biz.listAccounts('').data });
}

if (cmd === 'register') {
  if (!arg1) out({ ok: false, error: '用法：register <用户名> --password <密码> [--role admin|user]' }, 1);
  const r = biz.register({
    username: arg1,
    password: opt('password'),
    name: opt('name') || arg1,
    role: opt('role') || 'user',
  }, '127.0.0.1');
  if (r.code !== 0) out({ ok: false, error: r.message }, 1);
  out({ ok: true, username: r.data.username, role: r.data.role, message: '账号已创建' });
}

if (cmd === 'passwd') {
  const u = get('SELECT * FROM users WHERE username = ? AND (deleted_at IS NULL OR deleted_at = \'\')', arg1 || '');
  if (!u) out({ ok: false, error: '账号不存在' }, 1);
  const pwd = opt('password');
  const problem = biz.passwordProblem(pwd);
  if (problem) out({ ok: false, error: problem }, 1);
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(pwd), u.id);
  run('DELETE FROM sessions WHERE user_id = ?', u.id);
  out({ ok: true, message: `已重置 ${u.username} 的密码，其所有登录态已失效` });
}

if (cmd === 'role') {
  const want = String(process.argv[4] || '');
  if (!['admin', 'user', '管理员', '普通用户'].includes(want)) out({ ok: false, error: '角色只能是 admin 或 user' }, 1);
  const u = get('SELECT * FROM users WHERE username = ?', arg1 || '');
  if (!u) out({ ok: false, error: '账号不存在' }, 1);
  const r = biz.updateAccount(u.id, { role: want === 'admin' || want === '管理员' ? '管理员' : '普通用户' });
  out({ ok: r.code === 0, message: r.message });
}

if (cmd === 'status') {
  const want = String(process.argv[4] || '');
  const u = get('SELECT * FROM users WHERE username = ?', arg1 || '');
  if (!u) out({ ok: false, error: '账号不存在' }, 1);
  const r = biz.setAccountStatus(u.id, want === 'on' || want === '1', null);
  out({ ok: r.code === 0, message: r.message });
}

if (cmd === 'sets') {
  const u = get('SELECT * FROM users WHERE username = ?', arg1 || '');
  if (!u) out({ ok: false, error: '账号不存在' }, 1);
  const ids = String(process.argv[4] || '').split(',').map((x) => Number(x.trim())).filter(Boolean);
  const r = biz.saveAccountSets(u.id, ids);
  out({ ok: r.code === 0, message: r.message, set_ids: ids });
}

if (cmd === 'unlock') {
  run('DELETE FROM login_attempts WHERE key LIKE ?', `${String(arg1 || '').toLowerCase()}|%`);
  out({ ok: true, message: '已清除该账号的登录失败锁定' });
}

if (cmd === 'delete') {
  const u = get("SELECT * FROM users WHERE username = ? AND (deleted_at IS NULL OR deleted_at = '')", arg1 || '');
  if (!u) out({ ok: false, error: '账号不存在或已删除' }, 1);
  const admins = all("SELECT id FROM users WHERE role = '管理员' AND status = 1 AND (deleted_at IS NULL OR deleted_at = '')");
  if (u.role === '管理员' && admins.length <= 1) out({ ok: false, error: '至少保留一个管理员账号' }, 1);

  console.log(`即将删除账号：${u.username}（id=${u.id}，角色 ${u.role}）`);
  console.log('该操作会把账号标记为已删除、强制下线，并释放用户名占用。');
  const a1 = await ask(`第 1/3 步：请输入完整用户名确认：`);
  if (a1 !== u.username) out({ ok: false, error: '用户名不一致，已取消' }, 1);
  const a2 = await ask('第 2/3 步：再次输入完整用户名：');
  if (a2 !== u.username) out({ ok: false, error: '用户名不一致，已取消' }, 1);
  const a3 = await ask('第 3/3 步：输入 DELETE 执行删除（其它任意内容取消）：');
  if (a3 !== 'DELETE') out({ ok: false, error: '已取消' }, 1);

  const r = biz.deleteAccount(u.id, null, {});
  if (r.code !== 428) out({ ok: false, error: r.message }, 1);
  const r2 = biz.deleteAccount(u.id, null, { token: r.data.token });
  out({ ok: r2.code === 0, message: r2.message });
}

out({ ok: false, error: '用法：list | register | passwd | role | status | sets | unlock | delete' }, 1);
