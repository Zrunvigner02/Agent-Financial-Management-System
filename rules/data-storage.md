# 数据安全与分类存放规则

> 目标：**谁的数、哪一类、什么口径**一眼可辨；同一份数据**重复上传不会重复入账**；敏感信息不外泄。
> 违反本文件视为数据事故。

## 一、四类数据，四个去处（不得混放）

| 类别 | 内容 | 落地位置 | 关键字段 |
| --- | --- | --- | --- |
| **财务口径** | 收入/成本/毛利/边界利润/净利、平台扣费、推广费、物流费、人力 | `fin_pnl_lines`、`fin_pnl_sku` | `period`(月/季/日)、`brand`、`channel`、`item`、`basis` |
| **销售口径** | 渠道×日 销售额/退款/件数、平台费 | `sales_daily` | `set_id`、`date`、`group_name`、`source`、`staff` |
| **归集台账** | 收到的文件：谁传、何时、哪类、哈希、状态 | `data_intake` | `sha256`、`sender_id`、`category`、`doc_date` |
| **会话留痕** | 与谁对话、载入了谁的报表 | `agent_sessions` / `agent_messages` | `session_id`、`sender`、`created_at` |

**铁律：财务口径与销售口径互不换算、互不覆盖。** 财务收入取旺店通发货数据与平台账单；销售端 GMV 只做销售统计。

## 二、敏感信息隔离

| 内容 | 存放 | 规则 |
| --- | --- | --- |
| 令牌 / Secret / AESKey | `.env`、`.local/gh_token.txt` | 已在 `.gitignore`；**禁止**打印到日志、聊天、截图 |
| 账套数据库 | `backend/data/jinli.db` | 不入版本库；测试一律用副本（`ZD_DB_PATH` 指向临时文件） |
| 原始上传文件 | `backend/data/inbox/`、`upstream/chat-media/` | 只读留存，命名保留原名 + 哈希前缀 |
| 用户备份 | `C:/Users/zylspc/WorkBuddy/Claw/备份/YYYY-MM-DD/` | 收到即备份，登记 `备份/索引.md` |

## 三、不重复录入（幂等键）

| 表 | 唯一键 | 重复上传的表现 |
| --- | --- | --- |
| `sales_daily` | `set_id + date + sku + product + amount + return_amount`（跨来源判重） | 跳过，条数不增 |
| `fin_pnl_lines` | `set_id + period + brand + channel + item + basis` | 只更新金额，不新增行 |
| `fin_pnl_sku` | `set_id + period + channel + sku` | 同上 |
| `data_intake` | `set_id + sha256 + source` | 已存在则更新状态，不新增 |

新增数据源时必须先定义幂等键，否则不允许上线。

## 四、每日/每次操作后的自检

```bash
npm run check              # 语法
npm run test:finance-logic # 损益链 + 幂等 + 口径隔离（15 项）
npm run verify:templates   # 两个固定版式（17 项）
npm run regression         # 全量回归（隔离库）
```

## 五、禁止事项

- ❌ 把销售端 GMV 直接当财务收入
- ❌ 用 AVERAGE 代替"合计金额重算"来算毛利率/净利率
- ❌ 空数据填 0 冒充有值（应留空并在口径说明标注）
- ❌ 在测试中直接写真实库（必须 `ZD_DB_PATH` 指向副本）
