#!/usr/bin/env node
/** 意图路由自测：node tools/test-intent-router.mjs */
import { classifyIntent } from '../backend/intent-router.mjs';

const CASES = [
  ['11月天猫销售额多少', 'finance'],
  ['查一下上个月的退款率', 'finance'],
  ['把10月的销售表导入一下', 'finance'],
  ['这个月固定支出有哪些', 'finance'],
  ['订单发货状态能看吗', 'finance'],
  ['10月利润表导出给我', 'finance'],
  ['把京东的明细导出来', 'finance'],
  ['帮我把凭证列表加一列备注', 'dev'],
  ['报表页面报错白屏了', 'dev'],
  ['给销售看板加个导出按钮', 'dev'],
  ['修一下前端登录过期的问题', 'dev'],
  ['侧栏菜单顺序调整一下', 'dev'],
  ['把订单列表按金额排序', 'dev'],
  ['帮我改一下报表生成规则', 'dev'],
  ['把报表模板更新一下', 'dev'],
  ['你好', 'other'],
  ['今天天气不错', 'other'],
];

let ok = 0;
for (const [text, want] of CASES) {
  const r = classifyIntent(text);
  const pass = r.intent === want;
  if (pass) ok += 1;
  console.log(`${pass ? '✓' : '✗'} ${text} → ${r.intent}（期望 ${want}）`);
}
console.log(`\n意图路由：${ok}/${CASES.length} 通过`);
process.exit(ok === CASES.length ? 0 : 1);
