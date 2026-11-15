# 执行池付款前置拒绝的安全恢复

关联 #1398、#1361。此通路只覆盖可证明未创建实例的付款前置拒绝，不能将单独的 `UnauthorizedOperation`、空库存、超时或丢失 ACK 当作结案依据。

## 可信证据与兼容旧归档

控制入口用 `executionCapacityControl(pool, scope)` 注入受控的证据目录、账号、地域、控制角色及审核过的付款审计与官方契约 hash。这些是运维侧信任配置，不接受公开请求指定。证据目录须同进程 UID、0700、父链无软链接；文件须同 UID、0600、单硬链接，内容 SHA256 对应文件名。读取使用 no-follow，校验原始字节及读取前后身份和元数据，不用重新序列化的 hash 代替原件 hash。

旧拒绝归档保持原七字段及字节。原 operation/token hash 连接唯一已派发、无身份及无成功 ACK 的 PG 记录；原不可变请求、确定性 token 和重算的完整 Run 参数 canonical hash 必须与原 launch manifest 一致。旧云归档没有的 account、region 和 manifest 来自受控目录与 PG 验证链，不能回填后声称是原云字段。

另需审核并 pin `payment-prerequisite-audit-attestation-v1`。schema 定义在公共契约的 `ExecutionRunPaymentDenialAuditSchema`，保留 `source_notes`：

- 云审计源：原 API RequestId、审计查询 RequestId、原响应 hash、事件时间、AssumedRole 身份、付款错误文本固定 hash、未返回实例及官方前置付款契约 HTML hash。
- 派生关联：原 operation、token hash、归档 hash 和 launch hash。审计中脱敏的 token 只由原操作确定性恢复；明确记录数值/布尔规范化及去除传输字段的转换。
- 分类固定为 `payment_rights_prerequisite_rejected`，账号/地域/角色与 scope 相同，事件与原派发时间相差不超过 30 秒。

含凭据的原审计留在其已有管理环境；仅受控转录上述派生证明，保留原件 hash 和来源说明。应用原归档没保存的 Message 不补写。2026-11-15 的付款原因已由原 RequestId 对应的云审计恢复，而不是由应用归档恢复。

## 显式结案

私有配置增加 `denial_recovery.payment_audit_sha256` 和 `denial_recovery.official_contract_html_sha256`，对应审核后的派生证明与官方契约。输入 JSON：

```json
{
  "revision": 2,
  "evidence": {"evidence_ref": "<原归档绝对路径>", "evidence_sha256": "<原字节SHA256>"},
  "payment_audit": {"evidence_ref": "<受控派生证明绝对路径>", "evidence_sha256": "<审核并pin的原字节SHA256>"}
}
```

```sh
node deploy/tencent-elasticity/reconcile-entry.mjs finalize-denial "$config" "$input" "$operationId"
```

该入口重算原 launch 参数，亲读两份证据，经同一 PG 事务锁定 policy 与 operation 后结案。原操作进入 `rejected`，保存单独的付款拒绝证明并增加一次 revision；原成功 ACK 字段保持 null，原 token/request/档案保留。相同原 revision 与证明并发重放幂等；不同证明、已有身份或成功 ACK、错误绑定、非可信路径均拒绝。迁移 `0184_execution_run_authorization_denial.sql` 不改写任何历史操作。

结案同时设置持久 `launch_blocked_by_operation_id`。它阻断 Run/Start 的规划、预约、重新授权与派发；报价刷新、budget=true 或冷却结束都不能清除。原租约及已证明的排空/Stop 不受这项扩容阻断影响。结案不会执行云请求。只有证据验证通过后才结束该未创建实例操作的未知责任，其余已发生费用、人工预留及固定承诺保留。

## 纠正审核与显式恢复

另行保存 `ExecutionRunAuthorizationCorrectionSchema` 对应的受控政策读回：账号、地域、控制角色、当前私有配置 canonical SHA256、政策 ID/文档/hash、政策及附加清单读回 RequestId、原政策 ID 清单及当前完整清单。配置 hash 明确排除整个 `denial_recovery` 证据 pin 字段，避免审核文件与配置形成循环 hash，其他操作与费用配置均绑定。当前窄类别只接受正向的单条 `finance:trade` / `qcs::cvm:::*` 政策；所有原政策须保留且仅新增该政策，无关或 deny 政策不能解锁。这是产品付款权限，不声称地域、池或金额级财务限制，也不证明实际 Run 成功。

恢复审核原件使用 `ExecutionRunAuthorizationRecoverySchema`，包含原 operation、account/region、原拒绝证据 hash、纠正证据 ref/hash 及 `allow_new_operations` 决策。输入为 `{"policy_revision": <当前版本>, "review": {"evidence_ref": "<审核文件>", "evidence_sha256": "<SHA256>"}}`。

```sh
node deploy/tencent-elasticity/reconcile-entry.mjs resume-authorization "$config" "$input" "$operationId"
```

审核后还须在受控配置 `denial_recovery` 中 pin `payment_correction_sha256` 与 `authorization_recovery_review_sha256`，对应纠正政策原件及恢复审核原件的字节 hash；从调用参数取得的自述/hash 不能替代这两个独立信任 pin。入口验证当前 block、原 terminal denial、政策读回和配置 hash，使用 policy CAS 保存审核再解除 block。旧审核不能解除后续拒绝的 block；没有定时或报价路径自动调用恢复。解锁只允许之后经原需求、库存、预算与幂等门检查的新操作，不重发原 token，不创建新 ACK。

## 最小诊断与发布边界

新拒绝归档增加 account/region/launch hash；只保存调用本身的 action 和从真实请求允许资源中匹配到的固定账号/地域 ARN 线索。完整 vendor Message、任意自由文本、凭据均不写入。矛盾的 Error+InstanceIdSet 响应继续按未知处理。

定向测试使用独立 PostgreSQL 及明确合成的云/审计/政策响应。真实旧档案可另在该隔离库重放验证，不能修改真实池或重投原 Run。此修复不改变节点 enrollment、session/claim、注册/续租契约，不代替生成成果业务验收；部署、镜像版本整合与真实恢复由发布验收分别执行。
