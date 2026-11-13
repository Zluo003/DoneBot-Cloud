# 实例启动：运行凭据 404

2026-11-13 的部署报告显示 start 返回 202、claim/report 返回 200，而节点请求 `runtime-credential` 返回 404。随后取得的业务响应为 `reason=API_KEY_NOT_FOUND`、`message=api key not found`。这证明该响应来自业务处理，不能再仅按“路由未部署”判断。部署记录的 Cloud `c90bb04` 已在本地解析为完整提交 `c90bb048830e0a35af50efad81c4f31b733add11`；线上主控二进制的构建 SHA 仍未取得。

## 已复现的缺陷和修复

当前主控源码已经注册 `POST /api/v1/donebot/cloud/nodes/:node/:verb`，并处理 `runtime-credential`。签发流程先校验节点、实例归属、用户、订阅、期望状态和节点心跳；已有加密凭据解密后，调用 `ValidateRuntimeCredential` 再检查安装与密钥。

该校验原先调用普通 `APIKeyService.GetByID`。普通管理入口刻意把 DoneBot 托管密钥隐藏为 `API_KEY_NOT_FOUND`，因此一个实际存在且有效的托管密钥，在重复获取/重启时也会触发 404。修复前单元回归已复现；修复后仅该受信安装校验使用现有 `doneBotKeyManagementContext`，保留 owner、group、active、有效期和凭据常量时间比较。没有开放普通密钥管理权限。

这一源码缺陷与线上业务响应一致；相同业务码也可能来自真正缺失的密钥。要把具体线上请求确认到该分支，仍需核对部署二进制 SHA 和升级后日志的 `step`，不据此声称线上已恢复。不要删除安装记录、旋转所有用户密钥或清空 Cloud 凭据表作为修复。

## 新增诊断与重试

主控在失败时记录 request ID（来自现有 RequestLogger）、node ID、instance ID、HTTP 状态、稳定业务 reason 和以下阶段；响应 `metadata.step` 同步返回阶段：

| step | 检查位置 |
| --- | --- |
| `node_auth` | 节点身份及运行凭据配置 |
| `begin_transaction` | 开启事务和实例锁 |
| `authorize_runtime` | 节点归属、订阅/有效期、期望状态、用户及节点心跳 |
| `credential_cipher` / `read_credential` / `decrypt_credential` | 凭据加密配置、读取、解密 |
| `validate_installation` | 已有凭据对应的安装和托管密钥校验 |
| `claim_installation` / `rotate_installation` | 首次安装或已有安装需要交付凭据 |
| `persist_credential` / `commit` | 加密落库和提交 |

日志不输出凭据、token、请求体或底层错误正文。节点只保留明确允许的业务 reason、阶段和格式受限的 `X-Request-ID`，不记录主控 message、任意 metadata 或响应正文。已知业务码映射成 `master_api_key_not_found` 等小写码供主控操作记录保存；无允许业务码的 HTTP 404 记为 `master_http_not_found`，需进一步区分代理、路由和业务响应，不能凭这个名称断言路由缺失。

节点 journal 增加 `instance_start_failed`、`instance_started`、`operation_completed`、`operation_failed`、`operation_reported`、`operation_report_failed` 和 `master_poll_failed` 事件。`operation_reported.outcome=failed` 表示主控接收了失败结果，不能读作启动成功。获取凭据失败不会调用 agent start；同一实例代次按 15、30、60、120、240、300 秒退避，之后最多每 300 秒尝试一次。主控重新派发同代命令也遵守退避，新代次允许立即重试。进程重启后重新建立退避；没有增加永久失败状态。

只有成功启动的实例才允许代理访问；部分创建失败但可能遗留资源的实例仍会在失去租约时执行停机。退避期间继续领取租约和其他用户命令，不延长过期授权。`/healthz` 继续只表示节点与主控/agent 的基础就绪，实例运行状态以其操作结果、健康检查及实际访问为准。

## 部署与复核

1. 在主控执行只读 `/opt/sub2api/sub2api -version`，保存 Version、Commit、Date；同时核对节点 `git -C /opt/donebot-cloud rev-parse HEAD`。有源码不代表二进制已更新。
2. 由 donebot-api 发布包含本次修复的正式二进制 Release，沿现有后台在线更新并重启。保留签名 seed、数据库及环境文件。
3. 更新 Cloud 节点代码和依赖，重启 `donebot-cloud-worker.service`。worker 重启会先停止其记录的实例，再依据新租约恢复，应安排维护窗口。该凭据修复不要求替换现有 DoneBot/桌面镜像，也不修改 agent 协议。
4. 在用户明确授权的测试实例进行一次启动，关联主控和 worker request ID。成功响应含运行凭据，不将响应正文粘贴到工单或日志；只记录状态、允许的业务码和阶段。若仍有 `API_KEY_NOT_FOUND`，依据 `validate_installation` 检查该安装关联的密钥状态，不自动新建替代身份。
5. 顺序核对：凭据签发成功、agent 使用审核镜像 ID 创建容器、DoneBot 健康、主控操作成功/页面运行、本人鉴权代理访问成功、另一个合成用户被拒绝、停止/重启保留数据、撤销后拒绝凭据和访问。节点 healthz、首页 200 或 report 200 都不能替代这些检查。

本轮没有登录或修改生产主控、节点、数据库及用户实例；隔离结果见 [验证记录](verification.md)。完整线上 Docker、页面、跨用户和撤销验收仍待按上述步骤执行。
