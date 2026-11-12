# 受控网络出口

`CLOUD_EGRESS_MODE=public-web` 为每个实例创建独立 Docker bridge，不发布端口；Cloud 仍通过专属 Unix socket 访问原生 DoneBot。默认 `none` 不创建网络，不出网。此实现未改动 DoneBot 运行服务，也不要求浏览器、shell 或子进程遵守代理环境变量。

## 允许与拒绝

| 流量 | 行为 |
| --- | --- |
| 公网 IPv4 TCP 80 / 443 | 允许 HTTP / HTTPS，包括模型网关、WebSocket、下载和浏览器 TCP 请求 |
| 指定公网 DNS 的 UDP / TCP 53 | 允许，默认 `1.1.1.1`、`9.9.9.9`；Docker 内置 DNS 使用这些上游 |
| 用户自身容器的回环地址 | 保留原生运行服务和浏览器内部通信 |
| 其他租户、宿主机所有地址、私网、共享地址、链路本地、保留地址 | 拒绝，公网 Host 头或 DNS 返回私网 IP 不能绕过 |
| 常见云元数据与 Azure 平台虚拟地址 | 拒绝，包括 `169.254.169.254`、`100.100.100.200`、`168.63.129.16` |
| IPv6（含 NAT64 / 6to4）及其他 TCP / UDP 端口 | 拒绝；IPv4 映射地址仍走 IPv4 拒绝规则，QUIC 不可用 |
| 外部或宿主机主动连接实例网络 | 拒绝；只允许已建立连接的回复及相关错误，宿主机 agent 用 Unix socket |

公网 HTTPS 的路径和内容由原服务鉴权。网络规则不解析 TLS，不提供模型选择、余额扣款或替代网关 API 权限检查。允许的是公网 Web 传输，不是域名白名单；同一主控域名的模型和用户 API 均可到达，容器没有主控、节点或管理员密钥。额外基础设施公网地址可由管理员配置 `CLOUD_EGRESS_DENY_IPV4` 阻断。

## 执行与恢复

1. bridge 名由部署 UUID 和实例 UUID 派生，不接收用户网络参数。先在 agent 私有 SQLite 记录实例，再安装 nft 拒绝规则，之后才创建 Docker 网络和容器。
2. nft `inet` 表独属于部署，规则按 bridge 接口匹配。input 阻断租户到宿主机；output 阻断宿主机主动到租户；forward 在优先级 `-10` 检查地址和端口，先于已实测 Docker iptables 过滤链。现有 Docker NAT 和系统规则保持原有管理方式。
3. 每次更新在一次 nft 事务中替换完整规则集，失败保留旧规则。持久化列表包含本部署所有桥，新增/删除一个实例不解除另一个实例的限制。相同表名但属主注释不匹配时拒绝修改。
4. 停机保留网络和数据，重启复用并核对标签、bridge 参数、IPv4 私网子网、容器连接和 DNS。agent 重建后重新安装完整规则集。规则在进程退出后保留；容器不配置自动重启。
5. 删除先停止/移除容器，再移除其专属网络，成功后才从规则集中释放接口；失败保留错误和恢复状态。最后一个专属网络移除后才删除本部署 nft 表。

本边界依赖受信宿主机内核、Docker 和管理员维护 nft 表。管理员清空规则或改变容器网络可改变边界；容器共享宿主机内核。专属 Linux VM 停启后的数据恢复及原生浏览器已另行验证，见 [运行记录](verification/runtime-2026-11-12.json)；尚未覆盖突然掉电、所有发行版/防火墙后端或真实模型计费。

## 隔离验证

在一次性 Linux 中执行，不在承载真实用户的节点运行：

```sh
sudo env CLOUD_DISPOSABLE_LINUX=1 CLOUD_DONEBOT_IMAGE="$REVIEWED_DONEBOT_IMAGE_DIGEST" npm run verify:egress
```

脚本创建两个真实 DoneBot 容器、一个测试专属 network namespace、veth、目标服务及精确路由。测试使用的公网形态地址仅在 VM 内分配并路由到合成服务，不向这些地址的实际归属方发请求；私网/元数据目标也由该测试服务提供。先从受信侧验证目标存活，再从租户验证拒绝，同时验证公网 `example.com` HTTPS、DNS 和无凭据网关 `/auth/me` 返回 401。没有调用模型或余额变更 API。

验证覆盖独立网络、跨租户、宿主机私网/公网、元数据、额外公网拒绝列表、IPv4 映射、DNS 重绑定、IPv6、非允许 TCP / UDP、外部主动连接、防火墙缺失时禁止创建、不同表属主不覆盖、失败原子更新、agent 对象重建及定向网络删除。测试结束仅清理本次精确创建的资源，详见 [验证记录](verification.md)。

实现依据 [Docker bridge 选项](https://docs.docker.com/engine/network/drivers/bridge/) 和 [Docker 防火墙说明](https://docs.docker.com/engine/network/packet-filtering-firewalls/)。当前实测环境为 Debian 13 ARM64、Docker 26.1.5（iptables-nft）、nftables 1.1.3。
