# Filee 集成说明（v1.0.0）

本项目「运用了 Filee 的部分」指**报表与附件的多格式转换能力**。设计目标是兼容 [Zrunvigner02/Filee](https://github.com/Zrunvigner02/Filee) 的 CLI 调用协议，同时提供一份**零外部依赖的本地实现**，使 1.0 版本在没装 .NET / LibreOffice / 官方 `filee-cli.exe` 的机器上也能直接跑通 PDF、DOCX、ODS、ODT、RTF、图片等格式。

> 集成方式是**进程级 CLI 调用**（`spawn`），不是把 Filee 源码嵌入本项目；因此可以随时把 `FILEE_CLI` 换成官方可执行文件，业务代码无需改动。

---

## 1. 1.0 打包内包含的全部相关文件

| 文件 | 作用 |
| --- | --- |
| `tools/filee-bridge.mjs` | Filee CLI 协议兼容的本地转换桥：`formats` / `convert` 两个子命令，零 npm 依赖 |
| `tools/render_image.py` | 可选 Pillow 渲染器，供转换桥生成 PDF / PNG / JPG / WEBP |
| `backend/export.mjs` | `readFileeCli()`、`fileeStatus()`、`FILEE_TARGETS`、`formats()`、`convert()`；内置五种格式互转 + 外部桥 `spawn` 调度（120 秒超时、参数白名单、`shell:false`） |
| `backend/index.mjs` | `/api/export/formats`、`/api/export/files`、`/api/export/convert`、`/api/export/download` 路由 |
| `upstream/convert.html` | 文件格式转换页：动态列出内置格式与 Filee 扩展格式，显示桥状态 |
| `upstream/export.html` | 报表导出页：显示 `fileeStatus()` 与可用目标格式 |
| `upstream/index.html` | 前端入口，加载转换/导出页与注入层 |
| `.env.example` | `FILEE_CLI`、`FILEE_PYTHON` 配置模板与说明 |
| `tools/full-regression.mjs` | 断言桥脚本存在、`/api/export/formats` 返回 `filee.configured === true` |
| `logs/run-2026-11-11.log` | 集成与回归的开发记录 |

---

## 2. 调用链

```
浏览器 convert.html / export.html
        │  GET /api/export/formats  →  formats().filee / fileeTargets
        │  POST /api/export/convert { file, to }
        ▼
backend/index.mjs → backend/export.mjs
        │  to ∈ [csv,xlsx,json,md,html]  → convertBuiltin()（不经过 Filee）
        │  其他扩展格式               → fileeStatus() 校验
        ▼
spawn(process.execPath, [
  'tools/filee-bridge.mjs', 'convert', <src>,
  '--to', <ext>, '-o', <converted_dir>, '--overwrite'
], { shell:false, cwd: ROOT })
        ▼
tools/filee-bridge.mjs → 解析源表格 → 生成目标格式
        │  PDF / 图片类 → 调用 tools/render_image.py（Pillow）
        ▼
返回 { ok, engine, output, download } → 前端下载链接
```

官方 CLI 模式下 `FILEE_CLI` 指向可执行文件（绝对路径或 PATH 中的 `filee` / `filee-cli`），`spawn` 直接执行同一组参数，协议不变。

---

## 3. 独立调用

```bash
# 查看协议与格式清单
node tools/filee-bridge.mjs formats

# 单独转换一个文件
node tools/filee-bridge.mjs convert report.csv --to pdf -o ./out --overwrite
```

`formats` 返回：

```json
{
  "ok": true,
  "engine": "zd-filee-bridge",
  "from": ["csv","tsv","txt","json","md","markdown","html","htm","xlsx"],
  "to":   ["pdf","docx","ods","odt","rtf","txt","tsv","xml","svg","png","jpg","jpeg","webp"],
  "note": "本地零依赖转换桥（Filee CLI 协议兼容）；内置互转另有 csv/xlsx/json/md/html"
}
```

`convert` 成功时返回 `{ ok:true, engine:'zd-filee-bridge', output, ... }`，失败返回 `{ ok:false, message }`。

---

## 4. 配置

`.env` 中：

```ini
# 推荐：使用项目自带的零依赖桥（相对路径按项目根解析）
FILEE_CLI=tools/filee-bridge.mjs

# 或切换官方 Filee CLI（二选一）
# FILEE_CLI=D:/tools/filee/filee-cli.exe
# FILEE_CLI=filee

# 可选：指定带 Pillow 的 Python，用于 PDF / 图片渲染（不填则自动探测）
# FILEE_PYTHON=D:/tools/Python311/python.exe
```

`server.mjs` / `backend/index.mjs` 启动时会读环境变量；`backend/export.mjs` 还会在环境变量缺失时回退读取项目根 `.env`，因此桌面端与命令行启动行为一致。

---

## 5. 状态自检与故障排查

- `GET /api/export/formats` → `data.filee.configured`、`engine`（`local-bridge` / `external-cli` / `none`）、`hint`。
- `configured:false`：检查 `.env` 是否填写 `FILEE_CLI`，路径是否被 `.gitignore` 之外的因素移动。
- `exists:false`：相对路径按项目根解析，确认 `tools/filee-bridge.mjs` 存在。
- PDF / PNG 报缺 Pillow：设置 `FILEE_PYTHON` 指向已安装 Pillow 的 Python，或在其它格式可用的情况下跳过图片类目标。
- 转换超时：单次调用上限 120 秒，超时会终止子进程并返回明确错误。
- 内置五种格式（CSV / XLSX / JSON / MD / HTML）完全不依赖桥，未配置 Filee 也能使用。

---

## 6. 回归验证

`npm run regression` 中的相关断言：

1. `tools/filee-bridge.mjs` 与 `tools/render_image.py` 必须随项目一起被复制到隔离测试目录；
2. `/api/export/formats` 返回 `builtin.length >= 5` 且 `filee.configured === true`；
3. 转换后的文件出现在 `converted/` 并通过 `/api/export/download` 可下载。

1.0.0 全量回归结果：117 / 117 通过。
