# 更新日志

## [1.2.0] — 2026-11-12

### 新增

- **本机注册**：`POST /api/auth/register` 仅接受 127.0.0.1 来源；用户名 3-20 位、密码 8-32 位含字母数字；角色可自选管理员/普通用户，默认普通用户。
- **权限分层**：管理类接口（账号/角色/账套/令牌/模型配置）仅管理员；普通用户只读，记账写接口要求管理员或会计/出纳角色；账套按 `account_sets` 限制。
- **账号管理**：更新资料与角色、启停（即时踢线）、分配账套、重置密码，全部真实落库。
- **删除保护**：两阶段确认（60 秒一次性令牌）+ 至少保留一个管理员 + 禁止删除自己；改为软删除（`deleted_at`），凭证创建人可追溯。
- **登录安全**：失败 5 次锁定 15 分钟（落库，重启仍生效）；会话 7 天过期，启动与每小时清理；新增 `/api/auth/logout`。
- **CLI**：`tools/account-cli.mjs`（`npm run account -- …`），删除需三次人工确认。
- **测试**：`tools/test-accounts.mjs` 10 项；回归用例适配两阶段删除；隔离库不再污染 `.local/local-admin.txt`。

## [1.1.1] — 2026-11-12

### 新增

- **三大报表**：`backend/reports.mjs` 提供资产负债表 / 利润表 / 现金流量表计算，`GET /api/reports/{type}?period=` 返回与前端一致的行结构（`code/name/kind/side/level/v1/v2`）。
- **模板与公式**：`report_templates` 落库，支持 `PUT /api/reports/{type}/items`、`POST /api/reports/{type}/reset`、`GET /api/reports/balance/default-formulas`；默认模板按小企业会计准则预置。
- **安全公式引擎**：自研递归下降解析，仅允许四则运算与 `QC/QM/QY/JE/DE/JEL/DEL`；不使用 eval，非法公式保存即拒，计算异常降级为 0 并告警。
- **往来重分类**：应收贷方余额→预收、应付借方余额→预付，开关存 `report_settings`。
- **导出与 MCP**：`get_report` 新增 `balance/income/cash`，导出中心支持五种格式；MCP 工具枚举同步扩展。
- **测试**：`tools/test-reports.mjs` 11 项单元测试；`tools/shoot-readme.mjs` 支持三大报表页面截图。

## [1.1.0] — 2026-11-12

### 新增

- **本地助理会话回写**：`tools/claw-sync.mjs` 把 WorkBuddy 本地助理（Claw / 微信 / 企微）的对话增量写入妆点智能体会话历史。一天一条会话（`claw-YYYYMMDD`，标题「本地助理 · MM-DD」），每条消息带 `[HH:MM]` 前缀与本地时间 `created_at`；按转录事件 id 幂等去重，`--watch` 模式常驻监听，开机自启项 `zd-claw-sync.vbs`。
- **删除不会被复活**：新增 `claw_deleted` 墓碑表与库级触发器 `claw_session_deleted`，用户在界面删掉某天的 `claw-*` 会话后，同步永久跳过；`--restore YYYYMMDD` / `--restore all` 可手动恢复。`cleanup-test-data.mjs` 也改为跳过所有 `claw-*` 会话与消息。
- **会话活跃度接口**：`GET /api/agent/activity` 返回会话数、消息总数与最新消息 id；桌面端注入 7 秒轮询，有新对话时右下角浮出「有新的助理对话，点此刷新」，不打断正在进行的对话。
- 只读写会话表（`agent_sessions` / `agent_messages` / `claw_sync_log`），不触碰任何账务数据表。

## [1.0.0] - 2026-11-11

首个正式版本，完整打包本地财务系统、AI 智能体、Filee 格式转换、MCP 对接与桌面端。

### 新增

- **本地后端**：零外部 npm 依赖，Node.js ESM + `node:sqlite` 多账套隔离；凭证录入校验、科目、看板、报表与下载。
- **AI 智能体**：DeepSeek 接入、技能与工具调用、账套上下文注入的系统提示词。
- **grill-me 式逐步反问**：问题链状态机、编号可点击选项卡片、自由输入固定末项、意图识别、停用/恢复、SSE + REST 双通道。
- **全格式附件录入**：51 种扩展名的零依赖解析，文本与结构化 `columns/rows` 输出，原件留档。
- **会话自动命名**：首条消息即时命名、LLM 可选精修、历史回填、人工命名保护、前端响应式同步。
- **Filee 格式转换**：兼容 Filee CLI 协议的零依赖本地转换桥 + 官方 CLI 可切换，支持 PDF / DOCX / ODS / ODT / RTF / 图片等；完整说明见 `docs/FILEE_INTEGRATION.md`。
- **MCP / WorkBuddy 对接**：`POST /mcp` streamableHttp、stdio 兜底桥、开放令牌鉴权。
- **数据严谨体系**：17 项数据审计、多轮核验与稳定快照哈希、隔离测试运行器、测试数据清理与完整性专项。
- **桌面端**：Electron 外壳、启动器、快捷方式与图标生成脚本。
- **发布物**：`README.md`、`docs/`、`release/` 下 v1.0.0 源码归档。

### 修复（开发期）

- `get_report` 空 rows、MCP notifications 401、追问开关状态错位、Logo 文案残留、系统提示词否认本地账套访问。
- 金额单位「元 / 分」混用导致的展示缩小 100 倍（45 处换算统一），凭证提交字段兼容 `items/subject_id` 与 `entries/subject_code`，并补齐金额与借贷平衡校验。
- 测试凭证残留污染生产库；新增隔离运行、清理与前后快照哈希护栏。
- 会话列表永远显示「新对话」：根因是会话先被创建、旧逻辑只在会话不存在时命名。

### 安全

- `.env`、`.local/`、SQLite 数据库与备份、Electron 运行时二进制、超大逆向产物一律不入库；仓库仅保留 `.env.example` 与脱敏日志。

### 验证

语法检查 20 文件、全量回归 117/117、隔离冒烟 17/17 + 看板 11/11、命名单测 24/24、数据完整性 19/19、数据审计三轮 17/17、真实 Chrome UI 38/38，生产业务数据零变动。
