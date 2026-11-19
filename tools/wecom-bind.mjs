#!/usr/bin/env node
/**
 * 企微自建应用 · 成员绑定/状态小工具（零依赖，直接读本机库）
 *
 * 自建应用走「未绑定即拒绝」策略：任何人第一次发消息都会被拦下并留痕，
 * 管理员确认身份后才能用。这里提供命令行来完成绑定，省得去拼 HTTP 请求。
 *
 * 用法：
 *   node tools/wecom-bind.mjs                       # 看配置状态 + 已绑定成员 + 待绑定
 *   node tools/wecom-bind.mjs --pending             # 只看被拦下的未绑定 userid
 *   node tools/wecom-bind.mjs --bind zhangsan --name 张三 --role 汇报者
 *   node tools/wecom-bind.mjs --bind lisi --name 李四 --no-upload   # 只许查询不许传文件
 *   node tools/wecom-bind.mjs --disable zhangsan    # 停用（保留历史留痕）
 *   node tools/wecom-bind.mjs --enable zhangsan
 */
import { botConfig, botStatus, listBotUsers, saveBotUser } from '../backend/wecom-bot.mjs';
import { get, all, run } from '../backend/store.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const cfg = botConfig();

function showStatus() {
  console.log('');
  console.log('  企微自建应用 · 状态');
  console.log('  ─────────────────────────────────');
  console.log(`  配置      ${cfg.ready ? '已就绪' : '未就绪'}`);
  if (!cfg.ready) console.log(`  缺少      ${cfg.missing.join(', ')}`);
  console.log(`  AgentId   ${cfg.agentId || '（空）'}`);
  console.log(`  自动入库  ${cfg.autoSync ? '开' : '关'}`);
  console.log('');
  const users = listBotUsers();
  if (!users.length) {
    console.log('  已绑定成员：无');
  } else {
    console.log('  已绑定成员：');
    for (const u of users) {
      console.log(`    ${u.enabled ? '✓' : '×'} ${u.userid.padEnd(18)} ${String(u.name || '').padEnd(8)} ${String(u.role || '').padEnd(6)} 上传=${u.can_upload ? '允许' : '禁止'}`);
    }
  }
  console.log('');
  const recent = all(`SELECT l.userid, COALESCE(u.name, '') AS name, l.msg_type, l.file_name, l.result, l.created_at
    FROM wecom_msg_log l LEFT JOIN wecom_users u ON u.userid = l.userid
    ORDER BY l.id DESC LIMIT 10`);
  if (recent.length) {
    console.log('  最近消息留痕：');
    for (const r of recent) console.log(`    ${r.created_at}  ${String(r.userid || '').padEnd(18)} ${String(r.name || '').padEnd(8)} ${r.result}`);
    console.log('');
  }
}

function showPending() {
  const rows = all(`
    SELECT l.userid, MAX(l.created_at) AS last_at, COUNT(*) AS n
    FROM wecom_msg_log l
    LEFT JOIN wecom_users u ON u.userid = l.userid
    WHERE u.id IS NULL AND l.userid <> ''
    GROUP BY l.userid ORDER BY last_at DESC`);
  if (!rows.length) return console.log('没有待绑定成员。');
  console.log('待绑定（发过消息但还没授权）：');
  for (const r of rows) console.log(`  ${r.userid.padEnd(20)} 消息 ${r.n} 条，最近 ${r.last_at}`);
  console.log('\n授权：node tools/wecom-bind.mjs --bind <userid> --name 姓名');
}

function main() {
  if (has('--help') || has('-h')) {
    console.log('用法：node tools/wecom-bind.mjs [--pending | --bind <userid> [--name 姓名] [--role 汇报者] [--set 85] [--no-upload] | --disable <userid> | --enable <userid>]');
    return;
  }
  if (has('--pending')) return showPending();

  const bind = val('--bind');
  if (bind) {
    const out = saveBotUser({
      userid: bind,
      name: val('--name'),
      role: val('--role', '汇报者'),
      set_id: Number(val('--set', 0)) || undefined,
      can_upload: has('--no-upload') ? false : true,
      enabled: true,
    });
    console.log(out.code === 0 ? `✓ ${out.message}` : `✗ ${out.message}`);
    return;
  }

  for (const [flag, enabled] of [['--disable', false], ['--enable', true]]) {
    const id = val(flag);
    if (!id) continue;
    const row = get('SELECT id FROM wecom_users WHERE userid = ?', id);
    if (!row) return console.log(`✗ 未找到 ${id}`);
    run('UPDATE wecom_users SET enabled = ? WHERE id = ?', enabled ? 1 : 0, row.id);
    return console.log(`✓ ${id} 已${enabled ? '启用' : '停用'}`);
  }

  const st = botStatus();
  console.log('');
  console.log(`  ${st.message}`);
  showStatus();
}

main();
