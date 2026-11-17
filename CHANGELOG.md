# 更新日志

## [1.7.2] — 2026-11-17

### 新增

- `tools/xls-read.mjs`：零依赖 BIFF8 读取器，可直接解析老式 .xls。
- `tools/sales-import.mjs`：导入京东/拼多多/天猫/小红书销售数据，落 `sales_daily`，口径 `platform`。
- `tools/make-sales-report.mjs`：按样例结构生成销售报表（总月对比/品牌月对比/日汇总），金额与百分比带格式。

### 数据

- 首次导入 1311 行，7 个渠道；2026-11 销售额 220,451.00，退款 500.40，推广费 11,471.77。

## [1.7.1] — 2026-11-17

### 新增

- 商品主数据与别名映射：`products` / `product_aliases`，导入时按别名归到统一 SKU。
- 销售日数据补全字段：费用、毛利、净利、商品分组，导入时自动计算（毛利=金额-退货-成本，净利=毛利-费用）。
- 双口径对比接口 `GET /api/enterprise/sales/compare`，支持按商品/日期/渠道，返回差额与差异率。
- 新增工具：`list_products`、`save_product`、`sales_compare`（共 55 个）。
- 测试：企业助手 11 项。

## [1.7.0] — 2026-11-17

### 新增（框架扩充）

- 数据域表：销售渠道、销售日数据、运营花费、分销商与分销业绩、工作汇报、文档与分块、导入模板。
- 已实现接口：渠道维护、销售导入/查询（销售部与旺店通双口径）、汇报读写、文档入库与检索（关键词 + 出处）。
- 占位接口：运营花费、分销业绩（只读，待模板确定）。
- 意图路由新增 sales / kb 两组。
- 测试：`tools/test-enterprise.mjs` 8 项。

## [1.6.3] — 2026-11-16

### 优化

- **意图路由模块化**：`backend/toolrouter.mjs` 提供 `pickToolNames` / `matchGroups` / `needsFullRetry`，规则覆盖订单、固定支出、文件、标注、报表、凭证、账号七组，并补同义词。
- **两级兜底**：无命中给中等集合（核心 + 订单 + 报表）；首轮未调工具且回复含「无法/不支持/查不到」时，自动全量工具重试一次。
- **能力边界**：系统提示新增规则——数据不足时说明缺什么，不硬调工具、不编造。
- **测试**：`tools/test-toolrouter.mjs` 20 项。

## [1.6.2] — 2026-11-16

### 优化

- **意图级工具注入**：新增 `pickToolNames()`，按关键词把工具分成订单/固定支出/报表/凭证/文件/标注/账号七组，每轮只暴露相关工具（通常 3–10 个），输入 token 明显下降。
- **工具描述压缩**：41 个工具描述统一改为短语。
- **写后回读校验**：`verifyWrite()` 在写工具成功后回读订单/固定支出/凭证现状，返回摘要供模型复述；校验异常时标注并要求人工核对。
- **对话铁律**：代码与表结构改动先列条例等确认；数据写入必须给变更摘要；回复默认简洁。

## [1.6.1] — 2026-11-16

### 新增

- **固定支出明细下钻**：面板每项可点击，弹层展示每月金额、入账日、启用状态、单独调整与近 12 个月生成记录（含凭证号），并可直接让智能体改。
- **订单并入明细账**：`GET /api/ledger/timeline` 把凭证分录与订单事件合并成一条时间轴；订单抽屉新增「明细账」页签，订单行可点进详情。
- 接口：`GET /api/recurring/:id/history`。
- 测试：订单 10 项、固定支出 18 项。

## [1.6.0] — 2026-11-16

### 新增

- **订单域**：`orders` / `order_items` / `order_events` / `order_price_changes` / `order_shipments` 五张表。
- **状态与流转**：进行中、部分发货、已结清、退货中、已退货、已取消；每次变更写时间线。
- **退货**：按明细退、整单退；全部退完自动转「已退货」，超量退货被拒。
- **改价**：记录原价→新价与原因，重算订单金额，可统计低价销售影响。
- **物流**：承运商 / 运单号 / 状态；停滞超 N 天列入提醒。
- **汇总**：按状态、渠道、TOP 客户统计，含退货率、平均折扣、毛利、毛利率。
- **前端**：`upstream/orders-drawer.js` 左下角订单胶囊 + 右侧抽屉（订单列表/详情/支出明细）。
- **接口与工具**：`/api/orders*`、`/api/expenses/detail`；新增 9 个 MCP 工具（共 41）。
- **导出**：新增 `orders`、`expenses` 两种 kind。
- **测试**：`tools/test-orders.mjs` 9 项。

