# M3 项目助手：实际供应商与持久化恢复验收

2026-10-02T13:40:39Z–13:41:30Z，本地 Windows 验收通过：生产 API handler → 材料上传/解析 → 助手持久化队列 → durable journal → 实际 Copilot Enterprise → 故障注入 → 恢复回复。最终这一轮只有 **1 次供应商启动、1 条 attempt、1 条助手回复**；恢复没有再次调用供应商。结构化、去标识证据见 [m3-assistant-durable-evidence.json](m3-assistant-durable-evidence.json)。

本次使用当前既有 `copilot-enterprise` 账号、`gpt-6.1-sol`，保留 `approval_policy=on-request`、`approvals_reviewer=auto_review`、内层 `read-only` 沙盒及关闭工具的配置。没有读取、复制或打印凭据文件；CLI 通过自身既有登录访问供应商。全局配置文件的 SHA-256 在执行前后相同。

## 验收路径与故障恢复

业务数据全部为合成值：母公司收入 100 万元、合并收入 120 万元；材料明确声明没有审计意见。没有使用真实客户资料。

1. 新建随机命名的本地 PostgreSQL 数据库并应用现有 84 个迁移；未连接或修改已有 `bondbuddy_m3` 业务库。初始唯一项目是迁移自带的固定 `platform_probe`，初始助手消息为 0。另建独立 Azurite 容器。
2. 通过生产 `createServer` 的 Fastify `inject` 调用项目与材料 API：创建合成复核项目，申请上传、上传 TXT、完成上传并核对 SHA-256。由生产 `runMaterialParseOnce` 和 Python `runDocumentParser` 完成解析，再把明确的材料 V1 与 SHA-256 保存到复核草稿。
3. 两次提交相同 `submission_request_id`，API 返回同一条消息。生产助手 worker 锁定消息、读取已解析材料、保存提示词快照并调用实际供应商。保存的提示词包含附件中的 100 万元原文，提示词及供应商结果均通过存储字节的 SHA-256 核验。
4. 在供应商结果、用量与 attempt 已持久化后，回复落库前，注入 `SYNTHETIC_CRASH`。此时 attempt 为 `completed`、用量为 `measured`，用户消息仍为 `running`，助手回复数为 0。
5. 只让该合成消息的 lease 过期，重新运行生产助手 worker。恢复读取已保存的结果并生成唯一回复；回复内容与已保存结果完全一致。供应商启动数和 attempt 数仍各为 1。下一次 worker 返回 `idle`；恢复后重复提交仍返回原消息。

## 实际回复和用量

回复引用解析材料的 `evidence-000001 / text:l000001`，解释母公司与合并范围及抵销差异；没有把 20 万元差额直接认定为子公司收入。它要求正式审计报告、财务报表及附注、合并范围与收入政策、差异调节表等补充证据，并明确现有 V1 不能证明金额已经审计或复核通过。`proposal=null`，没有提出可执行变更。

| 记录项 | 最终这一轮结果 |
| --- | ---: |
| input tokens | 10,971 |
| cached input tokens（包含在 input 中） | 9,332 |
| output tokens | 1,062 |
| reasoning tokens（不再加到 total） | 720 |
| total tokens（input + output） | 12,033 |
| provider / attempt / reply | 1 / 1 / 1 |
| 工具尝试 | 0 |
| CLI exit code | 0 |
| provider attempt 耗时 | 41,434 ms |

用量来自实际供应商，`usage_status=measured`；`internal_cost=null`、`pricing_status=unknown`，没有将未知金额当作零。供应商请求 ID 仍为 unknown。供应商结果为 `completed`，`finish_reason=stop`，无错误码。

## 副作用与清理

| 数据 | 调用前 | 恢复后 |
| --- | ---: | ---: |
| runs | 0 | 0 |
| 关联 run jobs | 0 | 0 |
| revision plans | 0 | 0 |
| input revisions | 0 | 0 |
| billing / charge / payment / wallet / reservation / settlement / recharge outbox events | 0 | 0 |

复核草稿完全一致，`active_run=null`、`plan=null`。材料解析本身的队列任务不计入上表的“关联 run jobs”。本 schema 没有用户计费表，证据中的 `billing_tables={}` 仅说明不存在这些表；这次没有实现或验收收费系统。

验收结束后独立数据库已删除，并查询确认不存在；独立 Azurite 容器已删除。全局配置哈希保持不变。记录没有修改原型端口、浏览器存储、既有项目或账户数据。

## 边界与排障记录

这次执行了生产 API handler、解析器、助手队列、journal、适配器事件校验及恢复 worker；API 使用本地 `inject`，没有经过部署的 HTTP 服务或浏览器。真实供应商通过 **Windows diagnostics launch bridge** 调用既有 Codex CLI：为访问 CLI 自身缓存，外层诊断命令经过正常自动审批提升；实际模型会话仍保持只读、自动审批及关闭工具。

因此，它不代替生产 Linux 凭据 helper、进程组生命周期、部署网络及沙盒镜像验收，也不覆盖真实客户材料、实时公开搜索、Word/WPS 客户端或收费系统。Linux 路径由独立的 [PR CI 记录](m3-linux-pr-ci.md) 跟踪。先前五个实际供应商业务场景见 [助手场景探测](m3-assistant-live-2026-10-02.md)。

最终调用前的排障曾发现：`gpt-6.1-sol` 中的点号被结果存储校验误拒绝。2026-10-02T13:17:41Z 的前一次实际调用已经返回且用量 **measured / 11,851 tokens**，但结果存储进入 `MODEL_RESULT_STORE_FAILED / pending_reconcile`；不能把那次算作恢复成功，也不能把其用量写成 unknown。修复仅放宽 `model_id` 的合法版本字符，资源身份 ID 的严格规则不变。另修复 PostgreSQL 微秒时间经 JavaScript Date 截断造成的助手上下文边界问题，并用同毫秒内先后消息的确定性回归验证。

本文“1 次供应商调用”仅指本次最终独立验收，不包含先前排障。更早的默认沙盒 CLI 启动失败没有供应商用量，保持 unknown。

本地原始证据位于 `diagnostics/m3-assistant-durable-live/2026-10-02T13-40-39-433Z/result.json`。提交的 JSON 保留结果与提示词哈希、被测源码和编译产物哈希、实际回复、用量与恢复断言，移除了本地账户路径、动态资源标识及全局配置摘要。实现哈希对应本次执行时磁盘上的精确文件字节，采集早于最终 CRLF 规范化；它们不是规范化后的 Git blob 哈希。
