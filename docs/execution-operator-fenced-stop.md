# 显式失败节点围栏停止

#1401 修复既有 `submitFencedExecutionStop` 与停止发送证明链的接线。它是显式故障恢复 API，未接入自动容量规划；本次修复不表示生产自动缩容曾发生该故障。

正常停止仍先生成原有 `execution-drain-v1`：租约、模型许可、原生子进程和未持久结果均为零，且所有预期服务有正向结束回执。该证明的生成及散列算法不变。

失败围栏允许已有租约、许可和未知供应商调用继续存在。授权调用先以节点 revision CAS 执行 `markExecutionNodeLost`，关闭新领取；再用返回的 revision、准确 identity 和唯一停止 operation ID 调用 `submitFencedExecutionStop(..., 'stop')`。不以租约到期、零心跳或空库存替代显式围栏。

## 持久证明与发送

受信 PostgreSQL 事务锁定 lost 节点，验证原 completed Run/Start、原 ACK、epoch、source/image/launch pins，再生成 `execution-operator-fence-v1`。证明包含准确 identity、停止 operation ID、lost revision、原启动 operation ID/ACK、不可变 pins 和节点/许可前像 hash。节点前像先规范为实际 JSON 持久表示，避免 Date 与 JSONB 往返不一致。

复用现有 `bb_execution_cloud_operations.request` JSONB 保存带 kind 的停止许可，`proof_sha256` 保存证明 hash，`node_preimage` 私有包装保存原节点和许可前像。无需新增迁移。公开 DTO 的 stop.request 保持 null，只返回 `stop_authorization` 和必要 hash，不公开完整前像或许可 token。

`stop_authorization.kind` 区分 `graceful-drain` 与 `operator-fence`。controller 在 claim 前校验类型、identity、operation ID 与 hash；PG claim 在 policy → node → operation 锁顺序下重新核对持久状态、revision、stop ID、原启动 ACK/pins 及前像；云 adapter 再核证明类型与 hash，然后发送原 StopInstances/SOFT/STOP_CHARGING。缺失或不匹配的许可不能把未发送意图改成 unknown。

旧的 request=null 正常排空意图，只能从同 account/region/instance/epoch、stop ID/drain ID 的原持久 drain_proof 恢复类型投影，并核对原 proof hash 与 request hash。loadOperation 与 listPendingOperations → resumeIntent 使用同一精确查询；没有原证明的旧记录不会被解释成 operator fence。

当前腾讯链仅支持 stop。API、claim、controller 和 adapter 对 destroy 明确拒绝，不生成或发送删除能力。历史动作枚举和费用记录保留。

## 不确定性与完成

节点 stop_submitted 与停止 intent 在同一事务持久化。同 operation 的重复提交返回同一操作/token；并发不同 operation 只有一个节点 CAS 赢家。发送前 claim 唯一标记 unknown；网络超时或丢 ACK 后不会再次发送。Describe 看到 STOPPED，但没有原 ACK，仍不能完成。

只有原 provider RequestId、准确节点/epoch、StopInstances、SUCCESS、STOPPED、STOP_CHARGING 全部匹配，才完成原停止操作。完成后既有逻辑回收当时锁定的模型许可、封闭旧 epoch 租约并保留检查点；未知供应商尝试、用量和费用责任继续保留，不能触发供应商重投或清账。原围栏前像不会被完成时的 contemporaneous holder_preimage 覆盖。

## 验证与版本边界

定向测试使用真实 PostgreSQL 事务/触发器、真实 controller、Tencent adapter 和 TC3 实现；CVM/STS HTTP、供应商尝试及进程身份为合成数据。覆盖时间字段持久化往返、提交/dispatch CAS、缺失/篡改证明、原 ACK/pins、unknown 不重发、持有许可的完成与保留、旧 pending 排空入口以及 destroy 前置拒绝。测试不调用真实云或模型。

控制端与契约必须一起更新。旧节点没有消费新的停止许可字段，既有节点 pins 不因此重写；旧完整控制 DTO 校验器可能拒绝新增字段，不能用旧完整控制端读取新 DTO 冒充兼容。费用字段和估算算法不变；历史已完成 drain 费用记录无需停止许可，不能据此再次派发。混合版本隔离测试不等于最终同版本发布验收。
