# 主控与多服务器节点部署

Docker、受控出口、存储/备份、浏览器、故障恢复与 systemd 生命周期已在一次性 Debian 13 ARM64 VM 中验证；主控使用私有 PostgreSQL、双 worker 和真实 DoneBot fixture 验证。当前 x64 镜像另通过 GitHub 的真实 Linux 发布验证，见下文已发布镜像；每个目标节点仍须按实际容器完成升级和验收，不能用构建成功代替节点结果。

## 主控：donebot-api

1. 按网关已有方式发布包含 Cloud 改动的后端和前端，启用 `donebot.enabled`。sh 安装的现有网关按下节使用后台在线更新；正式二进制内嵌前端和迁移。迁移 `260_donebot_cloud_subscriptions.sql`、`261_donebot_cloud_control.sql`、`262_donebot_cloud_browser.sql`、`263_donebot_cloud_runtime.sql`、`264_donebot_cloud_node_deletion.sql`、`269_donebot_cloud_auto_renew.sql` 随网关启动时的正常迁移机制执行，无需手工执行 SQL；本轮未对生产数据库执行。先备份网关数据库及密钥，再按正常发布流程迁移。
2. 通过部署密钥管理注入 `DONEBOT_CLOUD_SIGNING_SEED`：32 字节随机 Ed25519 seed 的标准 Base64，只保存在主控。多副本主控使用同一 seed。可用 `node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'` 生成后存入私有密钥文件，不加入版本库、终端录屏或共享日志。
3. 在独立的“Cloud 管理”导航选择“套餐与保留”，设置月费和保留天数（默认 7），先保持套餐关闭；节点和隔离预发布验收完成后再启用。金额单位沿用账户余额，非新增货币单位。
4. 每台服务器登记名称、私网 HTTPS origin、实例名额。保存一次性显示的独立节点 token、node ID，以及主控公钥。主控公钥在节点区持续显示，添加和轮换令牌响应也直接附带公钥，填入节点 `worker.env` 的 `CLOUD_MASTER_PUBLIC_KEY`。后台可轮换或撤销节点令牌；旧令牌立即失效，轮换所得新令牌仅显示一次，写入该节点配置后重启 worker。撤销同时暂停新分配，已有实例会在租约失效后停机，数据仍留原节点。
5. PostgreSQL 仅由网关访问。节点经 VPN/虚拟网访问主控 API，主控经私网 HTTPS 访问节点；不开放公网数据库，不给节点管理员 JWT 或数据库密码。
6. 浏览器入口配置 `DONEBOT_CLOUD_MASTER_ORIGIN=https://donebot.cn`、`DONEBOT_CLOUD_BROWSER_ORIGIN=https://cloud.donebot.cn`。将 `*.cloud.donebot.cn` 的 DNS/TLS 指向主控，代理保留实例 Host、原路径、Origin 和 WebSocket 升级，并允许 SSE 长连接；前置代理禁止共享缓存，保留网关下发的浏览器私有缓存头。不要把实例域名直接指向 worker。详细配置及会话限制见 [浏览器接入](browser-access.md)。不配置 browser origin 时保持禁用，配置错误则主控启动失败。

主控必须能校验节点 HTTPS 证书。节点反向代理只允许主控私网来源，启用 WebSocket 升级。TLS 终止代理需保留外部 `Host` 并准确设置 `X-Forwarded-Proto: https`；agent 的 `CLOUD_PUBLIC_ORIGIN` 与 worker 的 `CLOUD_MASTER_ORIGIN` 均配置为外部主控 origin，例如 `https://donebot.cn`。

### 现有网关：sh 脚本安装与后台在线更新

沿用 donebot-api 的 `deploy/install.sh` 安装结果：程序 `/opt/sub2api/sub2api`，systemd 服务 `sub2api`，运维环境文件 `/etc/sub2api/environment`。网关主控本身不要求安装 Docker 或 Node.js；这些运行依赖属于 Cloud 节点，两种角色在同机时才需要同时安装。自定义过安装位置的部署需先核对实际 unit，保留既有监听地址、端口和数据路径。

**发布端：先提供可在线更新的版本。** donebot-api 的 Release workflow 在推送 `v*` 标签或手动选择已有版本标签时执行。正式更新包须来自包含本次 Cloud 前后端和迁移的同一提交，并提供对应架构的 `sub2api_<版本>_linux_amd64.tar.gz` / `sub2api_<版本>_linux_arm64.tar.gz` 及 `checksums.txt`。后台更新读取 `Zluo003/donebot-api` 的 GitHub Releases；只推送 `main`、上传 Cloud 仓库或发布 Docker 镜像都不会替换网关二进制。发布时关闭 `simple_release` 和 `dry_run`，并确认仓库变量 `SIMPLE_RELEASE` 未启用；simple 模式不发布后台所需的二进制下载附件。正式 Release 还需能被服务器匿名下载，API 查询用的更新 token 不会用于附件下载。

**服务器首次配置：保存主控环境。** 先保全现有环境文件和部署配置，再编辑原文件并保留其他已有配置：

```sh
sudo mkdir -p /etc/sub2api
sudo touch /etc/sub2api/environment
sudo chown root:root /etc/sub2api/environment
sudo chmod 0600 /etc/sub2api/environment
sudoedit /etc/sub2api/environment
```

在文件中添加或修改以下键，使用普通 `KEY=value`，不加 `export`。占位密钥必须换成实际生成的值：

```dotenv
DONEBOT_ENABLED=true
DONEBOT_CLOUD_SIGNING_SEED=替换为一次生成并固定保存的32字节标准Base64密钥
DONEBOT_CLOUD_MASTER_ORIGIN=https://donebot.cn
DONEBOT_CLOUD_BROWSER_ORIGIN=https://cloud.donebot.cn
```

密钥可在私有终端用 `openssl rand -base64 32` 生成，填入环境文件并纳入部署密钥备份；不要复制到 GitHub、截图或共享日志。后续升级、重启保留原 seed，多副本主控使用同一个值。更换 seed 会改变节点验签公钥并使已有网页会话失效，不能作为每次更新的初始化步骤。

