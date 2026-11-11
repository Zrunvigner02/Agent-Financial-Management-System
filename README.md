# Agent Financial Management System（妆点管账 · 本地智能财务系统）

**版本 1.0.0** · 一套可离线运行的本地财务账套 + AI 智能体 + 文件格式转换 + MCP 对接方案。

后端零外部 npm 依赖，基于 Node.js 内置模块与 `node:sqlite`；前端为已构建的静态资源；桌面端为 Electron 外壳。所有业务数据保存在本地 SQLite，不上传云端。

---

## 1. 快速开始

环境：Node.js 22+（需支持 `node --env-file` 与 `node:sqlite`）；Python 3.8+（可选，安装 Pillow 后可渲染 PDF / 图片类格式）。

```bash
# 1) 复制配置模板并填写密钥（模板中所有值均为空，不会泄露任何凭据）
cp .env.example .env          # Windows: copy .env.example .env

# 2) 至少填写以下几项
#    DEEPSEEK_API_KEY=<你的 DeepSeek Key>
#    WB_MCP_TOKEN=<软件「设置 → 开放接口」生成的令牌>
#    FILEE_CLI=tools/filee-bridge.mjs
#    LOCAL_API_ORIGIN=http://127.0.0.1:8000

# 3) 一键启动（后端 :8000 + 前端 :5173）
npm run dev
# 浏览器打开 http://127.0.0.1:5173
```

桌面端（可选）：在 `desktop/` 下执行 `npm install` 安装 Electron，然后运行 `pythonw desktop/launcher.pyw`；`npm run desktop` 等价。桌面端调试端口 9333 默认关闭。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm start` | 只启动前端静态服务与反向代理（:5173） |
| `npm run backend` | 只启动本地后端（:8000，含 `/mcp`） |
| `npm run check` | 20 个脚本的语法检查 |
| `npm run regression` | 独立临时目录 + 独立数据库的全量回归（117 项） |
| `npm run smoke` | 隔离冒烟 + 看板核验 |
| `npm run test:title` | 会话自动命名单测（24 项） |
| `npm run audit:clean` | 数据审计三轮（17 项）+ 稳定快照哈希 |
| `npm run desktop:check` | Electron 主进程语法检查 |

> 所有测试都在临时副本中运行，不会写入 `backend/data/jinli.db`。

---

## 2. 1.0 功能清单

### 账务核心
- 多账套隔离（`X-Set-Id` / `ZD_DB_PATH`）、科目表、凭证录入与校验（借贷平衡、金额精度、科目有效、单行不可同时借贷）、期初/期末、看板指标。
- 报表生成与导出：凭证、余额、明细等，内置 **CSV / XLSX / JSON / MD / HTML** 五种互转；下载链接由后端生成。
- 金额单位统一为「元」，看板以「万元」展示（`Number((x / 1e4).toFixed(2))`）。

### AI 智能体
- DeepSeek 模型接入（`backend/llm.mjs`），系统提示词注入账套名 / ID / 凭证数与真实能力清单。
- **grill-me 式逐步反问**（`backend/clarify.mjs` + `upstream/clarify.js`）：输出形式 → 报表类型 → 文件格式 → 期间 → 详略 → 确认；编号选项卡片可点击回填，末项固定「✎ 其他补充…（我自己输入）」。
- 意图识别决定是否反问；「不用反问了」停用后可恢复；SSE `event: clarify` + REST 状态兜底。
- **全格式附件录入**（`backend/attachment.mjs`）：文本 / CSV / TSV / JSON / MD / HTML / XLSX / DOCX / PPTX / ODT / ODS / PDF / RTF / 图片等 51 种扩展名，零依赖解析出文本与 `columns/rows`，原件留档。
- **会话自动命名**（`backend/session-title.mjs`）：首条有效消息即时生成短标题，可选 LLM 精修；历史「新对话」按首条消息回填；`title_source='manual'` 后人工命名永不被覆盖；前端通过 `__zdApplySessionTitle` 同步侧栏与顶栏。

### Filee 格式转换（重点）
本项目完整包含运用 **Filee** 的转换能力，采用「Filee CLI 协议兼容」的本地零依赖实现，无需 .NET / LibreOffice，也可切换为官方 `filee-cli.exe`。支持把报表转成 **PDF / DOCX / ODS / ODT / RTF / TXT / TSV / XML / SVG / PNG / JPG / WEBP** 等格式。

涉及的源码、页面、桥接脚本与配置说明全部随 1.0 打包，详见 **[docs/FILEE_INTEGRATION.md](docs/FILEE_INTEGRATION.md)**。

### MCP / WorkBuddy 对接
- `POST /mcp`：JSON-RPC 2.0、streamableHttp，支持 `tools/list`、`tools/call`、通知免鉴权返回 202；工具覆盖账务查询、报表、意图分析、附件读取、数据审计等。
- `tools/mcp-stdio-bridge.mjs`：stdio 兜底桥，适配只支持 stdio 的客户端（`ZD_MCP_URL`、`ZD_TOKEN`）。
- WorkBuddy 侧在 `~/.workbuddy/mcp.json` 配置 `streamableHttp` 指向 `http://127.0.0.1:8000/mcp`，headers 携带 `Bearer <开放令牌>`；令牌只存本地 `.env`，不入库。

