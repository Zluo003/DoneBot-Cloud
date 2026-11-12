# 真实接口与修改边界

核对日期：2026-11-11 至 2026-11-12。主要依据本地源码；另使用用户明确提供的测试账号完成线上登录及只读接口核对，没有变更余额或实例。

| 项目 | 源码基线 | 本次修改 |
| --- | --- | --- |
| DoneBot | 当前基线 `b61d71ac5004c55c4ca8765a222f40344b95ae6b`；先前 Linux 镜像基线 `b16912e0481e8cbab749d75ef0ccccb32247d7b8` | 自有 Cloud 前端/会话页、统一网关安装凭据接入与隔离验证启动器；另按本会话明确授权增加仅 Cloud 模式的桌面适配，未修改模型语义 |
| donebot-api | `c5624de3b3b51cbe1246045d3a4851584c43ca3d` | Cloud 计费、主控、节点接口、后台、迁移 |
| DoneBot Cloud | 原文档工程 | worker、agent、Docker 驱动及隔离工具 |

已读取三个项目根 AGENTS.md 和 DoneBot 验证规则。没有发现 `.codegraph/`，未建立索引。网关修改依据用户明确要求的统一账户/月付余额/唯一后台/多节点主控；DoneBot 桌面适配另取得了用户明确授权，范围见 [桌面说明](desktop-adapter-proposal.md)。

## 网关身份与余额

| 接口/实现 | 实际行为与 Cloud 处理 |
| --- | --- |
| `POST /api/v1/auth/login` | 密码登录，可要求验证码、2FA；复用账户，不另建密码库 |
| `POST /api/v1/auth/login/2fa` | 完成二次认证，开发 BFF 保留该分支 |
| `GET /api/v1/auth/me` | `{code:0,data:{id,status,...}}`；JWT 中间件加载活动用户和凭据版本，主控使用其中认证主体 |
| `POST /api/v1/auth/refresh` | 刷新令牌轮换；原型 BFF 统一自身 UA/IP，避免网关会话绑定不一致 |
| logout / revoke-all | 撤销刷新会话不一定立即撤销未过期 access JWT；不声称 Cloud 改变此语义 |
| installation claim/rotate/revoke | 模型调用安装凭据，不能当作 Cloud 登录或节点权限 |
| 既有 `DeductBalance` | 部分既有业务允许负余额；Cloud 新路径使用事务内条件 SQL 扣款和账单，拒绝余额不足 |

Cloud 价格使用现有账户余额单位，最多六位小数，客户端不能指定价格。月周期按 UTC 自然月推进，月末夹到下一月有效日期；延迟续费从实际扣款成功时开始新一月。续费按后台当前价格，已付周期不追溯改价。保留期内余额恢复会尝试续费；取消订阅后不自动续费。

线上只读核对：`POST /auth/login`、`GET /auth/me` 为 200 / code 0；`GET /donebot/account` 为 404，`GET /donebot/cloud/instances` 为 404。因此当前线上服务尚不能验证本地主控的完整接口，具体部署版本和启用配置需在正式部署时核对。退出本次刷新会话的请求返回 502，未据此声称令牌已撤销；进程已结束，令牌仅在进程内存使用。账号、密码、响应令牌和账户余额均未写入记录。之后容器出网测试只发送无凭据的 `/auth/me`，返回 401。

流式访问每 3 秒复查 JWT 有效期、凭据版本、账号状态、归属和订阅。Cloud 浏览器另有可撤销的数据库会话，主站前端退出时会先尝试撤销；离线失败时不能保证立即撤销。这没有改变原有 logout 对未过期 JWT 的语义。合成身份服务的即时撤销测试不表示线上 logout 行为已改变。

## DoneBot 运行与原生鉴权

- 使用现有 Dockerfile 的 `server` target。UID 1001，`HOME=/data`，状态在 `/data/.donebot`，容器回环服务端口 18899、webhook 18900。
- `DONEBOT_TUNNEL_SOCKET=/run/donebot/http.sock` 开启 IPC，IPC 按远程请求鉴权。伪造回环 Host 或转发头不能代替会话。
- 匿名 `GET /api/health` 仅返回 `{app:"donebot"}`，用于就绪探测。业务接口和原生会话探测仍需鉴权。
- 受信 agent 执行固定 `docker exec node -e`，从容器内本地所有者入口调用 `/api/auth/pairing`，再通过 `/api/auth/pair` 获取 `omb_sess_…` 原生会话。
- `/api/auth/session` 校验原生 bearer。token 在 agent 私有元数据中加密保存，代理时注入，临近到期重新建立。
- 没有设置原版托管环境变量、关闭原生鉴权或恢复被删除的企业适配器。

客户端复用现有 `donebot://pair`、环境探测、配对页和 Cookie 协议；Cloud 主控兑换自身一次性码，不转发给原版配对接口，也不交付原生 bearer。没有修改 Electron 原版连接代码。独立 Linux 桌面现通过已获明确授权的受限 Cloud 适配接入原版 VM 生命周期和工具接口。不向用户容器开放 Docker socket，不恢复促销、Boat、原版购买、移动下载或订阅入口，也不接管本机其他应用数据。

Cloud 自动安装凭据：迁移 263 绑定实例、用户、installation UUID 与已分配节点，主控 AES-GCM 保存 key；仅被分配节点可领取。agent 加密存储并原子交付 `/run/donebot/gateway.json`，DoneBot 只读加载为 installation 模式。用户 JWT、密码和管理员 key 不进入容器。`/v1/donebot/runtime/models|account|receipts/...|templates/...` 复用安装 key 的当前用户/分组校验，不赋予 Cloud 管理权。缓存 key 每次领取前确认仍为当前有效 key；人工撤销或轮换不会被静默覆盖，可能使实例恢复失败，需管理员核对后处理。彻底回收撤销其安装凭据。

## 接入限制

当前 API 链路是网关 JWT → 主控归属检查 → 短期签名 → 节点 → 本机 agent → 原生会话。浏览器通过独立实例域名和一次性兑换的 HttpOnly Cookie 接入同一链路，原生 WebSocket 无需设置 Authorization；HTTP/WS/SSE 与真实 DoneBot 网页的隔离 fixture 已验证，见 [浏览器接入](browser-access.md)。用户控制台、部署配置及生产端到端验收分别记录，不能混称线上已提供 Cloud。

模型能力、默认值、原生请求和媒体语义继续属于 DoneBot。Cloud 不替用户选模型、不规划媒体任务、不注入网关管理员模型凭据。
