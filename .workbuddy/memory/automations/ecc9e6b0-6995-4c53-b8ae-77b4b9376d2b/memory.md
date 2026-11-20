# 德国世家天猫海外旗舰店 每日经营日报 — 执行记录

## 固定流程
1. `node tools/wdt-watch.mjs --once` 入库（幂等）
2. `node tools/make-channel-daily.mjs --brand 德国世家 --channel 天猫 --from <7天前> --to <今天> --source wdt --out "D:\振颜丽舍\报表\日报\<今天>\德国世家-天猫海外旗舰店-日报-<7天前>_<今天>.xlsx"`
3. 只读查 `backend/data/jinli.db`（set_id=85）核对合计/成本率/最新日期
4. present_files 交付 + 3~5 行汇报

## 关键口径
- `sales_effective` 视图中 set_id=85、group_name∈(天猫,天猫海外旗舰店)、brand='德国世家'
- 该导出无退款列、无件数列 → 退款恒 0、支付件数留空，需说明「退款需另导退货单」
- 成本率 = cost/amount，取自 `sales_daily.cost`；超过 100% 需提示核对成本价

## 执行历史
- 2026-11-20 09:15｜入库无待处理文件；生成 2026-11-13~11-20 日报 7 行 29 列；合计 33,626.68 元，退款 0，成本率 52.22%；库内最新 11-19（等于昨天，属正常，当日数据待 23:00 导出后补齐）。无异常。
