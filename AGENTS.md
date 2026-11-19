# 本项目的 AI 协作约定

> 详细规则见 `rules/intent-routing.md`、`rules/wecom-reply-rules.md`、`rules/report-rules.md`。
> 变更前先读 `README.md`，改完跑 `npm run check`。

## 一、先分流，再动手（最高优先）

| 类型 | 判断 | 执行方 |
| --- | --- | --- |
| 业务 | 查数 / 统计 / 汇总 / 报表 / 凭证 / 分录 / 科目 / 发票 / 订单 / 固定支出 / 导入 / 录入 / 对账 | **本地财务系统智能体**（MCP `zhuangdian-finance` 或 `/api/*`） |
| 工程 | 改代码 / 加功能 / 改界面样式 / 排序筛选 / 报错 / 部署 / 版本 / 规则口径变更 | **本地开发助理**（本会话） |
| 其他 | 寒暄、指令不明 | 简短回应 + 一句追问 |

判定可用 `POST /api/agent/route`（规则实现，零 token）或 `node tools/test-intent-router.mjs`。
**冲突时工程优先**：如「给报表加一列备注」→ 工程。

## 二、业务类：只互通，不重写

- 一律调本地财务系统接口，**不手写 SQL 重算口径**
- 报表格式以 `rules/report-rules.md` 为准，不自创表头与配色
- 写操作先出摘要等确认；查不到就说没有，不编数字

## 三、工程类：由本地助理执行

- 前端是注入式脚本（`upstream/*.js`），**不改编译产物**
- 改完跑 `npm run check`；更新 `CHANGELOG.md` 与版本号
- 发布：`node tools/push-git.mjs`（直连，带权限预检）

## 四、企微（AIBot 长连接）

- 不透传 userid：靠「姓名：」署名或文件名带姓名归属
- 纯文字 1–2 句；带附件先结论 + 3~5 个关键数字
- 归属不明不要猜，只问一句「请问是哪位？」
