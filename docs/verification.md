# 隔离验证记录

日期：2026-11-11 至 2026-11-13。功能及资源变更验证均使用临时目录、随机合成账户/令牌、隔离 DoneBot fixture 或测试私有 PostgreSQL。用户明确提供的测试账号仅用于线上登录及只读身份接口核对，没有变更实际余额、用户应用或已有实例；凭据和令牌未落盘。

## 2026-11-13：应用内 Cloud 开通

DoneBot 添加工作区/服务器、应用菜单和账号设置均使用自有应用内面板。复用现有
网关账号及 Cloud API，展示月费/余额、确认开通、启停/取消续费，实例就绪后走
既有原生配对，不跳转网页。安装凭据不可取得 Cloud 扣款权限；账号或价格变化
必须重新确认。价格仅在提交前复查，不是主控原子报价锁定。

- DoneBot 7 个相关测试文件共 66 项通过：组件确认/取消、同键重试、余额及容量
  失败、账号切换、禁用套餐、原生配对、凭据权限与状态裁剪、侧栏依赖和隔离服务
  闭环。真实本地服务连接合成主控，验证余额不足零扣款、丢失响应后同键重试仅
  一笔合成扣款、已付周期停启不重复扣款、取消续费与退出后拒绝访问。
- 前后端 TypeScript、修改文件 oxlint、临时目录 Vite 生产构建通过；构建仍有
  既有 CSS highlight、第三方注释与 chunk 大小提示。
- 真实 Chrome 独立 `dbc-native-20261113` session 用隔离 launcher 登录合成账户：
  应用内确认后余额 50 → 37.5，显示运行中；连接按钮调用既有原生配对桥接替身
  1 次，外部浏览器调用 0 次。390 × 844 无横向溢出，取消续费有明确确认。
- 客户端证据在其忽略目录 `.omb-scratch/verify-evidence/donebot-cloud/result.json`，
  内含持久服务日志路径；截图为 `output/playwright/donebot-cloud-native-confirm.png`
  及 `donebot-cloud-native-narrow.png`。完整命令见 DoneBot 的
  `docs/verification/donebot-gateway.md`。

本轮替代此前网页入口方案；未修改主控计费规则、发布客户端或部署生产。合成
worker/余额与桌面桥接替身仅证明客户端接线，不替代安装包 GUI、实际云连接和
真实 Linux 隔离验收。

## 2026-11-13：公钥与服务器删除

- 网关前端 `CloudPanel.spec.ts`、管理 API `donebot.spec.ts` 共 14 项测试通过：添加/轮换直接交付公钥、刷新失败仍保留本次凭据、隐藏令牌后仍可查看公钥、缺少签名配置的提示和操作限制、删除确认与取消、有实例禁止删除、并发分配冲突提示。
- `go test ./internal/handler/admin ./internal/server/routes ./internal/cloudbilling` 通过。HTTP 合约确认缺少或无效 seed 时创建/轮换不写库、节点列表仍可读取、添加响应带公钥和一次性 token 且不含 seed；删除及节点写路由要求既有 step-up。
- `CLOUD_BILLING_PG_FIXTURE=1 go test -tags integration ./internal/cloudbilling -run '^TestPostgresNodeDeletion' -count=1 -timeout=3m` 通过。真实临时 PostgreSQL 应用迁移 260–264：pending、stopped、deleting/error 实例均阻止删除；实际主控回收确认后可删除，令牌失效，重复删除安全，历史实例及退款流水保留，同地址重新登记使用新身份。另进行 12 轮删除/分配竞争，未出现存活实例分配到已删除节点或删除成功仍扣费的情况。
- `CLOUD_BILLING_PG_FIXTURE=1 CLOUD_BILLING_NODE_FIXTURE=1 go test -tags integration ./internal/cloudbilling -count=1 -timeout=4m` 通过，覆盖新增迁移后的既有计费、浏览器授权及双 Node worker 回归。本命令未启用真实 DoneBot 浏览器/模型 fixture，对应两项测试跳过；此前证据不因此更新。
- `vue-tsc --noEmit`、修改前端文件 ESLint、临时目录 Vite 生产构建通过。构建保留既有 Browserslist、动态导入/chunk 和 shell 弃用提示。Cloud 发布候选脚本加入迁移 264，`node --check` 与两个仓库 `git diff --check` 通过。

本轮仅验证管理功能和主控数据规则，未启动 Linux VM、未重复桌面或租户隔离验收，未连接生产网关、扣款或删除实际服务器。删除功能只撤销主控登记；服务器程序的停止和卸载需单独处理。

## 2026-11-11 至 2026-11-12：已通过

