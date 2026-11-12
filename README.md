# DoneBot Cloud

DoneBot 的多服务器云实例工程。donebot-api 负责账户、余额、月付订阅、实例归属、调度和唯一管理后台；本项目提供每台 Linux 主机上的 worker、受信 Docker agent 和访问转发。运行服务复用 DoneBot 镜像，不复制其源码。

已实现可运行工程、PostgreSQL 主控、双 worker、月付余额扣款、统一后台、网页和原生客户端连接协议、自动安装凭据、磁盘限额、加密备份恢复、节点令牌轮换和显式镜像升级。真实 DoneBot 隔离进程与一次性 Debian 13 ARM64 容器已完成对应验证，包括原生浏览器、资料持久化、系统重启及故障恢复。**尚未部署生产。每用户专属桌面已按明确授权完成适配及真实 Linux 验证；生产容量及打包客户端 GUI 尚未验收。**

## 业务规则

- 复用 donebot-api 账户和余额，不增加注册流程或密码库。
- 按月预付，月费在现有 DoneBot 管理页的“Cloud 管理”中配置。余额不足不开通、不续期，Cloud 扣款不允许透支。
- 到期续费失败后关闭访问并停机；默认保留 **7 天**，之后自动删除实例及数据。保留天数可在同一后台调整。
- 删除前再次确认订阅和保留期；进入不可逆删除阶段后拒绝续费扣款。删除失败保留错误和资源记录，重试成功后才标记删除。
- 尚未激活的开通费在取消或最终回收时只退款一次。取消已激活订阅会停机并关闭自动续费，不退当月费用。
- 每用户一个独立实例、一个专属数据卷和按需独立桌面资料盘。已派发启动命令的实例固定在原节点，不因离线复制或迁移数据。

## 架构

```text
浏览器 / DoneBot 客户端（网关 JWT）
                  |
            donebot-api 主控
     账户 / 余额 / PostgreSQL / 管理后台
          |                         |
   私网 HTTPS + 签名授权       私网 HTTPS + 签名授权
          |                         |
      Worker A                  Worker B
          | 本机 Unix socket        | 本机 Unix socket
      Docker Agent A            Docker Agent B
          |                         |
     用户甲 DoneBot              用户乙 DoneBot
       独立卷                      独立卷
```

节点用专属令牌领取任务、续租和回报，不直连数据库、不持有主控私钥或网关管理员凭据。HTTP / WebSocket 均经过归属及签名检查；原生 DoneBot 会话由 agent 保存和续建，不发给浏览器。数据库留在主控私网即可，多机部署不需要开放公网 PostgreSQL。

用户在网关 `/cloud` 开通、启停并打开实例。每实例使用独立子域名，60 秒一次性开门码兑换 HttpOnly Cookie，浏览器无需向原生 WebSocket 设置 Authorization。Cookie、JWT、实例归属和订阅持续复查，撤销和到期会关闭已有连接；详见 [浏览器接入](docs/browser-access.md)。

DoneBot 运行容器使用固定镜像摘要、UID 1001、只读根目录、CPU / 内存 / PID 限制和独立卷，无 Docker socket、无发布端口。网络默认 `none`；Linux 节点可显式启用 `public-web`，由独立 bridge 和宿主机 nftables 强制允许公网 HTTP/HTTPS、指定 DNS，拒绝租户互访、宿主机、私网、元数据、IPv6 及其他端口。规则安装失败不开机，删除网络成功后才释放其规则；不依赖应用遵守代理变量。原生浏览器 HTTPS/SSE 与资料隔离已通过 Linux 检查；模型免登录及请求使用合成模型服务验证，未调用真实余额或生产模型。容器共享宿主机内核，不能隔离宿主机管理员。

生产默认运行服务与桌面各 5 GiB 固定容量 ext4 文件系统，实际可用空间略少。后台用户页提供资源余量、最多 3 份本地加密备份（包含两盘）、停机备份及确认覆盖恢复；节点可选自动备份轮换。备份随到期回收删除，不是异地灾备，详见 [存储与备份](docs/storage-backups.md)。

专属桌面复用 DoneBot 的 CUA 镜像和原 MCP 工具，每账户一个桌面，默认空闲 30 分钟停止。它独立使用 1 CPU、2 GiB 内存和资料盘，无宿主 Docker 权限；停止、租约失效、备份和到期回收均联动。见 [桌面说明](docs/desktop-adapter-proposal.md)。

## 本地运行

需要 Node.js 24.13–24.x。以下命令只启动临时合成网关及运行实例，不连接真实网关或已有用户数据：

```sh
npm ci
npm run dev
```

终端显示回环地址、合成用户名及本次生成的临时密码。开发入口支持 `/v1/login`、`/v1/instances` 和实例启停/代理 API；没有注册页面。Ctrl-C 只清理本次 fixture 自有资源。

```sh
npm test
npm run verify:donebot
```

第二条要求相邻 `../DoneBot` 依赖可用，使用其隔离验证启动器及 fake engine；不证明 Linux 容器隔离。

`npm start` / `npm run worker` 是节点入口，需先登记节点；`npm run agent` 是本机受信执行入口。`npm run control:fixture` 仅允许开发模式，SQLite 控制器只用于 fixture，不作为生产主控。

## 文档

- [首阶段进度](docs/first-milestone.md)
- [专属桌面与授权范围](docs/desktop-adapter-proposal.md)
- [真实接口与授权范围](docs/interface-audit.md)
- [主控与节点部署](docs/deployment.md)
- [浏览器入口与会话边界](docs/browser-access.md)
- [受控出网及网络边界](docs/network-isolation.md)
- [存储、备份和恢复](docs/storage-backups.md)
- [隔离验证记录](docs/verification.md)
- [发布候选、迁移顺序与回退](docs/release-runbook.md)

真实网关登录、开通确认、两用户独立聊天、停启、到期停机、续费保留数据及超期回收已完成 Chrome 联合验收，使用私有 PostgreSQL、真实处理器和合成余额。剩余工作为打包客户端 GUI、生产模型与目标服务器容量验收。节点 capacity 是管理员配置的实例名额，不是硬件承载能力的实测值。已有验证的范围与限制见 [首阶段进度](docs/first-milestone.md)。
