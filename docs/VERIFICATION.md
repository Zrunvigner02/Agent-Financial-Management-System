# v1.0.0 验证报告

所有测试在临时副本 + 独立数据库中执行，生产库 `backend/data/jinli.db` 在改动前后快照哈希一致。

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 语法检查（20 个脚本） | `npm run check` | 全通过 |
| 全量功能回归 | `npm run regression` | 117 / 117 |
| 隔离冒烟 | `npm run smoke`（local-smoke） | 17 / 17 |
| 看板核验 | `npm run smoke`（verify-dashboard） | 11 / 11 |
| 会话自动命名单测 | `npm run test:title` | 24 / 24 |
| 数据完整性专项 | `node tools/test-data-integrity.mjs` | 19 / 19 |
| 数据审计（三轮） | `npm run audit:clean` | 17 / 17，哈希一致 |
| 全页面 UI（CDP） | 真实 Chrome | 38 / 38，零 JS 异常、零 4xx/5xx |
| 会话命名真实页面 | 隔离 Chrome 页面 | 7 / 7（新建 → 发消息 → 侧栏/顶栏更新 → 刷新保持） |

## 数据核验口径

- 17 项审计覆盖借贷平衡、孤儿分录、凭证号唯一、期间一致性、科目有效性、金额精度、两套独立 SQL 重算看板、单位契约静态检查、稳定快照哈希。
- 每次变动前后比对生产库快照；测试用例写入隔离副本，不落生产库。
- 测试数据清理支持 dry-run / apply / restore，自动备份并做前后核验。

## 1.0 发布前复核清单

- [x] `.env`、`.local/`、所有 `.db` / `.bak` 已被 `.gitignore` 排除
- [x] 代码与日志中无完整 API Key / 开放令牌（日志中的 `sk-…` 为脱敏片段）
- [x] Filee 全链路文件齐备（`filee-bridge.mjs`、`render_image.py`、`export.mjs`、两个页面、配置模板、回归断言）
- [x] `node_modules/`、`desktop/runtime/node.exe`、43 MB 逆向 gzip 未纳入
- [x] 打包归档与仓库文件清单一致，且归档内不含密钥

## 已知限制

图片附件无 OCR 引擎；二进制 `.xls` 仅文字片段；CID 字体 PDF 可能乱码；图片/PDF 渲染需 Python Pillow；桌面端 9333 CDP 默认关闭；`.local/test-*.mjs` 为一次性历史脚本，断言可能过期。