| 验证 | 结果与证明范围 |
| --- | --- |
| `npm test` | 9 项通过：两用户归属、HTTP/WS、伪造头、并发幂等、余额不足、退款、停启/撤销、会话续建、租约失效、备份确认与授权到期不重启、agent 退出停机、worker readiness。运行时为合成实现 |
| `npm run verify:donebot` | 两个真实 DoneBot 进程，fake engine 回复、原生配对/会话校验、HTTP 跨归属拒绝、聊天/文件/记忆/profile 停启持久化及 Cloud 重启恢复 |
| Go Cloud 测试（integration） | 13 项顶层测试通过，真实临时 PostgreSQL 迁移 260–263；扣退费、余额不足、月末、双节点/代次/租约、回收重试、中断恢复、续费/删除互斥、网页/原生客户端协议、独立安装凭据及节点令牌轮换撤销 |
| Go 主控 + 两个 Node worker | HTTP/WS 经主控→worker→agent→合成运行时；按容量分配两个节点、并发只扣一次、worker 重启、到期断连/停机、7 天内保留、删除失败重试、另一用户数据保留 |
| Go 相关包 | cloudbilling、handler、admin handler、server/routes、cmd/server 通过；节点路由与用户 JWT 路由鉴权分离测试通过 |
| 网关前端 | 类型检查通过；CloudPanel、DoneBotView、DoneBot API 相关 11 项测试及修改文件 ESLint 通过 |
| 网关 Cloud 前端最终回归 | vue-tsc、临时目录 Vite 生产构建及 8 文件 69 项测试通过：CloudView/CloudStorage/CloudPanel、DoneBotView/API、退出/侧栏/路由；含收费确认、取消后重新扣款确认、备份与节点令牌确认。构建保留既有 Browserslist、动态导入/chunk 和 shell 弃用提示 |
| 浏览器 HTTP/WS 会话 | 一次性开门码并发只有一次成功，跨实例/Origin/UA/IP、过期码及过期 Cookie 拒绝；生产 Secure/HttpOnly/host-only/SameSiteStrict，数据库摘要/加密存储；撤销和到期关闭已有 WS |
| 真实 DoneBot 网页 | 私有 PostgreSQL + 两 worker + 两真实 DoneBot fake-engine 进程：网页/静态资源、原生 session/SSE、私有记忆；Chrome 双用户页面、甲聊天不出现在乙、fragment 清除、Cookie 脚本不可读、撤销后自有会话结束页 |
| 真实网关控制台联合流程 | 真实登录处理器/JWT、私有 PostgreSQL、miniredis、双 worker/agent 和真实 DoneBot 进程；Chrome 登录/开通、独立聊天、停启不重复扣费、到期停机拒绝访问、同实例续费恢复及超期删除通过；甲 2 笔、乙 1 笔、余额不足账户 0 笔合成扣款 |
| DoneBot 前端 | 会话/服务开关 24 项测试、修改文件 oxlint、前端 TypeScript 和临时目录 Vite 构建通过；构建仍有既有 CSS/第三方注释/chunk 大小提示 |
| 真实 Linux Docker | 一次性 Debian 13 ARM64 VM 内，从核对过的 DoneBot 提交构建 server 镜像，两个真实容器的原生鉴权、配置、网络 namespace、卷不可见、无控制 socket/密钥、持久化和定向回收通过 |
| 真实 Linux 受控出网 | 两个真实容器的公网 HTTPS/DNS、网关匿名 401；跨租户、宿主机私网/公网、元数据、额外公网拒绝列表、非允许 TCP/UDP、IPv6、IPv4 映射、重绑定及外部主动连接被拒绝；防火墙不可用时禁止创建、失败原子更新、属主冲突保留、agent 对象重建和定向网络删除通过 |
| 自动模型凭据 | 真实 PostgreSQL、双 worker、两个真实 DoneBot fake-engine 进程及合成网关：安装 ID/用户分离、免二次登录、无用户 JWT/密码、合成模型回复；新镜像也验证只读 Cloud 凭据恢复及公开状态无 key |
| Linux 存储、备份及恢复 | 硬配额 ENOSPC、另一用户可写、空间回收、格式化中断；AES-GCM 快照、幂等、损坏不覆盖、提交中断恢复、轮换、卷忙删除失败后重试、回收清除备份 |
| Linux 原生浏览器 | 新镜像，两容器 Browser SSE/画面/HTTPS 导航、独立 Chrome 资料和 localStorage 停启保留、跨实例 viewer 拒绝。离线生成合成 Bot，不调用真实模型 |
| Linux socket 边界 | 固定真实 socket inode、HTTP/WS 禁连接池；替换路径为宿主服务 symlink 被拒，已固定 socket 不跳转，凭据探测也固定 inode，宿主 canary 从未收到请求 |
| Linux systemd 与升级 | agent/维护 flock 互斥；systemd root 挂载对 Docker 可见；强杀 agent 后 ExecStopPost 停机保留数据；运行中拒绝升级，显式停机换镜像保留卷且可重复准备 |
| Linux VM 重启 | 真正停止并启动同一专属 VM，boot ID 改变；Docker restart=no、ext4 重新挂载，两用户标记保留及定向回收 |
| 线上身份只读核对 | 测试账号 login / auth/me 成功；DoneBot account / Cloud instances 为 404，logout 为 502。未验证线上 Cloud 主控或声称退出成功，未调用扣费/续期/资源变更 |
| npm 依赖 | `ws` 锁定依赖版本为 8.22.2；审计 0 漏洞 |

真实 DoneBot fixture 的本轮日志（仅本机临时证据目录，日志不加入仓库）：

```text
/var/folders/wf/gs6jc_rd4qd_6_1jmqjkg1jh0000gn/T/donebot-verification-evidence/server-1794415096836-38167.log
/var/folders/wf/gs6jc_rd4qd_6_1jmqjkg1jh0000gn/T/donebot-verification-evidence/server-1794415098726-38167.log
```

真实 DoneBot 测试使用既有 `scripts/control-omb.ts` 隔离启动器的导出接口，独立临时 home/data、空闲端口、fake engine，不启动本机正在使用的 DoneBot。该测试没有验证真实模型计费、互联网、桌面、Linux namespace 或生产 JWT 登录。

Go 集成 fixture 使用 `initdb` 创建临时集群，仅监听专有目录内的 Unix socket，拒绝外部 DSN；最小合成 users 表加真实 Cloud 迁移。测试通过 stdin 向 Node 传递随机配置，不写凭据文件。主控“重启”验证为同数据库重新构造 Service，worker 为重新创建 worker 对象；不是整机掉电测试。

## 复现命令

Cloud 工程：

```sh
npm ci
npm test
npm run verify:donebot
```

相邻 donebot-api/backend，需 Node 24 及本机 PostgreSQL 的 `initdb` / `pg_ctl`，以非 root 用户运行：

