/**
 * 意图路由：按用户这句话，决定这一轮把哪些工具交给模型。
 * 目的是省 token，同时保证「该有的工具一定在」。
 *
 * 返回：
 *   { names, groups, matched, level }
 *   level: narrow（命中具体业务组）/ medium（没命中，给常用中等集合）/ full（调用方要求全量）
 */

export const TOOL_GROUPS = {
  order: ['list_orders', 'create_order', 'update_order_status', 'change_order_price',
    'return_order_items', 'add_shipment', 'order_summary', 'logistics_summary'],
  recurring: ['list_recurring', 'save_recurring', 'generate_recurring', 'adjust_recurring', 'recurring_reminder'],
  report: ['get_report', 'list_vouchers', 'get_ledger', 'data_audit', 'expense_detail'],
  voucher: ['create_voucher', 'list_vouchers', 'get_voucher', 'list_subjects', 'get_ledger', 'get_closing_status'],
  file: ['list_attachments', 'ocr_file', 'convert_file', 'file_formats', 'read_attachment'],
  tag: ['list_tags', 'save_tag'],
  account: ['list_sets', 'list_assets', 'list_asset_categories', 'list_invoices', 'create_invoice_voucher'],
  sales: ['list_channels', 'save_channel', 'list_sales', 'import_sales', 'list_ops', 'list_distribution'],
  kb: ['add_doc', 'search_docs', 'list_docs', 'add_work_report', 'list_work_reports'],
};

export const CORE_TOOLS = ['list_sets', 'list_orders', 'list_recurring', 'get_report'];

// 顺序即优先级：一句话可能同时命中多组，全部保留
export const INTENT_RULES = [
  ['order', [
    /订单|单量|几单|下单|接单|成交|这单|该单|本单|这票|单子/,
    /退货|换货|退款|退一|退了|退掉|退单/,
    /物流|快递|运单|发货|没发|未发|签收|揽收|派送|运输|顺丰|中通|圆通|韵达|京东配送/,
    /客户|渠道|销售|单号|欠款|应收款|收款/,
  ]],
  ['recurring', [
    /固定支出|周期支出|每月支出|月度支出/,
    /工资|薪水|薪资|社保|公积金|房租|月租|租金|水电|物业|宽带/,
    /离职|调薪|涨薪|降薪/,
  ]],
  ['file', [
    /附件|文件|图片|照片|扫描|截图/,
    /发票|票据|收据|对账单/,
    /ocr|识别|提取文字|转文字/i,
    /转(格式|成|为)|pdf|docx|word|excel|xlsx|csv|json|markdown/i,
  ]],
  ['tag', [/标注|标记|钱货两讫|结清|作废|暂停/]],
  ['report', [
    /报表|财报|利润表|资产负债|现金流|三大表/,
    /看板|趋势|对比|环比|同比|结构/,
    /毛利|毛利率|净利|赚|亏|盈亏|收入|营收|成本|费用|税金/,
    /汇总|统计|分析|占比|排名|top/i,
    /应收|应付|余额|账户余额/,
  ]],
  ['voucher', [/凭证|记账|分录|借贷|科目|账簿|明细账|结账|期初|摊销|计提/,
    /记一笔|记个账|帮我记|录一笔|做账|入账/]],
  ['account', [/账号|权限|用户|密码|账套|角色|管理员|普通用户|开个号|注册/]],
  ['sales', [/销售数据|销量|日销|平台数据|运营数据|花费|投流|分销|店铺|渠道|旺店通|导入数据/]],
  ['kb', [/制度|规定|流程|SOP|合同|文档|资料|知识库|查一下.*(制度|流程)|汇报|周报|日报|工作总结|员工/]],
];

/** 没命中任何业务组时的中等集合：常用查询 + 订单，避免一次给 41 个 */
const MEDIUM_GROUPS = ['order', 'report'];

export function matchGroups(message) {
  const text = String(message || '');
  const groups = [];
  for (const [group, rules] of INTENT_RULES) {
    if (rules.some((re) => re.test(text))) groups.push(group);
  }
  return groups;
}

/**
 * @param {string} message 用户原话
 * @param {{full?: boolean}} opts full=true 时返回全量工具名（供二次兜底）
 * @param {string[]} allTools 全量工具名
 */
export function pickToolNames(message, { full = false, allTools = [] } = {}) {
  if (full) return { names: new Set(allTools), groups: [], matched: true, level: 'full' };
  const groups = matchGroups(message);
  const names = new Set(CORE_TOOLS);
  if (groups.length) {
    for (const g of groups) for (const n of TOOL_GROUPS[g] || []) names.add(n);
    return { names, groups, matched: true, level: 'narrow' };
  }
  for (const g of MEDIUM_GROUPS) for (const n of TOOL_GROUPS[g] || []) names.add(n);
  return { names, groups: [], matched: false, level: 'medium' };
}

/** 回复里出现这些词，说明模型可能缺工具，值得用全量工具重试一次 */
export const CAPABILITY_HINTS = /无法(查询|获取|完成|处理)|不支持|没有(该|此)?(权限|功能|工具)|查不到|暂无(该|此)?功能|我做不到|需要(更高|更多)权限/;

export const needsFullRetry = (text, usedTool) => !usedTool && CAPABILITY_HINTS.test(String(text || ''));