节点区提示“主控签名密钥未配置或格式错误”时，检查该环境文件及下述 unit 加载路径，重启后刷新。先找回并修正已有 seed；仅首次安装且尚无 seed 时生成新值。缺少有效 seed 会阻止添加节点和轮换令牌，节点列表、撤销和删除仍可使用。

当前安装脚本生成的 unit 已包含 `EnvironmentFile=-/etc/sub2api/environment`。后台在线更新和 `install.sh upgrade` 都只替换二进制，不会补写旧 unit；曾用旧安装脚本的服务器应补一个持久 drop-in。可先只读检查加载路径：

```sh
sudo systemctl show sub2api -p EnvironmentFiles
```

如果没有 `/etc/sub2api/environment`，创建 `/etc/systemd/system/sub2api.service.d/cloud.conf`：

```sh
sudo install -d -m 0755 /etc/systemd/system/sub2api.service.d
sudoedit /etc/systemd/system/sub2api.service.d/cloud.conf
```

文件内容：

```ini
[Service]
EnvironmentFile=-/etc/sub2api/environment
```

修改 unit/drop-in 后执行 `sudo systemctl daemon-reload`。这种补充方式保留原 unit 的用户、监听端口、目录和在线重启设置，不用重新运行完整安装流程。

**更新端：继续使用现有后台。** 备份数据库后，点击侧栏版本号 → 检查更新 → 立即更新 → 立即重启。正式二进制带 `embed` 前端，替换程序后会同时切换 Cloud 页面；重启时自动依序应用尚未执行的迁移，包括 Cloud 的 260–264、269，不单独上传前端或重复导入 SQL。若另外配置过静态前端覆盖目录或独立前端反向代理，需同步更新该部署，避免继续展示旧页面。

仅修改环境文件而不升级版本时，在维护窗口执行 `sudo systemctl restart sub2api` 使新环境生效。正常在线升级时的“立即重启”同样会重新加载环境；以后不再改变 unit 时无需重复执行 `daemon-reload`。可查看启动结果：

```sh
sudo systemctl is-active sub2api
sudo journalctl -u sub2api -n 100 --no-pager
```

确认后台出现“Cloud 管理”和用户 `/cloud` 页面，保持套餐关闭，继续配置通配域名、私网节点和匹配镜像。后台更新保留主控的环境文件、数据与 systemd 配置；它不会更新 Cloud 节点代码、systemd 模板或 DoneBot/桌面镜像。网关回退仅替换程序，不撤销数据库迁移，按 [回退边界](release-runbook.md) 处理。

## 每台 Linux 节点

需要 Node.js 24.13–24.x、Docker Engine、nftables、e2fsprogs（mkfs.ext4）、util-linux（mount/umount/flock/fallocate）、root 管理的工程目录 `/opt/donebot-cloud`，以及非特权服务账户/组 `donebot-cloud`。已实测 Docker 26.1.5（iptables-nft）/ nftables 1.1.3，以及一次性 GitHub Ubuntu runner 上的 Docker 28.0.4 / nftables 1.0.9。节点代码需包含 nft 常规文件事务和 Docker 能力名称兼容修复；其他防火墙后端需先隔离验证。

```sh
cd /opt/donebot-cloud
npm ci --omit=dev
```

### 镜像准备与离线分发