```sh
CLOUD_BILLING_PG_FIXTURE=1 CLOUD_BILLING_NODE_FIXTURE=1 go test -tags integration ./internal/cloudbilling -v
go test ./internal/cloudbilling ./internal/handler/... ./internal/server/routes ./cmd/server
```

相邻 donebot-api/frontend：

```sh
pnpm exec vue-tsc --noEmit
pnpm exec vitest run src/components/admin/donebot/__tests__/CloudPanel.spec.ts src/components/admin/donebot/__tests__/DoneBotView.spec.ts src/api/admin/__tests__/donebot.spec.ts
pnpm exec eslint src/components/admin/donebot/CloudPanel.vue src/components/admin/donebot/__tests__/CloudPanel.spec.ts src/components/admin/donebot/__tests__/DoneBotView.spec.ts src/views/admin/DoneBotView.vue src/api/admin/donebot.ts
pnpm exec vitest run src/views/user/__tests__/CloudView.spec.ts src/api/__tests__/cloud-logout.spec.ts src/components/layout/__tests__/AppSidebar.spec.ts src/router/__tests__/guards.spec.ts
```

浏览器验证先在相邻 DoneBot 将真实前端构建到本次拥有的临时目录，再在 donebot-api/backend 运行：

```sh
# 在 DoneBot 中
pnpm exec vite build --outDir /tmp/dbc-browser-donebot-20261112 --emptyOutDir
# 在 donebot-api/backend 中
CLOUD_BILLING_PG_FIXTURE=1 CLOUD_BILLING_NODE_FIXTURE=1 \
CLOUD_BILLING_BROWSER_FIXTURE=1 \
CLOUD_DONEBOT_STATIC_DIR=/tmp/dbc-browser-donebot-20261112 \
go test -tags integration ./internal/cloudbilling -v -count=1 -timeout=4m
```

此前 Chrome 复验使用 Playwright CLI 独立 `dbc-browser-20261112` session，打开同一 fixture 的合成控制页和两个真实 DoneBot 网页，没有访问生产登录、购买或模型接口。甲发送一条合成消息并收到 fake engine 回复，乙看不到甲消息；撤销后甲显示“Cloud 网页会话已结束”，返回链接指向自有控制台。顶层过期导航的主控重定向通过 HTTP 测试；当时人工 reload 到 fixture master 的 `/cloud` 为 401，因为合成主控没有生产 Vue 页面，该旧记录不能当成完整控制台浏览器验收。fixture 的 PG/DoneBot 进程、临时 home/data 已清理，独立浏览器 session 已关闭。机器可读结果见 [浏览器证据](verification/browser-2026-11-12.json)。本次增加的真实登录和 Vue 控制台验证另记如下。

## 真实网关登录与用户控制台联合验收

`TestCloudConsoleJourney` 启动本次专有 Unix socket PostgreSQL、miniredis 与回环 HTTPS，运行真实 `AuthHandler` 登录/身份/刷新/退出、JWT middleware、Cloud handlers/Service，以及迁移 108、260–263。用户表来自真实 ent schema；fixture 用户 repository 从合成行读取身份和余额，头像/身份列表、公共设置及无关控制台元数据使用合成响应。没有接入支付平台或生产用户。

两个真实 Node worker/agent 启动 DoneBot 既有隔离 launcher，使用独立临时 home/data、真实前端与 fake engine。网关和 DoneBot 的生产前端构建都输出到本次临时目录，不覆盖工作区 dist。Playwright CLI 的三个独立 Chrome session 从真实登录页进入 `/cloud`，网页网络访问限制在回环测试域名。

甲、乙分别确认开通并进入各自子域名，只能看到自己的聊天标记；一次性开门码清除。甲停机后启动，扣费仍为 1 笔；推进其合成订阅到期并置零余额后，主控拒绝访问（HTTP 403）、节点停机，页面禁止打开。向该合成账户补足余额，worker 自动续费，累计 2 笔扣费，原实例 ID、节点和聊天标记保留。再推进至到期 8 天，实际 fixture home 被回收，控制台重新显示开通入口；乙仍运行、只有 1 笔扣费且聊天标记保留。第三账户先遇到容量不足，释放名额后从页面重试，明确显示余额不足、未开通未扣款，累计扣款为 0。

联合验收修复了两个缺陷：异步开通返回 202 但操作已失败时，页面不再显示受理成功，并提供重新确认的重试；余额不足持久错误使用明确代码。Gin 未匹配路由默认 404 会污染实例域名的开门页/交换响应，实例域名 middleware 现在先重置状态；开门页、客户端配对页、描述符、交换错误及非实例域名的 6 个回归场景通过。

真实浏览器 hold 验收 `TestCloudConsoleJourney` 通过（689.56 秒），其最终断言核对扣费、甲删除、乙运行和实际 purge。收尾后自动模式与 middleware 回归再跑通过（包耗时 6.273 秒）；相关 Go 普通包、CloudView 7 项测试、vue-tsc、改动文件 ESLint 与临时前端构建通过。浏览器日志含自签名测试证书的握手拒绝、被拦截的外部 SDK 和停机/导航时流中断；不声称浏览器控制台零错误或生产 TLS 已验收。

复现自动流程：先在相邻前端仓库分别构建，再在网关 backend 执行（环境变量仅为本次空目录路径，不含凭据）：

```sh
# 创建独占临时输出目录，以下三段在同一终端依次执行
console_build_dir=$(mktemp -d /tmp/dbc-console-build.XXXXXX)
(cd ../donebot-api/frontend && pnpm exec vite build --outDir "$console_build_dir/gateway" --emptyOutDir)
(cd ../DoneBot && pnpm exec vite build --outDir "$console_build_dir/donebot" --emptyOutDir)
(cd ../donebot-api/backend && CLOUD_CONSOLE_FIXTURE=1 \
  CLOUD_CONSOLE_STATIC_DIR="$console_build_dir/gateway" \
  CLOUD_DONEBOT_STATIC_DIR="$console_build_dir/donebot" \
  go test -tags integration ./internal/handler \
  -run '^(TestCloudConsoleJourney|TestCloudBrowserMiddlewareResetsUnmatchedRouteStatus)$' \
  -count=1 -timeout=4m)
```

