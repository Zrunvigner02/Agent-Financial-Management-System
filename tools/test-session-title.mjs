/** 会话自动命名 · 隔离单元测试
 * 复制一份生产库到临时文件（避免 initialize() 改写 .local/local-admin.txt），
 * 用 ZD_DB_PATH 让 store.mjs 只连副本；全程不碰真实账套。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-title-'));
const DB = path.join(TMP, 'session-title.db');
fs.copyFileSync(path.join(ROOT, 'backend', 'data', 'jinli.db'), DB);
process.env.ZD_DB_PATH = DB;
process.env.ZD_AUTO_TITLE_LLM = '0';   // 单测不调用外部模型

const st = await import('../backend/session-title.mjs');
const biz = await import('../backend/biz.mjs');
const store = await import('../backend/store.mjs');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' :: ' + detail : ''}`);
}
const row = (id) => store.get('SELECT * FROM agent_sessions WHERE id = ?', id);

const baseline = {
  vouchers: store.get('SELECT COUNT(*) AS n FROM vouchers').n,
  entries: store.get('SELECT COUNT(*) AS n FROM voucher_entries').n,
  subjects: store.get('SELECT COUNT(*) AS n FROM subjects').n,
};

try {
  /* 1. 命名算法 */
  check('启发式：把本月的财务报表给我 → 本月的财务报表',
    st.heuristicTitle('把本月的财务报表给我') === '本月的财务报表',
    st.heuristicTitle('把本月的财务报表给我'));
  check('启发式：客套词与语气词被剥离',
    st.heuristicTitle('请帮我查一下6月有哪些凭证？').length >= 4,
    st.heuristicTitle('请帮我查一下6月有哪些凭证？'));
  check('追问选项消息不参与命名', st.heuristicTitle('【澄清选择】chat｜只在消息里看摘要') === '');
  check('系统文案不参与命名', st.heuristicTitle('【已按你的选择输出】报表') === '');
  check('空消息不参与命名', st.heuristicTitle('') === '' && st.heuristicTitle('啊') === '');
  check('标题清洗：去引号/尾标点/截断 18 字',
    st.sanitizeTitle('「本月经营概览」') === '本月经营概览'
    && Array.from(st.sanitizeTitle('会'.repeat(40))).length <= 19,
    st.sanitizeTitle('会'.repeat(40)));
  check('默认名识别', st.isDefaultTitle('新对话') && st.isDefaultTitle('') && !st.isDefaultTitle('本月报表'));

  /* 2. 迁移列存在 */
  const cols = store.all('PRAGMA table_info(agent_sessions)').map((c) => c.name);
  check('agent_sessions.title_source 迁移列存在', cols.includes('title_source'));

  /* 3. 前端提前建会话 → 首条消息自动命名 */
  const s1 = biz.createAgentSession(85).data;
  check('新建会话初始名为「新对话」', s1.title === '新对话', s1.title);
  const t1 = st.trackFirstMessage(85, s1.id, '把本月的财务报表给我');
  check('首条消息触发命名事件', t1 && t1.changed && t1.title === '本月的财务报表', JSON.stringify(t1));
  check('命名已落库且标记为 auto', row(s1.id).title === '本月的财务报表' && row(s1.id).title_source === 'auto');
  check('第二条消息不重复改名', st.trackFirstMessage(85, s1.id, '再给我一份资产负债表') === null);

  /* 4. 手动重命名受保护 */
  biz.updateAgentSession(85, s1.id, { title: '我自己起的名字' });
  check('手动重命名落库', row(s1.id).title === '我自己起的名字' && row(s1.id).title_source === 'manual');
  check('后续消息不覆盖人工名称', st.trackFirstMessage(85, s1.id, '换个问题问') === null
    && row(s1.id).title === '我自己起的名字');
  const rf = await st.refineTitle(85, s1.id);
  check('LLM 精修也不覆盖人工名称', rf && rf.changed === false && row(s1.id).title === '我自己起的名字');

  /* 5. 会话不存在时一步到位命名 */
  const s2id = 'title-unit-implicit';
  const t2 = st.trackFirstMessage(85, s2id, '本月各科目余额');
  check('隐式会话创建即带名字', t2 && t2.title === '本月各科目余额' && row(s2id).title === '本月各科目余额',
    JSON.stringify(t2));

  /* 6. 历史「新对话」回填（模拟升级前遗留数据） */
  const s3 = biz.createAgentSession(85).data;
  store.run('INSERT INTO agent_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    s3.id, 'user', '【澄清选择】chat｜只在消息里看摘要', store.now());
  store.run('INSERT INTO agent_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    s3.id, 'user', '6月进销项税负是多少？', store.now());
  const filled = st.backfillTitles(85);
  const row3 = row(s3.id);
  check('历史会话按首条真实消息回填', filled.some((x) => x.session_id === s3.id)
    && !st.isDefaultTitle(row3.title) && row3.title_source === 'auto', row3.title);
  check('回填幂等（再跑一次不产生变更）', st.backfillTitles(85).length === 0);

  /* 7. 账套隔离 */
  const s4id = 'title-unit-other-set';
  store.run('INSERT INTO agent_sessions (id, set_id, title, title_source, created_at) VALUES (?, ?, ?, ?, ?)',
    s4id, 86, '新对话', '', store.now());
  check('跨账套不会误改会话名', st.applyFirstMessageTitle(85, s4id, '把本月报表给我') === null
    && row(s4id).title === '新对话');
  check('跨账套精修返回 null', (await st.refineTitle(85, s4id)) === null);

  /* 8. LLM 关闭时精修回退本地标题 */
  const s5 = biz.createAgentSession(85).data;
  store.run('INSERT INTO agent_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    s5.id, 'user', '把本月的利润表给我', store.now());
  const r5 = await st.refineTitle(85, s5.id);
  check('模型关闭时精修回退启发式', r5 && r5.source === 'heuristic'
    && row(s5.id).title === '本月的利润表', JSON.stringify(r5));

  /* 9. 账务数据零变动（多轮核验） */
  for (let round = 1; round <= 3; round++) {
    const cur = {
      vouchers: store.get('SELECT COUNT(*) AS n FROM vouchers').n,
      entries: store.get('SELECT COUNT(*) AS n FROM voucher_entries').n,
      subjects: store.get('SELECT COUNT(*) AS n FROM subjects').n,
    };
    check(`账务数据零变动 · 第 ${round} 轮`, JSON.stringify(cur) === JSON.stringify(baseline),
      JSON.stringify(cur));
  }
} finally {
  try { store.db.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nSESSION_TITLE_TEST ${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
