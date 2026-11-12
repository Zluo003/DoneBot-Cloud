# 浏览器入口与会话

主控和唯一管理后台仍在 donebot-api。用户复用网关登录，在 `/cloud` 查看月费、余额、保留天数，开通/启停/取消续费，或者打开自己的实例。DoneBot 前端的自有 Cloud 卡片指向 `https://donebot.cn/cloud`；原版购买、促销、Boat、移动下载和订阅入口仍关闭。

## 域名与部署

主控启用迁移 262，并注入：

```dotenv
DONEBOT_CLOUD_MASTER_ORIGIN=https://donebot.cn
DONEBOT_CLOUD_BROWSER_ORIGIN=https://cloud.donebot.cn
```

需要 `*.cloud.donebot.cn` 的通配 DNS 和 TLS，所有实例域名均到达主控。每实例地址为 `https://<instance UUID>.cloud.donebot.cn/`，原生网页的 `/assets`、`/api`、SSE 和 WebSocket 路径不改写。前置代理必须保留 Host 和 Origin，准确处理可信客户端 IP/UA，并允许 WebSocket、流式响应与足够长的读取超时；这些响应不得缓存。worker 仅从主控私网接收签名访问，agent 仍只监听本机 Unix socket。

browser namespace 在主站 CORS、静态资源和 API 路由之前拦截，错误实例、大小写、尾点、嵌套域名和错误端口不会回落到网关页面。master origin 必须位于 namespace 之外。生产只接受 HTTPS；`cloud.localhost` 的 HTTP 例外需显式测试开关，仅供一次性 fixture。

不同实例 origin 隔离 localStorage、Cookie 和网页访问。响应设置单值 Origin-Agent-Cluster、COOP/CORP、禁止 framing、no-referrer 和 no-store。Cookie 无 Domain，因此主站或另一实例的 Cookie 不授予本实例访问权限；任何用户容器都不能接收网关主站 Cookie。

## 打开与撤销

1. 已登录用户请求 `POST /api/v1/donebot/cloud/instances/:id/browser-launch`，正文 `{}`。身份来自网关认证主体，主控检查归属、运行状态、已付订阅、节点在线与 JWT 有效期。
2. 返回有效 60 秒的一次性开门码 URL。码只放在 fragment，实例启动页立即从地址栏清除，再以同 Origin 的 JSON POST 兑换。数据库原子更新保证并发只能兑换一次，码还绑定实例、origin、客户端 IP 和 UA。
3. 兑换得到随机 `__Host-dbc_session` Cookie：Secure、HttpOnly、SameSite=Strict、Path=/、无 Domain。有效期最多一小时，或原 JWT 更早到期的时间。浏览器不获得原生 DoneBot bearer，也不把网关 JWT 放到实例页面的 JS 或存储中。
4. 数据库仅存开门码/Cookie 的 SHA-256 摘要；为持续核验身份保存的 JWT 使用 AES-GCM 加密，密钥从主控 signing seed 按用途派生，实例 ID 作为附加认证数据。轮换 seed 会使已有网页会话失效。
5. 每次请求重新核验 Cookie、binding、网关账号/凭据版本、归属和订阅。HTTP/SSE/WS 长连接每 3 秒复查；撤销、账号失效、到期或停机后拒绝新访问并关闭已有连接。WS 和写请求要求精确同 Origin，跨站及同站跨 origin 子请求被拒绝。

用户可在控制台断开全部 Cloud 网页会话；实例内同 Origin 的 `POST /__cloud/logout` 只撤销当前 Cookie。网关前端退出时，在清除本地令牌前尝试撤销 Cloud 会话；网关离线导致撤销失败时，本地仍退出，旧 Cookie 可能存续至自身到期或其他撤销条件生效。原网关退出对 access JWT 的既有限制没有改变。不能把合成身份即时撤销测试描述成线上 JWT 全局撤销已实现。

网页会话不自动续期网关 JWT，结束后回控制台重新打开。已加载的 DoneBot 前端显示自有 Cloud 会话结束页；无有效会话的顶层导航跳回主控 `/cloud`，API 返回 401/403。原生配对和其他鉴权管理路径由 Cloud 屏蔽，不能通过网页自行取得持久原生 bearer。

## 验证范围

见 [验证记录](verification.md) 和 [机器可读证据](verification/browser-2026-11-12.json)。真实 PostgreSQL + 双 worker 覆盖一次兑换、Secure Cookie 属性、加密存储、过期、binding、跨用户/Origin 和 WS 撤销/到期断连；真实 DoneBot fake-engine 进程覆盖网页、静态资源、原生会话/SSE和私有记忆。Chrome 实测两个用户页面、发送甲消息、乙不显示甲内容及撤销后会话结束页。

Chrome 使用合成控制页打开实例；网关用户控制台通过组件、类型及路由测试，生产登录/扣费页面尚未完成端到端浏览器验收。后续已在 Linux 重建含当前前端及网关安装凭据接入的新镜像，验证原生浏览器画面、HTTPS、独立资料及重启持久化；自动模型凭据和模型请求使用合成网关验证，没有真实模型/余额调用。两者证据见 [运行记录](verification/runtime-2026-11-12.json)，不能扩大先前 Chrome 记录的范围。

## DoneBot 原生客户端

用户控制台“在 DoneBot 客户端打开”请求 `POST /api/v1/donebot/cloud/instances/:id/desktop-launch`。返回的 `donebot://pair` 链接复用客户端现有连接协议，包含该实例地址和 60 秒一次性码。客户端探测 `/.well-known/donebot/environment` 后打开 `/pair`，fragment 码经同 Origin `/api/auth/pair` 兑换 HttpOnly Cookie，再加载实例。主控截获这些路径，原版服务不接收 Cloud 配对码。环境探测仅给固定 label、实例 UUID 和协议版本，不提供用户数据或实例是否存在的查询。

原生兑换与网页兑换使用不同 binding，不能互换。原生开门码绑定客户端 IP，允许浏览器到 Electron 的 UA 改变；兑换后的会话绑定实际 IP+UA，只能使用一次，同样受 JWT/订阅/撤销约束。网络出口改变、主控 JWT 到期或会话撤销后应重新打开。

现有客户端探测/配对 URL 构造代码已用于真实 DoneBot fixture 集成测试；打包 GUI 的操作系统协议注册、窗口切换与 Cookie 行为仍需专门验收。此入口连接的是 DoneBot 客户端，不代表已提供用户独立 Linux 桌面。
