/**
 * 意图路由：判断一句话该交给「财务系统智能体」还是「本地开发助理」。
 *
 * 规则（2026-11-19 用户确认）：
 *   1. 查询 / 录入 / 报表 / 凭证 / 订单 / 固定支出 等业务动作 → finance（交给财务系统智能体）
 *   2. 改代码 / 加功能 / 修 bug / 部署 / 改界面 等工程动作 → dev（交给本地助理）
 *   3. 两者都不像（寒暄、闲聊、指令不明） → other（由调用方决定，一般先简短回应并追问）
 *
 * 纯规则实现：零 token 成本、毫秒级、结果可解释。需要时可在此之上叠加模型兜底。
 */

const DEV_RULES = [
  /(改|写|加|增加|新增|实现|开发|重构|删掉|去掉|调整)\s*(一下)?\s*(代码|功能|接口|页面|样式|布局|按钮|字段|逻辑|脚本|组件|模块)/,
  /(代码|功能|接口|页面|样式|布局|按钮|脚本|组件|模块)\s*(改|写|加|调|修)/,
  /前端|后端|注入|编译|打包|构建|部署|上线|发布|版本号|changelog|readme/i,
  /(加|增加|新增|去掉|删除|调整|改)\s*[一1]?\s*(个|列|行|条|张|处)?\s*(按钮|列|字段|备注|筛选|排序|导出|图表|标签|入口|菜单|页面|功能|接口|tab)/i,
  /(看板|列表|页面|界面|侧栏|菜单|报表中心)\S{0,8}(加|增加|新增|改|调整|去掉|删)/,
  /(把|给)\S{0,10}(列表|表格|看板|明细)\S{0,8}(排序|筛选|分组|折叠)/,
  /(改|修改|调整|更新)\s*(一下)?\s*\S{0,8}(规则|口径|公式|模板|配置|文档)/,
  /(规则|口径|公式|模板|配置|文档)\S{0,4}(改|修改|调整|更新|换掉)/,
  /报错|错误|异常|崩溃|闪退|白屏|打不开|不生效|没反应|bug|debug|排查|复现/i,
  /\bgit\b|commit|push|pull\s*request|分支|合并|回滚|仓库/i,
  /数据库|表结构|字段类型|migration|索引|sql\b|schema/i,
  /安装|依赖|npm|node_modules|环境变量|\.env|配置环境/i,
  /爬虫|自动化脚本|批量重命名|定时任务|接口对接/i,
];

const FIN_RULES = [
  /查|看|统计|汇总|多少|几笔|明细|列表|导出|打印/,
  /销售|退款|营收|收入|成本|毛利|净利|利润|费用|费比|净利率|毛利率/,
  /凭证|分录|科目|借贷|余额|总账|明细账|期初|结账|审计/,
  /发票|税额|增值税|进项|销项|开票/,
  /订单|发货|物流|客户|退货|改价|结清/,
  /固定支出|工资|房租|社保|水电|摊销/,
  /应付|应收|往来|账龄|核销|坏账/,
  /导入|上传|录入|记账|入账|补录|对账|核账/,
  /报表|日报|月报|季报|年报|台账/,
  /渠道|天猫|京东|拼多多|店铺|品牌|SKU|单品/i,
];

function hits(rules, text) {
  const matched = [];
  for (const re of rules) if (re.test(text)) matched.push(String(re).slice(0, 24));
  return matched;
}

export function classifyIntent(raw) {
  const text = String(raw || '').trim();
  if (!text) return { intent: 'other', dev: 0, fin: 0, reason: '空消息', matched: {} };
  const devHit = hits(DEV_RULES, text);
  const finHit = hits(FIN_RULES, text);
  const dev = devHit.length;
  const fin = finHit.length;

  // 工程类优先：一旦命中开发特征，即使同时提到"报表/凭证"也归开发（例：给报表加一列）
  let intent = 'other';
  if (dev > 0) intent = 'dev';
  else if (fin > 0) intent = 'finance';
  else if (/^(你好|hi|hello|在吗|谢谢|收到)[！!。.\s]*$/i.test(text)) intent = 'other';

  const reason = intent === 'dev'
    ? `命中开发特征：${devHit.slice(0, 3).join(' | ')}`
    : intent === 'finance'
      ? `命中业务特征：${finHit.slice(0, 3).join(' | ')}`
      : '未命中明确特征';

  return { intent, dev, fin, reason, matched: { dev: devHit.slice(0, 5), fin: finHit.slice(0, 5) } };
}

/** 路由后的动作建议，供调用方直接使用 */
export function routeAction(text) {
  const r = classifyIntent(text);
  const map = {
    finance: { handler: 'finance-agent', reply: '', note: '交给财务系统智能体：查数/录入/出报表' },
    dev: { handler: 'local-dev-agent', reply: '这类属于开发改动，我转给本地助理处理，稍后同步进展。', note: '交给本地开发助理：改代码/加功能/修问题' },
    other: { handler: 'clarify', reply: '', note: '意图不明，先简短回应并追问一句' },
  };
  return { ...r, ...map[r.intent] };
}
