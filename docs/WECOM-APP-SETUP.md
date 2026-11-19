# 企业微信「自建应用」接入手册（B 方案）

> 一句话流程：**后台建应用拿 5 个值 → 本机起网关(8001) → 隧道给一个 https 域名 → 回后台填 URL 点保存 → 授权成员 → 发消息验收**。
>
> 代码侧已经写好了：验签、AES 解密、收文本、收文件落盘 `data/inbox`、按人留痕 `wecom_msg_log`、数据归集 `data_intake`、主动发消息回执。自测 `npm run test:wecom-bot` 10/10 通过。**你只需要做后台配置和公网通道。**

---

## 0. 前置条件

| 项 | 说明 |
|---|---|
| 管理员身份 | 需要企业创建者或超级管理员，能进「应用管理」 |
| 本机后端 | `npm run backend` 已在 8000 运行 |
| 公网通道 | 一条 **443 的 https** 地址（企微只认 80/443，不支持自定义端口） |
| Node | 22+（项目已在用） |

不需要：公网 IP、备案域名、企业认证（自建应用内部使用即可）。

---

## 1. 拿 CorpID（企业ID）

企微管理后台 → **我的企业** → **企业信息** → 最下方「企业ID」

```
ww1a2b3c4d5e6f7g8h        ← 形如这样，全企业唯一
```

## 2. 建自建应用

**应用管理 → 应用 → 自建 → 创建应用**

- 应用名称：`财务助理`（或「振颜丽舍」，员工看到的就是这个名字）
- logo：随意
- **可见范围**：勾选授权成员/部门 —— 这里的勾选就是"谁能用"，没勾的人连应用都看不到

创建完点进应用详情页，抄下 **AgentId**：

```
1000002        ← 纯数字
```

## 3. 拿 Secret

应用详情 → **Secret** → 查看 → 会推送到你的企微客户端 → 复制保存。

> ⚠️ Secret 等于应用的钥匙，能不经过任何验证就以应用身份发消息。只写进 `.env`，不要贴群、不要截图、不要进代码。

## 4. 配「接收消息」（先别点保存）

应用详情 → **接收消息** → **设置API接收**

| 字段 | 填什么 |
|---|---|
| URL | `https://<你的隧道域名>/api/wecom/callback` |
| Token | 点「随机获取」 |
| EncodingAESKey | 点「随机获取」（43 位） |

**先不要保存。** 点保存时企微会立刻回连这个 URL 做一次 GET 校验，URL 不通就直接报「回调地址校验失败」。

正确顺序是：**第 6 步起网关 → 第 7 步起隧道拿到域名 → 回来填 URL → 再保存**。

Token 和 AESKey 都复制到 `.env`，一个字符都不能少。

## 5. 加「企业可信IP」（最容易漏的一步）

应用详情页底部 → **开发者接口 → 企业可信IP**（新版本在「应用详情 → 企业可信IP」）

填本机出口公网 IP：

```bash
curl -s https://ifconfig.me      # 或在浏览器打开 ip.sb
```

不填的后果：**消息能收到，但回复发不出去**，日志报 `60020 not allow to access from your ip`，看起来像"机器人不回话"，实际是发消息接口被拦。

家庭宽带 IP 会变，变了要回来改。要长期稳定，用固定 IP 的服务器或运营商固定 IP。

## 6. 本机起回调网关

```bash
npm run wecom:gateway          # 监听 127.0.0.1:8001
npm run wecom:gateway:check    # 自检：后端是否可达 + 五项键位是否已填
```

这个网关只做一件事：把 `/api/wecom/callback` 转发到后端 8000，**其他路径一律 404**。

> 为什么不直接把 8000 穿透出去？因为 8000 上有登录、凭证、报表、导出全部接口，穿透 8000 等于把整个财务系统放到公网。网关把暴露面压到只剩一个回调路径。

自检验证过的行为：

```
GET  /__gateway/health          → 200 {"ok":true}
GET  /api/vouchers              → 404      ← 业务接口不暴露
GET  /api/wecom/callback?...    → 转发后端（未配置时返回 503 并列出缺失键）
```

## 7. 建公网隧道（三选一）

### A. cloudflared 临时隧道（0 成本，最快，域名每天变）

```bash
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://127.0.0.1:8001
```

输出里找到：

```
https://random-words-1234.trycloudflare.com
```

则回调 URL = `https://random-words-1234.trycloudflare.com/api/wecom/callback`

缺点：**进程一重启域名就变**，变了要回企微后台改 URL。适合先跑通验证。

### B. cloudflared 命名隧道（域名固定，推荐长期）

前提：有一个域名，NS 托管在 Cloudflare。

```bash
cloudflared tunnel login
cloudflared tunnel create zd-wecom
cloudflared tunnel route dns zd-wecom wecom.你的域名.com
cloudflared tunnel run --url http://127.0.0.1:8001 zd-wecom
```

回调 URL = `https://wecom.你的域名.com/api/wecom/callback`，一次配好不用再改。