### 数据严谨性
- `backend/data-audit.mjs`：17 项独立检查（借贷平衡、孤儿分录、凭证号唯一、期间一致、科目有效、金额精度、两套 SQL 独立重算看板、单位契约静态检查、稳定快照哈希），支持多轮与 snapshot/compare。
- `tools/isolated-run.mjs`、`tools/cleanup-test-data.mjs`、`tools/test-data-integrity.mjs`：测试隔离、测试数据清理（dry-run / apply / restore + 自动备份）、完整性专项。

### 桌面端
- `desktop/main.js` + `preload.js` + `launcher.pyw` + `make_icon.py` / `make_shortcut.py` / `splash.html`，本地反向代理直连 :8000，无需公网。

---

## 3. 目录结构

| 路径 | 内容 |
| --- | --- |
| `backend/` | 本地后端：路由、账务、LLM、智能体、追问、附件、报表导出、Filee 集成、数据审计、会话命名、种子数据 |
| `upstream/` | 前端静态站：入口页、格式转换页、导出页、120 个已构建资源、注入层 `clarify.js` |
| `desktop/` | Electron 桌面端源码与图标（不含 `node_modules/` 与 `runtime/node.exe`） |
| `tools/` | 测试、审计、清理、CDP 验证、MCP stdio 桥、**Filee 转换桥** |
| `server.mjs` | 静态服务 + `/api` 反向代理（支持 `.env` 热读取） |
| `logs/` | 开发与验证日志（密钥已脱敏） |
| `analysis/` | 接口探测、回归与审计结果快照（43 MB 的逆向 gzip 产物不入库） |
| `docs/` | Filee 集成说明、验证报告 |
| `release/` | 1.0.0 源码打包归档（zip） |
| `.env.example` | 完整配置模板（所有密钥留空） |

---

## 4. 安全边界（重要）

以下文件**刻意不进入版本库**，避免密钥、本机运行数据与超大二进制泄露：

- `.env`（含 `DEEPSEEK_API_KEY`、`WB_MCP_TOKEN`）、`.local/`（登录态、开放令牌、Chrome 测试 profile）
- `backend/data/*.db*`（真实账套与令牌哈希，含所有 `.bak` 备份）
- `node_modules/`、`desktop/runtime/node.exe`（87 MB）、`*.exe/dll/pak/dat`、`__pycache__/`
- `analysis/rea-js-app.json.gz`（43 MB 逆向产物）

仓库内保留 `.env.example`、`backend/seed/`（演示种子数据，仅含令牌前缀不含完整令牌）、脱敏后的日志与报告。任何提交前请确认 `git status` 无 `.env` 或 `.db` 文件。

---

## 5. 1.0.0 验证结果

| 项目 | 结果 |
| --- | --- |
| 语法检查 | 20 个文件全通过 |
| 全量回归 | 117 / 117 |
| 隔离冒烟 + 看板 | 17 / 17 + 11 / 11 |
| 会话命名单测 | 24 / 24 |
| 数据完整性专项 | 19 / 19 |
| 数据审计（三轮） | 17 / 17，快照哈希一致 |
| 真实 Chrome UI 验证 | 38 / 38，零 JS 异常、零 4xx/5xx |
| 生产库 | 凭证 / 分录 / 会话 / 消息均为 0，改动前后快照哈希一致 |

详见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

### 已知限制
- 图片附件仅解析元信息与文字片段，未内置 OCR 引擎。
- 老式二进制 `.xls` 仅能提取文字片段；CID 字体 PDF 可能出现乱码。
- 图片 / PDF 渲染需要 Python Pillow（未安装时相应格式会明确报错，不影响其余功能）。
- 桌面端 9333 CDP 调试端口默认关闭。
- 历史 `.local/test-*.mjs` 为一次性验证脚本，断言可能过期，请以 `npm run regression` 为准。

---

## 6. 版本

当前发布：**v1.0.0**。变更记录见 [CHANGELOG.md](CHANGELOG.md)。
