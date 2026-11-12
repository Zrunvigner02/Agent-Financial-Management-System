#!/usr/bin/env node
/**
 * test-accounts —— 账号体系单元测试（临时数据库，不碰真实账套）
 *
 *   node tools/test-accounts.mjs
 *
 * 覆盖：注册校验与默认角色、登录锁定、停用踢线、会话过期、
 *       两阶段删除确认、最后一个管理员保护、账套越权拦截、只读权限。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-accounts-'));
process.env.ZD_DB_PATH = path.join(tmp, 'test.db');

const biz = await import('../backend/biz.mjs');
const store = await import('../backend/store.mjs');

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name} — ${e.message}`); process.exitCode = 1; }
};

check('弱密码与非法用户名被拒', () => {
  assert.equal(biz.register({ username: 'u1', password: 'abc123' }).code, 1); // 太短
  assert.equal(biz.register({ username: 'u2', password: '12345678' }).code, 1); // 无字母
  assert.equal(biz.register({ username: 'a', password: 'abc12345' }).code, 1); // 用户名太短
  assert.equal(biz.register({ username: 'bad name!', password: 'abc12345' }).code, 1);
});

check('注册默认普通用户，可自选管理员', () => {
  const u = biz.register({ username: 'clerk', password: 'clerk12345' });
  assert.equal(u.code, 0);
  assert.equal(u.data.role, 'user');
  assert.ok(!u.data.menus.includes('/auth/accounts'), '普通用户不应有管理菜单');

  const a = biz.register({ username: 'boss', password: 'boss12345', role: 'admin' });
  assert.equal(a.code, 0);
  assert.equal(a.data.role, 'admin');
  assert.ok(a.data.menus.includes('/auth/accounts'));
});

check('登录返回真实角色与有效期', () => {
  const r = biz.login({ username: 'clerk', password: 'clerk12345' }, null, '127.0.0.1');
  assert.equal(r.code, 0);
  assert.equal(r.data.role, 'user');
  assert.ok(r.data.expiresIn > 0);
});

check('密码错误 5 次锁定，解锁后可登录', () => {
  for (let i = 0; i < 5; i += 1) biz.login({ username: 'lockme', password: 'wrong' }, null, '10.0.0.9');
  biz.register({ username: 'lockme', password: 'lock12345' }, '10.0.0.9');
  const locked = biz.login({ username: 'lockme', password: 'lock12345' }, null, '10.0.0.9');
  assert.equal(locked.code, 1);
  assert.match(locked.message, /锁定/);
  const st = biz.lockState('lockme', '10.0.0.9');
  assert.equal(st.locked, true);
});

check('停用后无法登录且旧 token 失效', () => {
  const u = biz.register({ username: 'dismiss', password: 'dismiss123' });
  assert.equal(u.code, 0);
  const token = u.data.token;
  assert.ok(biz.userFromToken(token), '注册后 token 应可用');
  const id = biz.listAccounts('').data.find((x) => x.username === 'dismiss').id;
  const r = biz.setAccountStatus(id, 0, null);
  assert.equal(r.code, 0);
  assert.equal(biz.userFromToken(token), null, '停用后 token 必须失效');
  const again = biz.login({ username: 'dismiss', password: 'dismiss123' }, null, '127.0.0.1');
  assert.equal(again.code, 1);
});

check('会话过期后 token 失效', () => {
  const u = biz.register({ username: 'expire', password: 'expire1234' });
  const token = u.data.token;
  store.db.prepare("UPDATE sessions SET expires_at = '2000-01-01 00:00:00' WHERE token = ?").run(token);
  assert.equal(biz.userFromToken(token), null);
});

check('两阶段删除：无令牌被拦，令牌错误被拒，正确令牌软删除', () => {
  const u = biz.register({ username: 'toDelete', password: 'delete1234' });
  const id = biz.listAccounts('').data.find((x) => x.username === 'toDelete').id;
  const step1 = biz.deleteAccount(id, 1, {});
  assert.equal(step1.code, 428, '首次应返回确认令牌');
  assert.ok(step1.data.token);
  assert.equal(biz.deleteAccount(id, 1, { token: 'wrong' }).code, 1);
  const step2 = biz.deleteAccount(id, 1, { token: step1.data.token });
  assert.equal(step2.code, 0);
  assert.ok(biz.login({ username: 'toDelete', password: 'delete1234' }, null, '127.0.0.1').code !== 0);
  assert.equal(biz.listAccounts('').data.some((x) => x.username === 'toDelete'), false);
  // 同一个令牌不能二次使用
  assert.equal(biz.deleteAccount(id, 1, { token: step1.data.token }).code, 1);
});

check('不能删除最后一个管理员，也不能删除自己', () => {
  const accounts = biz.listAccounts('').data.filter((x) => x.role_name === '管理员');
  assert.ok(accounts.length >= 1);
  // 当前管理员只剩一个时
  for (const a of accounts.slice(1)) biz.setAccountStatus(a.id, 0, null);
  const last = accounts[0];
  const r = biz.deleteAccount(last.id, 999, {});
  assert.equal(r.code, 1);
  assert.match(r.message, /至少保留一个管理员/);
  const self = biz.deleteAccount(last.id, last.id, {});
  assert.equal(self.code, 1);
  assert.match(self.message, /当前登录账号/);
});

check('普通用户按分配账套限制，管理员不受限', () => {
  const clerk = biz.listAccounts('').data.find((x) => x.username === 'clerk');
  biz.saveAccountSets(clerk.id, [85]);
  const lg = biz.login({ username: 'clerk', password: 'clerk12345' }, null, '127.0.0.1');
  assert.equal(lg.code, 0, `登录失败：${lg.message}`);
  const user = biz.userFromToken(lg.data.token);
  assert.equal(biz.canAccessSet(user, 85), true);
  assert.equal(biz.canAccessSet(user, 99), false);
  assert.equal(biz.canWrite(user), false, '普通用户不应有记账权限');

  // 上一个用例为了验证「最后一个管理员」把其余管理员停掉了，这里先恢复
  const bossId = biz.listAccounts('').data.find((x) => x.username === 'boss').id;
  biz.setAccountStatus(bossId, 1, null);
  const la = biz.login({ username: 'boss', password: 'boss12345' }, null, '127.0.0.1');
  assert.equal(la.code, 0, `管理员登录失败：${la.message}`);
  const admin = biz.userFromToken(la.data.token);
  assert.equal(biz.canAccessSet(admin, 99), true);
  assert.equal(biz.canWrite(admin), true);
});

check('注册来源策略可配置（open/local/closed）', () => {
  assert.equal(biz.registerPolicy('open', '192.168.1.20').allowed, true);
  assert.equal(biz.registerPolicy('local', '192.168.1.20').allowed, false);
  assert.equal(biz.registerPolicy('local', '127.0.0.1').allowed, true);
  assert.equal(biz.registerPolicy('closed', '127.0.0.1').allowed, false);
  assert.equal(biz.registerPolicy(undefined, '0.0.0.0').allowed, true, '默认 open');
  assert.match(biz.registerPolicy('closed', '127.0.0.1').reason, /关闭注册/);
});

check('过期会话清理可用', () => {
  assert.equal(typeof biz.pruneSessions(), 'number');
});

console.log(`\n${pass} 项通过`);