### C. 有公网服务器

服务器 Nginx 443 反代 → frp / `ssh -R` 回本机 8001 → 回调 URL 用服务器域名。

> 国内访问 `trycloudflare.com` 有时不稳，验收时如果回调校验反复超时，优先换 B 或 C。

## 8. 填 `.env` 并重启后端

`.env` 末尾这六行（前五行已经在文件里留好了空位）：

```ini
WECOM_CORP_ID=ww1a2b3c4d5e6f7g8h
WECOM_AGENT_ID=1000002
WECOM_SECRET=第3步复制的那串
WECOM_TOKEN=第4步随机获取的那串
WECOM_AES_KEY=第4步的43位
WECOM_AUTO_SYNC=1
```

```bash
npm run backend                # 必须重启，环境变量只在启动时读
npm run wecom:gateway:check    # 五项显示"已填"才算对
```

`.env` 已在 `.gitignore` 里，不会被提交。

## 9. 回企微后台点「保存」

成功会提示 **保存成功**。失败对照表：

| 提示 | 真实原因 | 处理 |
|---|---|---|
| 回调地址校验失败 / 请求超时 | 隧道没通；URL 写了 8000；路径不是 `/api/wecom/callback` | 浏览器直接打开该 URL，应返回 503「企微应用未配置」而不是连不上 |
| 解密失败 / invalid signature | Token 或 AESKey 与 `.env` 不一致（复制漏字符、混入空格） | 重新复制；确认 AESKey 是 43 位 |
| 返回 503 且列出缺少键 | 后端没重启，或键名拼错 | 重启后端；核对键名与本文一致 |
| 返回 404 | 隧道指向了别的端口，或没走网关 | 隧道必须是 `--url http://127.0.0.1:8001` |

## 10. 授权成员（未绑定一律拒绝）

第一次有人发消息，系统会**拦下并留痕**，不回复内容 —— 宁可沉默，也不能让未授权的人查到经营数据。

```bash
npm run wecom:pending                                        # 看谁发过消息被拦
npm run wecom:bind -- --bind zhangsan --name 张三 --role 汇报者      # 授权
npm run wecom:bind -- --bind lisi --name 李四 --no-upload           # 只许查询，不许传文件
npm run wecom:bind -- --bind zhangsan --name 张三 --role 管理员 --set 85
npm run wecom:bind                                           # 看状态：配置/已绑定/最近留痕
npm run wecom:bind -- --disable zhangsan                     # 停用（离职/换岗，历史留痕保留）
npm run wecom:bind -- --enable zhangsan                      # 恢复
```

`<userid>` 是企微通讯录里成员的「账号」，不是手机号、不是姓名。成员详情页能看到。

## 11. 验收清单

1. 企微里打开「财务助理」→ 发「你好」→ 收到使用指引（说明收发都通）
2. 发一个渠道日报 xlsx → `data/inbox/` 有落盘、`npm run wecom:bind` 的「最近留痕」有记录
3. 发一句查询（如「这个月天猫净销售多少」）→ 走意图分流，返回数据而不是代码
4. 前端 销售 → 录入/归集：能看到 sender、文件名、类别、日期
5. 未授权账号发消息 → 被拒且留痕，`npm run wecom:pending` 能看到他

## 12. 和现在 A 方案的关系

| | A：AIBot 长连接（已启用） | B：自建应用 + 回调（本文） |
|---|---|---|
| 需要公网 | 不需要 | 需要 443 https |
| 能否拿到 userid | 不能，靠署名/文件名猜人 | 能，回调自带 `FromUserName` |
| 多人并发 | 一个 bot 一个会话，串行 | 每人独立，可并行 |
| 留痕严格度 | 中 | 高（按人可按日期归档） |
| 上线成本 | 已通 | 一次配置，之后零维护 |

两者共用同一套 `wecom_users` 权限表和 `data_intake` 归集表，**可以并存**。建议：先用 B 灰度几个管理员（财务、店长），稳一周再把一线汇报者切过来；A 保留作过渡。

## 13. 安全红线

- Secret / Token / AESKey 只进 `.env`；不进代码、不进 README、不发群、不截图
- 只暴露 8001 的 `/api/wecom/callback`，**永远不要穿透 8000**
- 回调自身有验签 + AES 解密，伪造请求在签名处就被拒（403）
- 网关日志会打印来源 IP 与状态码，异常来源一眼能看出
- 人员调整当天就 `--disable`，不要靠"他自己不会用"
- 临时隧道域名被扫描器撞到，除了 404 什么也拿不到

---

## 命令速查

```bash
npm run backend                # 启动后端（读 .env）
npm run wecom:gateway          # 起回调网关 8001
npm run wecom:gateway:check    # 网关 + 配置自检
npm run test:wecom-bot         # 加解密/鉴权/绑定 10 项自测
npm run wecom:bind             # 成员与状态
npm run wecom:pending          # 待授权名单
cloudflared tunnel --url http://127.0.0.1:8001   # 临时隧道
```
