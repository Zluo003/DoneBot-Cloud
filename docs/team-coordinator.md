# 团队协调器配置

团队能力继续默认关闭，本文只记录协调器凭据传输；模型派发、计费及真实 Linux 隔离尚未整体验收。

启用团队的 worker 从网关 runtime-configuration 领取 team 和 coordinator。协调器绑定团队、实例、运行代次，其 generation 必须匹配当前运行租约；缺失、错误身份、旧代次和个人/团队混合配置均拒绝启动。worker 不将该凭据转发到成员代理，不记录原始响应。

agent 先固定公开团队规格，再校验协调器。公开规格不能改变团队或已购买资源；协调器可随新代次更新，旧代次不能覆盖新值。metadata 中使用现有 vault 加密，purge 删除对应记录。启动时原子写入 `/run/donebot/team-coordinator.json`，0600、运行 UID 1001，环境仅传固定文件路径；个人 gateway.json 沿用原流程。该文件不在 `/data` 或备份卷内。

凭据只允许可信运行服务在核实规范会话、实际成员、Bot、目标节点和受众后申请短期执行授权。成员和 Bot 不得获得协调器凭据。bot-box 的私有 `/run`、进程隔离和凭据代理必须先通过真实 Linux 自检；不得以环境过滤或文件权限声称已经完成跨成员隔离。

2026-11-21：`node --test --test-concurrency=1 test/*.test.mjs` 共 51 项通过，日志 `/tmp/donebot-team-coordinator-accepted-cloud.log`。覆盖加密、代次、个人空间保护、错误配置拒绝及合成控制面到 Unix socket 运行服务的 HTTP/WebSocket 流。此测试没有启动真实 Docker 容器，不是镜像隔离验收。

与 donebot-api 迁移 274 和兼容 runtime-configuration 一起部署，团队执行能力完成最终验收前保持关闭。回退先关闭团队，再切回兼容 worker；保留团队数据和执行归属记录。网关由用户推送与部署。