## [1.5.0] — 2026-11-16

### 新增

- **文件工具**：`list_attachments` / `ocr_file` / `convert_file` / `file_formats`，智能体可列附件、识别图片文字、转换格式并回传可点击下载链接（共 34 个工具）。
- **OCR**：`backend/ocr.mjs` 提供 auto/local/api/off 四档；本地 tesseract 优先，未装走 OpenAI 兼容视觉模型；上传图片时自动补 OCR；`npm run ocr:doctor` 自检并给安装指引。
- **格式转换**：`backend/fileops.mjs` 把附件落到导出目录后复用 Filee 兼容桥，内置 5 种格式直接转，其余走桥；返回带 token 的下载链接。
- **下载鉴权**：`/api/export/download` 支持 `?token=`，聊天里的链接点开即下载。
- **接口**：`POST /api/agent/ocr`、`POST /api/agent/convert`。
- **测试**：`tools/test-fileops.mjs` 7 项。

## [1.4.2] — 2026-11-16

### 文档

- README 新增「项目概览」：项目背景、技术栈、负责工作、主要成果；智能体与工具层展开描述，前端 / 桌面 / 后端压缩为简要条目。

## [1.4.1] — 2026-11-13

### 新增

- **附件留档**：`data/attachments/<账套>/<YYYY-MM>/<时间_名称_短哈希>.<ext>`，随 data 目录备份；旧目录 `.local/attachments` 只读兼容。
- **内容去重**：sha256 判重，重复上传复用同一文件并累加 `ref_count`，不再产生多份。
- **元数据**：`agent_attachments` 补 `sha256 / orig_name / rel_path / source / ref_count`。
- **查询与清理**：`GET /api/agent/attachments`、`POST /api/agent/attachments/prune`、`npm run attachments:prune`（默认预演，`--apply` 才删）。
- **测试**：`tools/test-attachments.mjs` 6 项。

## [1.4.0] — 2026-11-13

### 新增

- **前端对话具备工具能力**：`/api/agent/chat` 走 function calling，模型可直接查账、出报表、建固定支出；界面显示工具执行状态。
- **写操作两阶段确认**：写工具不直接执行，先入 `pending_actions` 并回显摘要，用户回「确认」才落库，回「取消」放弃；凭证只出草稿。
- **生命周期标注**：`entity_tags` 支持离职、调岗、钱货两讫、已结清、作废；离职起停止生成工资，历史保留并标注；撤销留痕不物理删除。
- **左侧固定支出状态栏**：`upstream/fixed-cost-panel.js` + `index.html` 注入，胶囊/展开两种形态，按人员与类别列示，带草稿/审核/记账状态。

### 说明

- 面板为独立静态脚本，不改动前端编译产物；登录态复用 `jl_token` / `jl_set_id`。

## [1.3.0] — 2026-11-13

### 新增

- **固定支出（周期性凭证）**：模板化工资、房租、社保、水电、物业等长期分录；每月首次触发按模板生成草稿凭证，一个模板一个月只生成一张（幂等）。
- **三种调整方式**：本月直接改（草稿凭证随之替换）、下月提前改（`recurring_overrides`）、长期改模板；已审核/已记账的凭证拒绝直改。
- **月初提醒**：当月第一次交互返回摘要与四个选项，同一自然月只提醒一次，状态落 `app_state`。
- **接口与工具**：`/api/recurring` 全套读写；MCP 新增 5 个工具（共 28 个）。
- **测试**：`tools/test-recurring.mjs` 12 项。

## [1.2.2] — 2026-11-12

### 文档

- README 配图更新：桌面端「数据看板」「智能体工作台」换成实拍截图（`docs/images/desktop-dashboard.png`、`desktop-agent.png`）。
- 新增「手机端助理（微信 / 企微）」章节与实测截图（`docs/images/mobile-wechat.jpg`），说明纯文本通道、文件下发、对话回写与跨端补齐。

## [1.2.1] — 2026-11-12

### 新增

- **注册来源可配置**：`.env` 的 `REGISTER_MODE` 支持 `open`（默认，任何来源）/ `local`（仅本机）/ `closed`（关闭），改配置即时生效，不再写死 127.0.0.1 判断。
- 启动日志输出当前注册模式；`.env.example` 与 README 同步说明迁移用法。
- 单测补 `registerPolicy` 三种模式与默认值断言（账号体系共 11 项）。

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