DoneBot 已有 Dockerfile 和 `.github/workflows/docker.yml`。该 workflow 会构建并发布服务镜像；原版 `cloud-home` 镜像不用于自有 Cloud，当前流程也不发布自有 Cloud 的专属桌面镜像。2026-11-13 首次检查指定源码 `e9d24ff50f10e5772409089386f202e2b1813447` 的 [GitHub 构建](https://github.com/Zluo003/donebot/actions/runs/43370375981) 时，任务被账单/额度阻止启动。用户将 DoneBot 公开后，同一 run 的第 2 次执行已通过 amd64 服务构建/启动、浏览器、配对和网络检查，以及 arm64 构建/启动检查；随后原版 `cloud-home` 的引擎列表断言失败，GHCR 发布被跳过。构建成功与可拉取镜像已经发布是两个不同结果。

自有 Cloud 的双镜像发布入口位于本仓库 Actions → **Cloud service and desktop images** → **Run workflow**。填入审核过的 DoneBot 完整 SHA 和节点平台（当前测试节点为 `linux/amd64`）；流程会复用下述镜像准备工具，先运行真实一次性 Linux 双用户隔离和 Cloud 桌面验证，再发布：

- `ghcr.io/<仓库所有者>/donebot-cloud-service:sha-<DoneBot完整SHA>-<架构>`
- `ghcr.io/<仓库所有者>/donebot-cloud-desktop:sha-<DoneBot完整SHA>-<架构>`

只允许手动触发，不随提交自动升级节点。成功后 Summary 和 artifact 中提供 `registry-images.env`、发布清单及 Linux/桌面验证结果；节点先拉取清单中的两个 `repository@sha256:…`，再将 env 的值合入 `agent.env`。升级已有实例仍需执行下述受控镜像升级，不能直接改配置启动旧容器。该流程不修改 DoneBot 仓库源码，不发布原版 `cloud-home`。

运行这些 Actions 的仓库需有可用计算额度；公开仓库使用标准托管 runner 的构建计算免费，见 [GitHub 计费说明](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)。DoneBot 与本仓库现均已公开，Cloud 可见性变更已获用户明确授权。仓库与 GHCR 包可见性分别配置；公开镜像支持匿名拉取，私有镜像需要登录。2026-11-13 的 [run 43387570590](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/43387570590) 已构建、验证并发布首版 amd64 双镜像。

#### 已发布的 amd64 镜像

当前推荐已按用户要求恢复到 `d128b95` 的既有验证镜像，撤回 DoneBot 专用 Codex／Claude Code 执行器和设置入口；网关分组与密钥保留。本次复核公开注册表摘要及隔离容器，服务仅注册 `donebot`，API 和手机状态接口正常。详见[恢复记录](verification/images-2026-11-17-restore-d128b95-amd64.json)。恢复发布清单不自动替换已有运行实例；保留数据按下述节点维护流程切换镜像。

当前推荐为 2026-11-17 API 专用服务与附件整理更新后的[成功发布](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/44011099571)，新增按 Bot 汇总的产物列表、任务名称显示和预览下载，包含 Bot/群聊之间图片、视频、音频和文档交付，手机附件分段读取和文件版本校验，以及首选／备用模型、失败告知及视频备用确认，并保留此前的手机、附件、群聊及自动化适配。[发布与注册表核验记录](verification/images-2026-11-17-artifacts-amd64.json)保留源码、不可变摘要与真实 Linux 验证结果。历史文件仅供核对，不是本次升级目标。

手机断点续传还需安装包含手机端 `d68d78d` 修复的 App；更新 Cloud 镜像不自动更新手机。该发布包含 HTTP 响应中断防护、Muse 10 秒能力、图片预处理及附件预算整理，桌面共用安装包界面。停留 Cloud 时提前续期、会话结束页返回本地和保存入口续连需安装新版客户端；本次不更改网关的登录期限。Muse 需网关部署对应接口、迁移和模型授权，仅升级镜像不会自动开放模型。意外退出自动恢复需另行更新节点 agent/worker 至 `682308ad059f3d81d4334dd3b96586db7608930e` 或后续版本，不能只换镜像。有效租约下按现有轮询恢复，连续退出使用 5、10、20 秒至 300 秒的有界退避；主动停机、撤销或租约失效不会拉起。Docker 保留 `restart=no`。

DoneBot 源码固定为 `d128b95b79ffc36a978229f0166b297fbab4a9e8`，Cloud 验证代码为 `bcd5425fd05c3e8a7aab57975f9a4a1ce54cb835`。两镜像已通过真实双用户服务、受控出网及专属桌面验证，并核对公开注册表清单和配置；平台为 `linux/amd64`，不要用于 ARM64 节点。

默认入口为 [current-amd64.env](../deploy/images/current-amd64.env)，本次固定清单为 [2026-11-17-artifacts-amd64.env](../deploy/images/2026-11-17-artifacts-amd64.env)。目标值如下，已有节点须在下述维护流程中合入原 `/etc/donebot-cloud/agent.env`，不要先覆盖整份配置：

```dotenv
CLOUD_DONEBOT_IMAGE=ghcr.io/zluo003/donebot-cloud-service@sha256:20b557dc49f6ef68df0d3a3d23d81000d6eec4abdaab5e851e62a3c35d2a0a48
CLOUD_DESKTOP_IMAGE=ghcr.io/zluo003/donebot-cloud-desktop@sha256:4c3df98fb1ececb8c9128d158bea0b8d201699f2f00ad919be6b7486032dfd5d
```

在 amd64 节点直接在线拉取，无需上传离线包或在节点编译 DoneBot：

```sh
sudo docker pull --platform linux/amd64 ghcr.io/zluo003/donebot-cloud-service@sha256:20b557dc49f6ef68df0d3a3d23d81000d6eec4abdaab5e851e62a3c35d2a0a48
sudo docker pull --platform linux/amd64 ghcr.io/zluo003/donebot-cloud-desktop@sha256:4c3df98fb1ececb8c9128d158bea0b8d201699f2f00ad919be6b7486032dfd5d
```

镜像发布、拉取及编辑配置均不会替换已有容器。节点代码应包含上述 Cloud 验证提交及其兼容维护入口，已有实例按本文[节点镜像滚动升级](#节点镜像滚动升级)保留数据升级。资源合计上限仍为 2 核 / 4 GiB、持久存储最大 15 GiB；已有较小磁盘不自动扩容。镜像发布不替代网关程序更新，也不证明生产账户计费或目标节点状态。

#### 始终读取当前推荐清单

部署使用固定入口 [registry-images.env](https://github.com/Zluo003/DoneBot-Cloud/releases/download/cloud-images-amd64-current/registry-images.env)，取得同一次成功发布的服务与桌面不可变摘要；不要从历史文档或 GHCR 包列表猜测最新版本。本次清单已发布。

```sh
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/Zluo003/DoneBot-Cloud/releases/download/cloud-images-amd64-current/registry-images.env \
  --output /tmp/donebot-current-amd64.env
cat /tmp/donebot-current-amd64.env
```

检查文件只有两个符合预期 GHCR 仓库的 `repository@sha256:` 值，将其作为本次维护目标；不要直接执行下载内容或覆盖完整 `agent.env`。清单更新不会自动替换已有容器，仍按受控升级流程执行。

Cloud 工作流已启用同平台串行发布，并在真实 Linux 验证与镜像推送成功后刷新该入口；本次已成功更新。发布失败不更新当前清单。

旧镜像不在每次发布后立即删除。确认所有节点中运行、停止实例和保留的回滚版本都不再引用某摘要后，才清理对应注册表版本及节点缓存。只删除标签不能阻止按旧摘要拉取；删掉仍被引用的摘要则会妨碍重建和回滚。不要执行不区分归属的批量镜像清理。日常部署仅认当前清单，历史清单继续用于审计。

#### 自行构建与离线包

在任意构建机准备一次两个镜像，再分发到同架构节点，不必每台节点安装 DoneBot 源码和编译环境。构建机需要 Node.js 24.13–24.x、Git、tar、Docker，以及已安装依赖的干净 DoneBot checkout（首次在该 checkout 执行 `pnpm install --frozen-lockfile`）。`REVIEWED_DONEBOT_SHA` 必须是管理员核对过的完整 40 位提交，`--platform` 与节点架构一致。下面示例用于 amd64：

```sh
npm run images:prepare -- \
  --source /path/to/DoneBot \
  --revision "$REVIEWED_DONEBOT_SHA" \
  --platform linux/amd64 \
  --context default \
  --output /srv/donebot-images-UNIQUE
```

输出目录必须尚不存在且位于源码仓库外，父目录需存在。可先加 `--dry-run` 核对来源；该模式不调用 Docker。ARM64 节点使用 `--platform linux/arm64`；跨架构构建需要构建机已配置相应的 BuildKit 模拟支持。工具从指定 Git 提交导出源码快照，不把工作目录、`.env` 或用户数据送入构建上下文；桌面生成器在临时 HOME 中运行。构建使用 DoneBot 的 API 专用 `cloud-service` target 和默认构建参数，不注入 fixture 引擎或另复制服务。两个镜像的源码标签、实际 image ID 和平台核对成功后，才生成完成清单。

输出包含 `manifest.json`、`agent-images.env`、`desktop/Dockerfile`、`images.tar` 和 `checksums.txt`。将整个目录安全复制到节点，在节点执行：

```sh
cd /path/to/copied-bundle
sha256sum -c checksums.txt
docker load --input images.tar
cat agent-images.env
```

把 `agent-images.env` 的两个值合入下述 root 管理的 `agent.env`。它们是本地不可变 image ID，不是 registry digest；离线包在目标节点加载后可直接使用。保留清单和可信渠道取得的校验和，不能把本地 ID 拼成 `repository@sha256:…`。只在当前构建机使用时可加 `--no-archive`；这时不生成 tar/校验和。工具保留构建产物，不部署、启动、清理旧镜像或覆盖既有配置；已有实例更换镜像仍按下述受控升级流程操作。

也可以沿用注册表方式。镜像复用 DoneBot 的 `cloud-service` target，从验证过的源码构建/发布后按不可变摘要配置。不要使用 `cloud-home` target，也不要使用可变 `latest`：

```sh
docker build --target cloud-service -t your-registry/donebot:reviewed /path/to/DoneBot
```

发布并取得实际摘要后，将 `repository@sha256:实际摘要` 填入 agent 配置。该步骤没有在本轮执行，文档不提供虚构摘要。

专属桌面复用 DoneBot 原版镜像生成函数，在构建机导出 Dockerfile；相邻 DoneBot 依赖需可用：

```sh
desktop_build_dir=$(mktemp -d /tmp/donebot-desktop-build.XXXXXX)
node scripts/desktop-dockerfile.mjs /path/to/DoneBot "$desktop_build_dir/Dockerfile"
docker build -t your-registry/donebot-desktop:reviewed "$desktop_build_dir"
```

发布并核对桌面镜像摘要后，配置 `CLOUD_DESKTOP_IMAGE=repository@sha256:实际摘要`。当前适配要求 DoneBot 原版桌面 labels 对应 CUA 0.37.0、image-layer 8 及固定基础摘要。节点不会根据用户输入拉取镜像；部署前由管理员加载或拉取已审核镜像。生产 agent 必须配置桌面镜像，readiness 同时检查桌面镜像。本地 image ID 与注册表摘要用途不同，不得混用。

agent 环境文件 `/etc/donebot-cloud/agent.env`（root 可读）：

```dotenv
CLOUD_AGENT_STATE_DIR=/var/lib/donebot-cloud-agent
CLOUD_AGENT_SOCKET=/run/donebot-cloud-agent/agent.sock
CLOUD_DOCKER_BINARY=/usr/bin/docker
CLOUD_PUBLIC_ORIGIN=https://donebot.cn
CLOUD_EGRESS_MODE=public-web
CLOUD_NFT_BINARY=/usr/sbin/nft
CLOUD_EGRESS_DNS=1.1.1.1,9.9.9.9
CLOUD_STORAGE_BYTES=5368709120
CLOUD_BACKUP_INTERVAL_HOURS=0
CLOUD_DESKTOP_STORAGE_BYTES=10737418240
CLOUD_DESKTOP_IDLE_MINUTES=30
```

另填 `CLOUD_DONEBOT_IMAGE`、`CLOUD_DESKTOP_IMAGE` 和 `CLOUD_AGENT_SOCKET_GID`（`donebot-cloud` 组的实际数字 GID）。agent 以 root 执行 Docker 和创建 UID 1001 的 IPC 目录；只监听本机 Unix socket，不开放远程生命周期入口。state 目录保持 0700；socket 父目录 root:donebot-cloud 0750，socket 0660。worker 不加入 docker 组。

`public-web` 只支持本机 Linux Docker；防火墙不能加载则拒绝启动。省略该变量时保持 `network=none`，用于完全禁网的验证或部署。管理员可用 `CLOUD_EGRESS_DENY_IPV4` 填逗号分隔的额外 IPv4/CIDR，阻断其他基础设施公网地址；DNS 也必须是未被阻断的公网 IPv4。既有资源的网络模式和 DNS 配置不可直接切换；下述升级命令只处理镜像变更，不负责网络配置迁移。

生产强制独立 ext4 容量，普通旧卷不自动迁移，详情见 [存储与备份](storage-backups.md)。新实例默认运行盘 5 GiB、桌面资料盘 10 GiB，两项配置总和硬性不得超过每用户 15 GiB。已有较小磁盘继续使用持久记录的实际容量，增加默认值不会扩容、重建或格式化旧盘；降低配置小于旧盘大小则拒绝启动，不删除数据。桌面启用后保持节点配置一致，不能通过删除桌面配置接管既有资源。每个活跃账户的服务加桌面总限制为 2 CPU、4 GiB 内存；桌面按需启动。capacity 应按这个组合和磁盘/网络数量规划，不能只按服务容器计算。自动备份默认禁用；启用前规划磁盘容量和短暂停机窗口。备份最多保留 3 份，轮换也会删除较旧手动备份，本地备份不属于异地灾备。保全完整 agent 状态及密钥才能恢复。

root agent 的挂载必须与 Docker daemon 位于同一宿主 mount namespace；模板显式 `PrivateMounts=false`，不加 `ProtectSystem`、`ProtectHome`、`PrivateTmp` 等会隐式建立 mount namespace 的选项。root agent 是受信宿主执行边界。`agent.lock` 使用内核 flock，使 agent 和维护命令互斥；停止后才释放锁。

agent 只管理以 deployment UUID 命名并校验属主的 nft 表，原子更新，不清空系统规则。规则在 agent 退出时保留，容器 `restart=no`，宿主机重启后由新租约和 agent 安装规则再启动。节点的防火墙管理器须保留这些表，不能在运行期间全局清空 nft ruleset；宿主机管理员仍是受信边界。Docker 默认地址池支持的独立 bridge 数量有限，部署前按实际 VPN/基础设施网络规划不重叠的私有地址池和较小子网，网络不足会使开通失败，不会自动共享租户网络。详见 [网络边界](network-isolation.md)。

worker 环境文件 `/etc/donebot-cloud/worker.env`（root:donebot-cloud 0640）：

```dotenv
CLOUD_MASTER_ORIGIN=https://donebot.cn
CLOUD_WORKER_STATE_DIR=/var/lib/donebot-cloud-worker
CLOUD_AGENT_SOCKET=/run/donebot-cloud-agent/agent.sock
CLOUD_WORKER_HOST=127.0.0.1
CLOUD_WORKER_PORT=18991
```

另填后台登记的 `CLOUD_NODE_ID`、`CLOUD_NODE_TOKEN`、`CLOUD_MASTER_PUBLIC_KEY`。所有节点用不同 token，仅主控公钥相同。生产不设置 `CLOUD_MODE=development` 或 `DONEBOT_CLOUD_TEST_LOOPBACK_NODES`。生产 worker 不需要 `DONEBOT_CLOUD_SERVICE_TOKEN`；该全局令牌只供旧本地 BFF fixture 协议使用。

参考 `deploy/donebot-cloud-agent.service` 和 `deploy/donebot-cloud-worker.service`。安装前核对 Node 绝对路径、目录属主、GID 和实际镜像摘要。不要让用户或 worker 修改 agent 运行代码及配置。节点 TLS 代理转发到回环 18991，保留请求路径和 WebSocket；不把 agent socket 映射为公网服务。

同步安装 `donebot-cloud-health.service/.timer`，每 30 秒执行只读 readiness，失败退出非零并进入 journal。默认检查回环 18991；可在 `/etc/donebot-cloud/health.env` 指定 `CLOUD_HEALTH_ORIGIN=http://127.0.0.1:实际端口`。worker 要求最近 30 秒主控联系成功且 agent/Docker/磁盘就绪；不暴露令牌。外部监控可读取该状态或失败 unit，目前没有接入邮件/消息告警平台。

### 网关和 Cloud 节点同机

支持同机部署，但 `public-web` 默认拒绝容器访问宿主机的所有地址；仅打开公网 443 并不能绕过这层隔离。若 `donebot.cn` 解析到本机公网 IPv4，原有规则会同时阻止模型目录、账号并发及模型请求；安装凭据仍可显示邮箱，因此页面可能表现为“已登录但没有模型”。

在 `agent.env` 显式配置已经核对的网关公网 IPv4（最多 8 个，逗号分隔），再更新节点代码和重启服务：

```dotenv
CLOUD_EGRESS_MODE=public-web
CLOUD_GATEWAY_IPV4=<已确认的网关公网IPv4>
```

仅 DoneBot 服务容器可访问这些宿主 IPv4 的 TCP 443，并允许相应已建立连接的回复；桌面容器不继承此例外。其他宿主地址、端口、私网、元数据和跨租户连接继续拒绝。配置不接受域名、CIDR、私网或保留地址，不跟随 DNS 自动扩大授权；额外拒绝范围优先，冲突时拒绝配置。此处控制的是 IP 和端口，允许访问该 IP 的整个 HTTPS 入口，不解析 SNI/Host/路径；HTTPS 入口内的业务仍依赖各自鉴权。宿主机现有防火墙仍可继续拒绝连接。

在维护窗口先停止 worker，再停止 agent，并确认定向停机成功。更新 **systemd 实际使用的** Cloud 工程目录，保全原状态目录/密钥/卷，修改同一 `agent.env` 后先启动 agent，再启动 worker。该修复只改变受信节点规则，不需要替换 DoneBot 或桌面镜像，也不需要删除、重新购买实例或重新注册；现有 `public-web` 网络和数据卷继续复用。不要通过关闭 nftables 或使用 host 网络解决。

只读诊断（使用后台给出的本用户实例 UUID）：

```sh
sudo node --env-file=/etc/donebot-cloud/agent.env /实际Cloud工程目录/scripts/diagnose-models.mjs --instance INSTANCE_UUID
```

命令核对部署和实例标签，只对指定容器执行 DNS 检查及网关 GET；不启停、创建或删除资源，不提交模型任务，不扣款。凭据只在容器内读取并使用，输出仅含网络模式、DNS 数量、HTTP 状态、允许的错误码/request ID、模型数量和并发字段是否有效，不输出凭据、完整响应、邮箱或余额。`anonymous_models.status=401` 表示网关可达且匿名访问被拒绝；`models/account.status=200` 才证明安装凭据对应的读取成功。它不证明真实模型生成或计费成功。

## 调度、断网与回收

- 默认每 3 秒心跳，运行租约默认 30 分钟，在“Cloud 管理 → 运行策略”可设 1–60 分钟；已知付费截止时间始终是更早的上限。命令租约仍为 90 秒，节点在线和代理新访问仍按 30 秒心跳判断。
- 网络断开、超时、5xx 或无效续租响应不会删除已有有效运行授权，也不在本地续期。主控恢复后成功续租不会重新启动已运行实例。收到主控 401/403、成功响应不再包含该实例授权或明确停机命令时，worker 会撤销本地授权并停机；agent 独立看门狗保留到期停机保护。worker 和 agent 同时检查单调时钟，系统时钟回拨不会延长已有租约。
- 失联窗口是最后一次成功续租的剩余时间，不是故障被发现后重新计时的 30 分钟。失联期间主控的新撤销最迟在原租约结束后生效；调整策略也需下一次成功续租才能生效。窗口内只保持已授权的运行资源，主控不可达时不能新开通或绕过网关访问、鉴权、计费。访问先拒绝，实际 Docker 停机仍受正在执行命令及 Docker 超时影响，不承诺到期毫秒即终止所有进程。
- 主控、worker、agent 必须一起更新：旧 worker 仍把租约截为 20 秒，旧 agent 会拒绝长租约。先在维护窗口停 worker，更新并重启 agent，再更新 worker，最后发布主控；旧主控的短租约可被新节点接受。重启会按已有生命周期停止并重新授权实例，需安排维护窗口。此变更不要求更新 DoneBot 运行或图形桌面镜像。
- 节点登记 token 没有定时过期；管理员轮换、撤销或删除登记使其失效。运行租约、命令租约、节点 token、访问签名和用户会话是不同机制。主控签名 seed 应保持原值，不因发布而重新生成。
- 不能把节点失联视为节点已停机：最长运行窗口仍可能有效。在未来引入自动故障切换前，必须先有旧节点隔离和存储恢复能力，避免双端同时运行。
- 主控以有界 sweep 执行续费、到期停止及保留期删除，按最近核对时间轮转处理；节点心跳驱动 sweep，没有另设外部 cron。节点全部离线时任务保留，恢复心跳后继续；离线主机无法被远程物理删除。
- 节点 capacity 包括停机和待删除的专属实例。后台暂停分配只阻止新分配，既有实例仍可运行。实例绑定原节点，不做离线自动迁移。
- 删除前需领取当前代次命令并确认保留期；确认后锁定续费，避免删数据同时扣款。删除失败保持 error，15 秒后可重试，成功才释放名额并允许重新开通。
- worker 重启先停止其本地 manifest 记录的实例，取得新租约后恢复。agent 启动先检查并停止本部署已有容器；正常退出停止已知实例，systemd ExecStopPost 再执行定向 fence，覆盖强制终止。agent 会拒绝接管不同部署标签的资源；其状态目录、deployment ID、加密 key 和 Docker 资源不能任意重建或互换。
- 异常重启可清理由当前 UID 拥有、确认无监听者且 inode 未变化的旧 agent socket；不会停止其他进程。worker/agent 应交给服务管理器监督，当前无宿主机级独立硬件看门狗。

### 运行服务意外退出后的自动恢复

worker 每次成功续租时通过 agent 检查容器实际运行状态，避免只根据内存中的“已启动”记录判断。有效运行租约下，首次意外退出在下一轮检查发现后尝试恢复；默认轮询间隔 3 秒，实际恢复还需主控请求及容器启动时间。连续运行不足 60 秒又退出时，重试等待依次为 5、10、20、40、80、160、300 秒，之后最多每 300 秒尝试一次；启动本身失败沿用 15 秒起、上限 300 秒的退避。健康运行满 60 秒或授权代次改变后清除连续崩溃计数。

恢复复用已有容器、数据盘、网络、资源规格及安装身份，不迁移任务、不重放中断的消息或工具操作。备份/恢复等 agent 串行维护中的停机不计为崩溃。主动停机、授权撤销及租约失效后不自动拉起。主控不可达时不领取新启动凭据，恢复需等主控通信成功且授权有效。

Docker 仍保持 `restart=no`，避免 Docker daemon 重启时绕过租约直接启动。节点 agent/worker 自身沿用 systemd `Restart=on-failure`、`RestartSec=3`；这是节点进程恢复，与用户运行容器的恢复分开。日志 `instance_exited` 包含尝试次数及 `restart_in_ms`，后续以 `instance_started` 或 `instance_start_failed` 核对结果。

启用此修复需更新节点 agent/worker 源码。在维护窗口先停止 worker、agent，按现有部署方式更新代码并保留完整状态目录及配置，再依次启动 agent、worker。节点生命周期会短暂停止实例，随后按有效租约恢复。单独部署网关或更换用户运行镜像不会安装这段节点恢复逻辑。

本次 HTTP 崩溃防护还需要发布并升级 DoneBot 服务镜像；在 GitHub 发布新摘要后，沿用下文保留数据的镜像升级步骤。桌面连接自动续连需要新版桌面客户端；静态资源私有缓存需要新版网关。图形桌面镜像、手机 App 和手机中继不因本次修复而必须更新。

验证仅在一次性 fixture 上停止明确属于测试的运行服务；禁止通过杀死生产用户容器验收恢复机制。查看只读日志、实际容器状态和健康接口可核对生产恢复，不用反复手动启动替代自动恢复。

### 删除服务器登记

在后台节点表选择“删除服务器”，核对节点名称后确认。仅允许删除已分配数为 0 的节点；停机、待删除和回收失败的实例均占用节点，须先按实例生命周期完成回收。后端与新分配使用同一节点锁，页面显示为空后发生的新分配也会阻止删除。

删除后节点从列表移除，令牌立即失效，不再接受心跳或分配。历史实例关联和扣退费流水保留；重复删除安全。同一地址可重新登记，但必须使用新节点 ID 和新令牌。此操作仅删除主控登记，不会连接主机卸载程序；确认没有实例后，在对应服务器自行停止并卸载本次部署的 worker、health timer 和 agent。离线且仍有实例的节点不能通过删除登记绕过数据回收。

## 接口索引

统一返回网关现有 `{code,data}` 结构；用户变更要求 `Idempotency-Key`，正文为空对象，身份来自 JWT 中间件。

| 使用者 | 路径（相对 `/api/v1`） |
| --- | --- |
| 用户 | `GET /donebot/cloud/plan` |
| 用户 | `GET/POST /donebot/cloud/instances` |
| 用户 | `POST /donebot/cloud/instances/:id/start|stop|cancel|keep` |
| 用户 | `GET /donebot/cloud/instances/:id/operations` |
| 用户 | `ANY /donebot/cloud/instances/:id/proxy/*path`，含 WS |
| 用户 | `POST /donebot/cloud/instances/:id/browser-launch|desktop-launch` |
| 用户 | `DELETE /donebot/cloud/browser-sessions` |
| 节点 | `POST /donebot/cloud/nodes/:node/claim|report|confirm-purge|runtime-credential` |
| 现有管理后台 | `GET/PUT /admin/donebot/cloud/plan` |
| 现有管理后台 | `GET/POST /admin/donebot/cloud/nodes`、`PUT .../nodes/:node` |
| 现有管理后台 | `DELETE /admin/donebot/cloud/nodes/:node`，仅空节点 |
| 现有管理后台 | `POST /admin/donebot/cloud/nodes/:node/credential`，正文 `{revoke:boolean}` |
| 现有管理后台 | `GET /admin/donebot/cloud/instances`、`GET .../events` |

管理变更使用既有管理员鉴权及 step-up。实例接口的 `cancel` 仅将 `auto_renew` 设为 false，`keep` 仅在已付费期限内恢复自动续费；两者不派发节点命令、不改变付费截止时间、不立即扣款。`stop` 保留为兼容接口，用户界面不再提供停机按钮。到期未续费才关闭访问并停机，自动删除根据订阅 paid_until 加后台保留天数计算。没有向用户开放任意镜像、挂载、Docker 参数、shell 或节点执行入口。

续费修复需发布网关后端及前端（含迁移 269），并重新打包客户端；节点生产协议不变，无须为本修复更换运行服务或桌面镜像。迁移只为未退款、未进入删除且仍在付费期的旧版取消实例恢复运行意图，保留自动续费关闭状态；旧代次命令失效后由现有 Sweep 恢复启动，不增加扣款。已退款订阅不恢复，历史重复购买费用不在迁移中自动调整。

## 节点镜像滚动升级

### 先核对实际容器

以本页“已发布的 amd64 镜像”及 `current-amd64.env` 为目标，不要把历史清单与当前配置相同误判为升级完成。

| 核对项 | 旧发布 | 本次发布 |
| --- | --- | --- |
| 服务摘要开头 | `96c47490724e` | `66df94f6261f` |
| 同次桌面摘要开头 | `24e9bf636803` | `36899535b6eb` |
| DoneBot 源码 revision | `cf396bc` | `cf7f37a` |

先根据实例 UUID、agent 的 deployment ID 和 `cn.donebot.cloud.*` 标签确认本节点的运行及桌面容器。对明确归属的运行容器执行只读检查，将 `SERVICE_CONTAINER_NAME` 换成其完整名称：

```sh
sudo docker container inspect SERVICE_CONTAINER_NAME --format 'image={{.Config.Image}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
```

逐实例记录实际旧的运行与桌面 `Config.Image`，作为维护命令的旧摘要参数；不要只记录可能已提前改过的 `agent.env`。实际运行服务仍为 `dcdf3074…`、源码仍为 `9455c9f` 时，它尚未升级。若运行容器及已存在的桌面容器都已匹配目标，不重复重建，继续核对健康与手机连接。

### 执行运行镜像升级

本次维护会短暂中断该节点已有 Cloud。先在后台暂停新分配，按现有备份流程保全实例数据及完整 agent 状态；用上面的在线命令提前拉取新镜像，核对平台和源码标签。

使用与现有容器匹配的旧配置依次停止 worker、agent。若此前已提前改成新镜像值，应先恢复匹配的旧配置，保证停止与规格检查能够完成。服务名和工程路径按实际安装调整：

```sh
sudo systemctl stop donebot-cloud-worker
sudo systemctl stop donebot-cloud-agent
```

必须确认 agent 的 ExecStopPost 成功，所有本节点运行服务与桌面容器已停止。不要删除卷、deployment ID 或密钥，也不要把关闭新分配当作已有实例已停止。

停止成功后再更新受信节点代码，将本次两个目标镜像值合入原 `agent.env`，保留其余配置、权限和凭据。以 root 加载同一环境文件，针对后台列出的每个已有实例执行；`PREVIOUS_SERVICE_IMAGE` 和 `PREVIOUS_DESKTOP_IMAGE` 使用该实例刚记录的实际旧值：

```sh
sudo /usr/bin/node --env-file=/etc/donebot-cloud/agent.env /opt/donebot-cloud/src/maintenance.mjs prepare-upgrade INSTANCE_UUID PREVIOUS_SERVICE_IMAGE
sudo /usr/bin/node --env-file=/etc/donebot-cloud/agent.env /opt/donebot-cloud/src/maintenance.mjs prepare-desktop-upgrade INSTANCE_UUID PREVIOUS_DESKTOP_IMAGE
```

第二条用于桌面镜像也变更的实例。命令要求 agent 未监听且独占状态锁；完整核对归属、旧镜像与规格，只移除已停止容器，保留卷、磁盘、网络和安装凭据。重复执行安全，不主动启动实例。升级准备失败时保持维护状态并检查错误，不用 `docker rm -f` 绕过校验。

所有实例准备成功后恢复 agent、worker：

```sh
sudo systemctl start donebot-cloud-agent
sudo systemctl start donebot-cloud-worker
```

运行服务只依据主控有效租约恢复，桌面在下次打开时按需创建。每个恢复的运行容器都须重新核对 `Config.Image` 为目标服务摘要、完整源码 revision 为 `cf7f37aecbb859016385180b3c160e17fe2da393`；桌面创建后同样核对目标桌面摘要。确认原有 Bot、消息和资料保留，并完成下述手机检查后，再恢复新分配并继续下一节点。

### 手机中的 Cloud 显示离线

手机在线状态来自 Cloud 向手机中枢上报的中继连接心跳，不等同于管理后台实例“运行中”。运行服务为旧 `9455c9f` 时没有手机连接器；新镜像已通过真实 Linux 运行及桌面验证；此前 `75704dd` 镜像的独立无网络手机状态探测返回 200，不能用历史探测代替本次生产验收。

在明确归属的运行容器内执行两次只读请求，间隔 10 秒，不通过公网代理：

```sh
sudo docker exec SERVICE_CONTAINER_NAME curl --fail --silent --show-error http://127.0.0.1:18899/api/health
sudo docker exec SERVICE_CONTAINER_NAME curl --fail --silent --show-error http://127.0.0.1:18899/api/donebot/mobile/status
```

验收条件为健康成功、手机状态 HTTP 200、`authenticated=true`、`registered=true`、`relay=connected`，且 `lastHeartbeat` 持续更新。手机刷新后可打开原有 Cloud Bot 和消息。两台主机都接通同一个中继时，本地电脑和 Cloud 各计一台主机；手机会话数按实际连接计算。

| 状态 | 下一步 |
| --- | --- |
| HTTP 404，`no route` | 核对实际容器、镜像摘要及源码，不能仅凭配置宣称已升级 |
| `authenticated=false` | 检查安装凭据加载，不输出凭据文件 |
| `problem=login` | 检查安装是否被撤销或归属失效 |
| `problem=unavailable` | 检查网关版本、手机中枢签名设置及可用节点 |
| `problem=network` | 检查 DNS、TLS 与出网 |
| `registered=true`、`relay=connecting` | 已向中枢登记，继续检查中继 WSS |
| `registered=true`、`relay=connected`，手机仍离线 | 核对实例与安装 ID、网关对应主机心跳及手机所选工作空间 |

Cloud 需要到 `donebot.cn:443` 以及下发中继节点 `:443` 的 HTTPS/WSS 出站访问，不向手机开放 18080。网关或中继与 Cloud 节点同机时，公网地址也受宿主拒绝规则约束，按“网关和 Cloud 节点同机”配置显式公网 HTTPS 例外。`CLOUD_EGRESS_MODE=none` 不能用于远程连接。排查不输出 Env、Token 或完整凭据。

旧/新数据 schema 的兼容及回滚须事先验证；维护工具不回滚数据，切回旧镜像不保证恢复。不要删除实例或重新开通付费套餐来处理离线。

## 尚未验收的运行边界

CPU 1 核、内存/交换总限额 2 GiB、PID 256、共享内存 512 MiB 和默认磁盘 5 GiB 是配置，不是目标机器承载量实测。独立桌面适配已获明确授权并通过两用户 Linux 验证；外部告警投递、异地灾备、生产 DNS/TLS、打包客户端 GUI 和真实模型计费仍需完成。Linux 浏览器、存储、备份、故障恢复、systemd 及 VM 重启的隔离检查已通过，证据不等于完整安全审计。


## 桌面镜像更新

先通过主控停止相关实例，停止节点 worker 和 agent，备份完整 agent 状态。更新受信代码和已加载的新桌面镜像摘要后，在相同配置下执行：

```sh
sudo /usr/bin/node --env-file=/etc/donebot-cloud/agent.env /opt/donebot-cloud/src/maintenance.mjs prepare-desktop-upgrade INSTANCE_UUID PREVIOUS_DESKTOP_IMAGE
```

命令要求运行服务和桌面均停止，只移除通过旧摘要及完整规格校验的桌面容器，保留资料盘、备份和网络。若同时更新运行镜像，先按前述 `prepare-upgrade` 准备运行容器，再准备桌面容器；重启 agent/worker 后由主控租约启动，桌面在下次使用时创建。不自动回滚数据 schema，不允许直接换摘要后覆盖旧资源。

节点 TLS 反向代理的备份请求等待时间应至少 310 秒，主控针对备份的响应头等待为 300 秒。长备份期间仍需维持 worker 心跳与短期租约；超时后用同一请求键核对和重试，不以新键重复创建备份。


## API 专用 Cloud 运行镜像（已发布）

新版桌面客户端从安装包读取聊天 HTML、JS、CSS 和字体，Cloud 只提供账号校验、Bot/会话 API、SSE、WebSocket 和附件。桌面仍使用各实例独立 HTTPS origin 和原生 Cookie；不代理或复制网关主站凭据，不改写 API 路径。手机继续使用原有加密 API 通道。Cloud 容器不再包含 `/app/dist`，`GET /` 返回 404 是预期行为；用 `/api/health`、`/api/donebot/mobile/status` 检查服务。网关 `/cloud` 控制台与 Bot 使用的浏览器、专属图形桌面仍保留。

升级顺序为先安装 DoneBot 0.1.153 或后续兼容桌面客户端，再部署已发布的 `cloud-service` 服务镜像。旧桌面依赖云端静态页面，不能先切成 API 专用镜像。不要向已有 `server` 镜像仅删除目录来模拟升级。本次新摘要包含 Muse 的 4–10 秒能力登记（默认 6 秒）、PNG/JPEG 预处理和附件预算整理；11 月 15 日及更早的历史摘要不包含本次改动。

当前推荐的服务和配套桌面镜像均从 DoneBot `837b7f3db66e9263aeb5a5212729d179daae5878` 构建，Cloud 构建和验证提交为 `62be34b49165daa4b90196e20caefc5072969bc6`。包含已交付附件直接汇报和再次附加时复用原文件的修复。两者均已匿名核对注册表摘要、linux/amd64 平台和 revision，详见[发布证据](verification/images-2026-11-17-attachments-amd64.json)。沿用既有保留数据的受控实例升级流程；此次仅发布镜像，没有升级生产实例。此前的[手机续传镜像记录](verification/images-2026-11-17-resume-amd64.json)保留供回退。不得改写历史发布记录或使用未经发布验证的本地测试 image ID。API 拆分主要减少镜像、构建和静态资源传输；前端原本就在客户端渲染，不能宣称因此释放相同数量的服务端 CPU/内存。