人工 Chrome 联合验收另加 `CLOUD_CONSOLE_UI_HOLD=1` 和 `-timeout=26m`，按终端临时账户完成上述页面操作；只在本次回环 fixture 使用测试证书例外。测试控制入口的时间/余额操作仅限随机控制凭据保护的专有数据库。测试不会读取外部 DSN。hold 模式需要完成甲续费/删除、乙开通和余额不足场景后发送本次 `finish`；自动模式无需浏览器操作。结束时清理本次 PostgreSQL、worker、agent、DoneBot 临时目录和独立浏览器会话。

机器可读结果及截图摘要见 [console JSON](verification/console-2026-11-12.json)。本次是 macOS 进程与 Chrome 联合验收，不包含 Linux 容器、桌面 GUI、真实模型计费或生产 DNS/TLS；这些范围不能与其他独立证据拼接为一次完整生产验收。发布候选固定和回退步骤见 [发布说明](release-runbook.md)。

## 真实 Linux Docker：已通过基础检查

之前 `cloud-images.ubuntu.com` DNS 失败，并非所有 Linux 镜像源不可用。本轮改用 [Debian 官方云镜像](https://cloud.debian.org/images/cloud/trixie/20261103-2651/)，下载约 338 MB 的 ARM64 qcow2，使用 Lima 2.3.0 模板自带 SHA-512 校验成功；清华 Ubuntu 镜像目录也实测可达，未下载该源的镜像。

环境：Debian 13.7 / ARM64，内核 `6.12.115+deb13.1-cloud-arm64`，Docker `26.1.5+dfsg1`，Node `v24.18.0`，VM 4 CPU / 6 GiB 内存。未启动用户 Docker Desktop，未挂载主目录或用户应用数据，未改变宿主机 Docker context、DNS 或代理配置。

DoneBot 从 `b16912e0481e8cbab749d75ef0ccccb32247d7b8` 的 git archive 构建现有 `server` target，没有包含工作区的其他未提交修改。构建得到的本地不可变 image ID：

```text
sha256:56a809052c8067e1e3f3793c7d50acb3f3fdd61f94ec5536c4e5c102dd4728c5
```

`verify:linux` 已实跑通过：不同网络 namespace、另一用户卷路径不可见、无 Docker socket/控制密钥、网络拒绝、原生会话、停启持久化及定向删除；另一用户标记文件保留。结果与版本记录在 [JSON 证据](verification/linux-2026-11-12.json)。测试容器、卷和其私有状态目录已清理，专用 VM 停机后保留构建缓存，便于后续隔离验证。

可复现 VM 模板为 `deploy/linux-fixture.yaml`，适用于 Apple Silicon 上的 Lima VZ。该模板不挂载宿主机目录，并禁止应用端口自动转发；进入 VM 通过显式复制源码准备 Node 24 和镜像，不依赖原机数据：

```sh
limactl start --name=donebot-cloud-fixture-20261112 --mount-none --tty=false deploy/linux-fixture.yaml
```

VM 内的验证命令（需 root 管理 Docker 和设置 IPC 目录属主）：

```sh
sudo env CLOUD_DISPOSABLE_LINUX=1 CLOUD_DONEBOT_IMAGE="$REVIEWED_DONEBOT_IMAGE_DIGEST" node scripts/verify-linux.mjs
sudo env CLOUD_DISPOSABLE_LINUX=1 CLOUD_DONEBOT_IMAGE="$REVIEWED_DONEBOT_IMAGE_DIGEST" node scripts/verify-egress.mjs
```

如果原源下载失败，可换 Debian 官方镜像、可信发行版镜像站，或在其他网络下载同一文件、校验摘要后作为本地镜像导入；不必修改宿主机全局 DNS 或接管现有应用。要换成不同镜像内容，必须同步取得可信的新摘要，不能直接取消校验。

脚本只创建/删除本次部署 UUID 与实例 UUID 标记的容器/卷/网络和本次精确拥有的 namespace、veth、地址/路由及 nft 表。清理失败会保留私有状态供恢复，不宽泛删容器。上述旧镜像记录仅证明当次基础边界；后续新镜像、配额、备份、重启、systemd 与浏览器证据单独记录如下，不能反向扩大旧记录范围。

## 受控出网：已通过真实网络检查

`verify:egress` 在同一专用 VM 内使用两个真实 DoneBot 容器和各自专属 bridge，安装本部署独占的 nftables 规则。公网 `example.com` HTTPS 返回 200，未携带凭据的 `https://donebot.cn/api/v1/auth/me` 返回 401；没有调用模型或余额接口。

合成目标运行于本次专属 network namespace，提供可用的 HTTP 80/443、非允许 TCP 端口和 UDP 回声服务。目标地址通过 VM 内精确路由到达，包括模拟私网/元数据及公网形态地址。受信宿主机先确认这些服务可用，再从租户执行负向访问；测试不会向合成公网地址的实际归属方发包。跨租户目标也启动真实监听并验证自身回环可达。

两用户跨网络、宿主机私网/公网、元数据、额外公网拒绝列表、非允许 TCP/UDP、IPv6、IPv4 映射、DNS 重绑定和外部主动连接全部被拒绝。缺少 nft 时容器/网络/卷均未创建；相同表名的不同属主不会被覆盖；故意失败的 nft 事务保留旧隔离。重建 DockerRuntime 对象可恢复原实例，删除一个网络后另一实例仍可联网并保持隔离。此“重建”是同一内核内的新对象，不代表系统掉电恢复。

网络证据及版本记录见 [JSON 证据](verification/egress-2026-11-12.json)，实现范围见 [网络边界](network-isolation.md)。测试结束已核对没有遗留测试容器、卷、bridge、专属 nft 表、network namespace 或合成路由。

## 证据限制

- 默认 `network=none` 完全禁网；显式 `public-web` 的公网 Web/DNS 和原生浏览器已验证，其他内核/防火墙后端尚未验收。规则依赖受信宿主机保留本部署 nft 表。
- 硬磁盘配额已实现和验证；节点 capacity 仍是配置名额，没有目标服务器硬件承载量实测。
- 原网关 logout 不保证立即撤销已签发 JWT，见接口核对。Cloud 会话支持独立撤销，但退出时若网关离线，旧 Cookie 可能有效至到期。模型安装凭据已独立接入，网页 Cookie 与安装 key 不能互作授权。
- 实例运行与访问授权分开：访问到期拒绝，实际停机/删除取决于节点在线、agent 和 Docker。失败不能当成删除成功。
- DoneBot 修改涵盖前端、统一网关接入、验证工具及另获明确授权的仅 Cloud 模式桌面适配；没有迁移现有用户目录或部署生产。
- 原生客户端协议与真实网关登录/开通页面 Chrome 联合流程已通过；打包 GUI 仍待验收。浏览器流程使用合成账户、余额和模型，不能替代生产支付与模型验收。
- 模型请求使用合成网关；没有真实模型计费或生产异步媒体验收。独立 Linux 桌面已获明确授权并接入，见 [具体范围和限制](desktop-adapter-proposal.md)。
- 备份是本节点本地加密快照，没有异地灾备；readiness/timer 没有外部告警投递。

## 后续运行验证：新镜像、存储和恢复

新镜像基于 DoneBot `b61d71ac5004c55c4ca8765a222f40344b95ae6b` 工作区，包含本轮前端及网关安装凭据接入，不包含原版桌面修改。使用现有 Dockerfile `server` target、验证构建 `ENGINES=`，不等同于生产完整模型 CLI 镜像。源码包 SHA-256：`55d10e6cfdbccd3c5cc19583675829a3344855b8d6e0ad4480c88f7b23cc77e3`；得到不可变本地 image ID：

```text
sha256:a3902c61fead7edb0abd8d338860012ae2ade4c05b04ccaa413da2ec45395cd9
```

模型免登录验证使用 macOS 隔离 DoneBot 进程及合成安装服务/模型请求；Linux 新镜像另验证安装凭据读取和两用户身份分离，不能称为 Linux 生产模型计费闭环。机器可读汇总见 [runtime JSON](verification/runtime-2026-11-12.json)。

在一次性 VM 内以 root 运行，下面 digest 使用经核对的新镜像：

```sh
sudo env CLOUD_DISPOSABLE_LINUX=1 CLOUD_DONEBOT_IMAGE="$REVIEWED_DONEBOT_IMAGE_DIGEST" npm run verify:storage
sudo env CLOUD_DISPOSABLE_LINUX=1 CLOUD_DONEBOT_IMAGE="$REVIEWED_DONEBOT_IMAGE_DIGEST" npm run verify:recovery
sudo env CLOUD_DISPOSABLE_LINUX=1 CLOUD_DONEBOT_IMAGE="$REVIEWED_DONEBOT_IMAGE_DIGEST" npm run verify:socket
sudo env CLOUD_DISPOSABLE_LINUX=1 CLOUD_DONEBOT_IMAGE="$REVIEWED_DONEBOT_IMAGE_DIGEST" npm run verify:service
sudo env CLOUD_DISPOSABLE_LINUX=1 CLOUD_DONEBOT_IMAGE="$PREVIOUS_DONEBOT_IMAGE_DIGEST" CLOUD_UPGRADE_IMAGE="$REVIEWED_DONEBOT_IMAGE_DIGEST" npm run verify:upgrade
```

`verify:service` 以随机专属 transient systemd unit 启动真实生产 agent，注入合成安装 key，检查私有挂载和 ready 后强制终止 main，等待 ExecStopPost 定向停机。fixture 不启用公网出口，不接触真实网关。`verify:recovery` 覆盖快照 restore 提交前注入中断，然后重建 runtime 完成恢复；自动备份先成功新建再轮换，损坏快照不会覆盖当前数据。

浏览器需要从 DoneBot 既有隔离启动器导出一个不含凭据的合成 Bot registry，在宿主机执行：

```sh
node scripts/browser-seed.mjs /tmp/dbc-browser-seed-UNIQUE.json
```

精确复制该文件到专属 VM，再执行：

```sh
sudo env CLOUD_DISPOSABLE_LINUX=1 CLOUD_BROWSER_SEED_FILE=/var/tmp/dbc-browser-seed-UNIQUE.json CLOUD_DONEBOT_IMAGE="$REVIEWED_DONEBOT_IMAGE_DIGEST" npm run verify:browser
```

它在停机的本次专属卷中写入合成 registry，然后通过 agent 转发原生 Browser API，接收 SSE/帧、导航公网 HTTPS；仅在本用户容器内部用其私有 CDP 检查 localStorage。没有对外暴露 CDP 端口，没有借此声称真实模型驱动的桌面操作已通过。

VM 重启脚本分 `prepare`、`verify` 两步，状态目录必须用专属 `/var/tmp/dbc-reboot-*`（生产使用 `/var/lib`）；`prepare` 输出需要保留的精确目录，停止/启动本次 VM 后将同目录传给 `verify`。真实 boot ID 改变才通过，不能以重建 Node 对象代替。初次将 fixture 放 `/tmp` 遇到系统开机清理，已定向清理那次资源，改为 `/var/tmp` 后重新验证通过。

新镜像最终复验同样完成实际 VM 停启；`verify:linux`、`verify:storage` 和 `verify:egress` 也在新镜像重新通过。原有旧镜像 JSON 保留，新增汇总不替换其原始证据。最终已核对本部署测试容器、卷、网络、namespace、专属 nft 表和 loop 挂载无残留；Docker 自身 nat/filter 表保留，专属 VM 已停止并保留镜像缓存。


## 专属桌面与双盘备份

本会话收到用户对 Cloud 桌面适配的明确授权后，增加专属 Unix socket 适配并复用 DoneBot 原版桌面镜像及 CUA MCP。旧 runtime JSON 记录的是该授权前的状态，保持不改；最新结果单独存入 `verification/desktop-2026-11-12.json`。

在同一专属 Debian VM 中以 root、合成内容执行：

```sh
sudo env CLOUD_DISPOSABLE_LINUX=1 CLOUD_DONEBOT_IMAGE="$REVIEWED_DONEBOT_IMAGE_DIGEST" CLOUD_DESKTOP_IMAGE="$REVIEWED_DESKTOP_IMAGE_DIGEST" npm run verify:desktop
```

脚本创建两个真实 DoneBot 服务和各自桌面，运行盘 256 MiB、桌面盘 512 MiB，使用独立网络。通过原 Computer 状态/截图与查看 WebSocket、打包后的原 `container-mcp.js` 调用 CUA `get_desktop_state`，另外验证 UID 1000 命令及限额文件下载。桌面保留期不是月付时间模拟：脚本使用真实短期运行租约，停止续租后查看断开且两类容器停止，另一用户仍能恢复自己的数据。

双盘备份先保存合成标记，再修改两盘；损坏桌面加密文件时运行盘也不能被覆盖。幂等恢复后两盘回到原标记；在只完成运行盘替换的持久提交点注入中断，关闭并重建 agent/runtime，再启动完成桌面盘替换。桌面显式镜像替换只移除停机容器、保留资料盘，重复准备无副作用。空闲、订阅停机和定向删除均验证资源结果。

DoneBot 相关 9 个单元测试文件共 254 项通过，覆盖本地桌面、查看、原 MCP 控制门、附件和新 Cloud 适配；服务端与前端类型检查、改动文件 lint 通过。网关资源页补充桌面限额与双盘恢复提示，其类型检查、组件测试、生产构建和相关 Go 包检查通过。单元测试与 API/字节流检查不替代打包 Electron Computer 面板、真实模型聊天附件交付或完整安全审计。

完全禁网的额外检查发现 VNC 在 Docker `network=none` 下无法解析自动容器主机名；适配已固定桌面主机名及容器内回环映射，未修改宿主 DNS。随后重新验证禁网启动与真实 VM 停启，结果记录在桌面 JSON 中。

双盘自动备份另以 `verify:backup-groups` 验证：两个真实 128 MiB ext4 文件系统，首次桌面快照失败后按原键恢复、无重复快照，连续轮换只保留三组，淘汰组的两份文件均删除，保留组可恢复两盘不同标记。该脚本不启动桌面容器，不替代上述完整桌面验证。备份认证失败时也会清理尚未提交的临时恢复盘。

本轮机器可读结果见 [desktop JSON](verification/desktop-2026-11-12.json)，其中分别记录最后桌面镜像验证和禁网 VM 重启所用运行镜像。

## 2026-11-13：运行凭据与启动诊断回归

本轮在 macOS、Node.js 24.18.0 和 Go 测试进程中验证；PostgreSQL 17 每个 fixture 使用 `/tmp/dbc-*` 新数据目录、独立 Unix socket、禁用 TCP 和合成用户/余额，结束后精确停止并删除自有资源。未连接生产数据库、测试账户或节点；未启动用户 Docker Desktop、专属 Linux VM 或新的真实镜像构建。

- `npm test`：15 项全部通过，包含已有双用户代理/停启和新增启动诊断、退避及镜像准备工具检查。
- donebot-api `go test ./internal/service -run '^TestDoneBot' -count=1`：通过。新增回归在修复前复现普通管理入口导致的 `API_KEY_NOT_FOUND`；修复后托管凭据重复验证成功，普通查询仍拒绝，过期、禁用、旋转及 owner/group 不符继续拒绝。
- `go test ./internal/server/routes -run '^TestCloudNodeAndUserRoutesHaveSeparateAuthentication$' -count=1`：通过，覆盖运行凭据、claim、report、confirm-purge 路由注册及用户/节点鉴权分离。
- `CLOUD_BILLING_PG_FIXTURE=1 go test -tags=integration ./internal/handler -run '^TestCloudRuntimeCredentialWithRealManagedKeys$' -count=1`：通过。使用真实 PostgreSQL、安装服务、APIKeyService 和 repository，以及真实 CloudNode/RequestLogger 处理器；首次和重复签发、停机拒绝、再次启动签发、仅一笔扣费和一个托管 key、节点身份拒绝、错误实例拒绝、安装撤销拒绝、业务阶段和 request ID 均通过。凭据只在测试进程内使用，不写证据或日志。此测试不启动 Docker/浏览器。
- `CLOUD_BILLING_PG_FIXTURE=1 CLOUD_BILLING_NODE_FIXTURE=1 go test -tags=integration ./internal/cloudbilling -run '^(TestPostgresRuntimeCredentialsStayBoundToAssignedNode|TestPostgresWithTwoNodeWorkers|TestPostgresNodeCredentialRotationAndRevocation)$' -count=1`：通过。覆盖 12 并发凭据获取、加密落库和节点绑定、两个真实 Node worker 加合成 agent/runtime 的持久状态与停启/删除、节点 token 轮换撤销；新增失败日志的 request ID、reason、step 与无凭据字段检查。

worker 的新增回归明确验证业务 404 与无结构 HTTP 404 可区分，未知 reason/metadata/message 不进入日志，report 失败与接收失败结果分别可见，凭据失败时 agent 未启动，重复 claim 不绕过退避、恢复后可访问、停止后访问拒绝。模拟部分创建后失败时，worker 不授权代理，丢失租约仍会停掉可能残留的运行资源。测试还保留“节点 healthz 成功而实例启动失败”的案例，防止混淆。

镜像准备工具使用临时合成 Git 仓库和模拟 Docker 检查：完整 SHA 与干净源码约束、原版 server target、两类镜像、平台不符时不生成成功清单、离线包 SHA-256 和 env 输出。另对真实 DoneBot `e9d24ff50f10e5772409089386f202e2b1813447` 执行只读 dry-run，并在临时 HOME 导出真实原版桌面 Dockerfile，核对 CUA 0.37.0 / image-layer 8 labels。没有重新构建镜像；这些检查不能替代完整构建、镜像启动或目标 Linux 架构验收。

线上业务响应与已复现源码缺陷一致，主控二进制 SHA 尚未取得；不把本地通过当作生产恢复证据。详见 [故障诊断与上线复核](runtime-credential-diagnostics.md)。GitHub 构建未启动的账单/额度问题与凭据 404 相互独立；仓库公开、账单修改、任务重跑和镜像发布均未执行。

## 2026-11-13：公开仓库后的镜像 CI 复核

用户随后自行将 DoneBot 仓库设为公开。只读核实后，重新运行原 Docker workflow 的 run `43370375981`（attempt 2，DoneBot 完整 SHA 仍为 `e9d24ff50f10e5772409089386f202e2b1813447`）。GitHub 托管的临时 amd64/arm64 runner 均实际执行了构建；arm64 构建与 server/UI/DuckDB/浏览器启动检查成功，amd64 的构建、server/UI、开源版、浏览器、服务回环监听和 server+Caddy 配对检查成功。后续原版 `cloud-home` 检查中的引擎列表断言返回 false，任务失败，发布 job skipped；没有将 CI 本地 image ID 称为已发布镜像。

本仓库新增手动 `cloud-images.yml`，限定完整 DoneBot SHA 和 amd64/arm64 平台。它复用原版 Dockerfile/桌面生成器及已有 `verify:linux`、`verify:desktop`，所有验证完成后才执行 registry push；完成清单记录两个真实注册表摘要。新 workflow 的 YAML、各 bash 块及 actionlint 校验用于检查流程配置，不代替真实运行。此次未修改或推送 DoneBot 仓库代码。该次检查时 DoneBot-Cloud 仍为私有仓库，其 Actions 额度与 DoneBot 的公开状态分别判断。

新流程已通过 actionlint 1.7.12、YAML 和 bash 语法检查，推送后触发了 [Cloud run 43383723725](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/43383723725)，平台为 `linux/amd64`、DoneBot SHA 同上。job 的 steps 为空，GitHub annotation 明确为账户账单失败或需提高支出额度，尚未执行构建。没有绕过验证发布镜像，也没有自动公开 Cloud 仓库或修改账户计费。要继续执行需有可用私有 Actions 额度，或用户明确决定将该仓库公开后重跑。


## 2026-11-13：Cloud 公开授权与 Linux 兼容修复

用户明确授权公开 Cloud 后，已将 `Zluo003/DoneBot-Cloud` 设为公开，并继续使用 GitHub 临时 Linux runner 构建；没有修改账户账单或生产节点。源码仍固定在 DoneBot `e9d24ff50f10e5772409089386f202e2b1813447`，平台 `linux/amd64`。

真实 runner 暴露并修复两处兼容问题：

- nftables 1.0.9 不接受 Node 子进程基于 socket 的 stdin 作为 `nft -f -` 规则文件。现改用本次创建的 0700 临时目录和 0600 常规文件，整套规则仍为单次原子事务，成功/失败均精确清理。新增构建前 nft 主机检查和常规文件回归；完整 `verify:egress` 在 Docker 28.0.4 / nftables 1.0.9 上通过。
- Docker 28.0.4 的 inspect 使用 `CAP_CHOWN` 等名称，桌面原校验只接受 `CHOWN` 等别名。保留首个 fixture 错误后，运行 [43387029397](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/43387029397) 明确显示 `desktop_resource_spec_mismatch` 和这组前缀差异。校验现接受两种等价名称，能力集合仍严格一致；新增、缺少、重复能力和 `CAP_ALL` 继续拒绝。18 项本地单元测试通过。

桌面 fixture 只记录阶段、稳定错误码、栈位置和允许的容器状态/规格字段，不输出凭据、完整环境变量或查看链接。退出清理失败单独报告，保留原始失败；仅处理本次 fixture 明确拥有的两个实例。

最终 [run 43387570590](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/43387570590) 成功，Cloud SHA `7107d2690353319ef446fb7e43aa4815d9462202`。在临时 Ubuntu amd64 runner（kernel `7.0.0-1014-aws`、Docker 28.0.4、Node 24.18.0、nftables 1.0.9）完成两类真实镜像构建，以及 `verify:linux`、`verify:egress`、`verify:desktop`。桌面检查包含原 CUA/MCP、文件、WebSocket、跨用户网络和卷拒绝、停启持久化、双盘备份/损坏拒绝/幂等和中断恢复、空闲停机、升级保留、租约到期断连和定向删除。全部通过后才执行 GHCR push；没有跳过发布前检查。

发布清单、三组原始 fixture 结果和匿名访问复核保存在 [images JSON](verification/images-2026-11-13.json)，对应 [固定节点配置](../deploy/images/2026-11-13-amd64.env)。匿名清单/配置读取返回 200，两个镜像共 34 层的匿名 HEAD 及长度检查通过；未在本机执行完整 Docker pull。注册表清单摘要、配置 image ID、平台及源码 revision 与被验证镜像一致；没有将本地 image ID 当作 registry digest。该次未重跑 ARM64、VM 重启、原生浏览器、systemd 或生产模型/扣费验收；此前各检查仍以各自记录为准。主控运行凭据修复尚需用户自行推送和部署，未以镜像发布声称生产故障已恢复。


## 2026-11-13：同机网关与 Cloud 模型读取

用户报告 Cloud 有邮箱但模型和账号并发读取失败，随后确认网关域名解析到 Cloud 节点自身公网 IPv4。现有 `public-web` 规则会阻止这一宿主目标，不能用显示账号或节点 readiness 推断模型链路可用。修复新增显式 `CLOUD_GATEWAY_IPV4`：仅服务网络到指定公网宿主 IP 的 TCP 443 及已建立回复放行；默认留空，桌面不继承，拒绝范围冲突时不开例外。没有开放 host 网络或关闭鉴权。

[Node network run 43392947213](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/43392947213) 成功。临时 Ubuntu amd64、Docker 28.0.4、nftables 1.0.9、Node 24.18.0，直接拉取此前发布的固定服务摘要，未重新构建镜像。先验证默认宿主拒绝，再将测试专属公网形态地址配置为网关：两用户均只能到达该地址的 443；确实存活的同宿主 80/18991、其他宿主网桥地址、另一用户容器和私网目标继续拒绝。重建 runtime 并移除配置后，该 443 再次拒绝。原完整出网拒绝、原子更新、防火墙缺失和定向回收检查同轮通过。仅处理本次专属地址、服务、namespace、bridge 和容器。原始结果见 [cohost JSON](verification/cohost-gateway-2026-11-13.json)。

Cloud 20 项单元测试通过，包括非法/私网/保留/额外拒绝的网关地址拒绝，以及只读模型诊断的精确归属校验和 inspect 信息过滤。诊断脚本只用于管理员显式选定实例的 GET，不启停实例、不提交生成或扣款、不输出完整凭据或响应；此轮只对其合成执行入口做检查，没有在生产运行。

DoneBot 的统一网关适配另增加固定的 DNS、超时、TLS、连接及非 JSON 错误。3 个测试文件共 22 项通过；真实隔离 DoneBot 服务配合回环合成网关，安装模式无需用户 JWT 即可读模型和并发；断开网络后身份仍在但 GET 明确失败，恢复网络后无需再次登录即可重新读取。服务端类型和变更文件 lint 通过。这部分源码保留在 DoneBot 工作区，由用户自行推送；同机防火墙修复不依赖更新运行镜像。

网络层检查使用 TCP 443 上的合成 HTTP 服务，证明地址/端口规则及双向流量；不提供 SNI/Host/路径过滤。隔离进程的安装鉴权测试与 Linux 网络测试分别记录，不称为生产网关真实模型/余额闭环。本轮没有修改或验收生产节点，部署步骤见 [同机说明](deployment.md#网关和-cloud-节点同机)。


## 2026-11-14：恢复 GitHub 基线后的桌面替换范围

DoneBot 和 Cloud 分别恢复到 GitHub `822b27499cf6d6981ae05088172f4d55abb610f6` 与 `91645e32a57596f25e84bf8f367d1b02040a219d`；未提交的大范围同步改造在外部归档及两个仓库的 stash 中保留。本轮仅增加自有桌面固定协议桥及必要工作位置、工具挂载、查看和附件回传适配，没有恢复团队同步或任务迁移。网关源码未改动，复用已有带归属和订阅验证的实例代理。

标准配置仍为运行服务和图形桌面各 1 核 / 2 GiB，合计 2 核 / 4 GiB；新实例两盘为 5 + 10 GiB，配置合计硬上限 15 GiB。已有较小盘继续使用持久记录的容量，备份及恢复按实际容量验证。生产 agent 缺少图形桌面镜像时拒绝启动。

Cloud 28 项单元测试和 DoneBot 59 项针对性测试通过，类型、lint、服务打包与前端构建通过。真实两个隔离 DoneBot runtime 加合成网关/桌面的 fixture 通过：同一 Bot 和会话、中文工具及命令各执行一次、原会话附件下载、真实 ComputerPanel/noVNC、退出后撤销查看。该 fixture 使用模拟 LLM。

一次性 Debian 13 ARM64 VM 使用本轮服务 bundle 覆盖原缓存测试镜像，仅构建本地 fixture 镜像。真实双用户 Linux 检查通过：CUA 截图、原 MCP、UID/网络/卷/socket 隔离、文件下载、VNC、查看者排除命令控制、停启持久化、双盘备份及损坏/中断恢复、默认容量提高后旧盘容量及恢复、租约到期断连、空闲停止和定向删除；独立磁盘 fixture 验证真实 ENOSPC、其他用户不受影响和格式化中断恢复；systemd fixture 验证必需桌面镜像、宿主挂载、锁与主进程异常退出后的停机保护。VNC 关闭测试显式发送正常关闭码 1000，以适配该桌面镜像的 KasmVNC 关闭握手。所有测试仅使用本轮临时实例，结束回收测试资源。

[本轮机器记录](verification/desktop-scope-2026-11-14.json) 保留具体镜像 ID、标准配额与限制。磁盘写满测试使用小容量文件系统；没有用真实模型或生产账号验收，也未重跑 amd64 容量检查、发布镜像、部署生产或打包 DMG。历史发布摘要不包含本轮源码。
