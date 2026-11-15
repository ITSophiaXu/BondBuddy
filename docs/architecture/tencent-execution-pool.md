# 腾讯按量执行池实现契约（#1361）

状态：实现共识 v1，2026 年 11 月 15 日。代码基线 `b21e5aba7c7b59b58f7ca1887f92df57c6a42388`；本文不代表资源已经创建、生产已经发布或真实扩缩容已经验收。现有数据库连接可靠性另见 #1356。

## 范围与模块边界

保留网站和唯一 PostgreSQL 常驻。执行池首阶段为同地域按量 CVM，最少一台运行、最多保有两台（停止备用也计数）；复用现有任务租约、checkpoint、模型调用 journal 和运维事件入口。不建立第二任务队列或额外定时监督服务。

| 模块 | 唯一修改范围 | 对外接缝 |
| --- | --- | --- |
| 数据与运行时 | `packages/contracts/src/execution-capacity.ts`、新增迁移 `0181_execution_node_capacity.sql`、API 领取事务、运行时和模型容量 | 权威节点、预算、需求快照、排空与云操作记录 |
| 腾讯适配 | `deploy/tencent-elasticity/` 的模板、原生 SDK 适配、一次性控制入口、bootstrap 和运维步骤 | 只通过上述接口改变业务控制状态；不直接另写数据库表 |
| 架构与独立复核 | 本文、接口与实现审查 | 不复制 DTO、不另占迁移编号 |

首版选择 **CVM 原生 API**。腾讯 AS 的 `WAKE_UP_STOPPED_SCALING` 官方定义仍是“缩容仍采用销毁实例的方式”，且“监控告警触发的扩容仍将创建实例”。实例保护与 lifecycle hook 不能独立保证安全排空；未证明所有自动替换、缩容旁路关闭前，不将业务节点接入 AS 自动活动。后续可替换云适配器，业务领取与停机契约保持不变。[1][2]

## 身份、节点状态与事务

`ExecutionNodeIdentity` 唯一权威为 `{account_id, region, instance_id, epoch}`；epoch 为每次受控启动的 UUID 代次。云账户/地域/实例必须来自可信控制面登记，与业务节点独立凭据绑定。不能把克隆的 machine-id、hostname、客户端自报 metadata 或单独一个 IP 当身份。machine-id 和 OS boot-id 只能作为本机诊断辅助信息。

采用共享契约中的最小状态：`starting → ready → draining → drained → stop_submitted → stopped`，失联另记 `lost`。`starting` 已包含持久登记阶段，不增加一个没有不同准入语义的 registered 状态。创建请求尚无实例 ID 时只保留云操作预留记录，不用伪实例 ID 注册节点。

- 编制、复核、助手、探测以及该节点承载的其他领取入口，在 **同一领取事务** 锁定节点/会话，检查 ready、准确 epoch、角色/能力、无停机 tombstone，再写原有 lease。不能先在内存检查 ready 再独立领取。drain 和 claim 必须遵守同一锁顺序，避免检查与提交之间的竞态。
- `draining` 禁止新领取，但保留租约和会话心跳；现 epoch 已领取任务可以凭有效 lease 继续完成必要后续模型调用和成果提交。不能简单以 ready-only 模型容量门将进行中任务卡死。新任务和无既有 lease 的探测不可借此继续启动。
- ready 和 drained 都以可信启动 manifest 中的预期服务/能力集合为准，不能只检查恰好已登记的会话。`drained` 要求该代次全部预期服务的会话给出正向 finished 回执，或有明确受控撤销/退出证明；实际 lease、模型 holder、原生进程、未持久化成果均为零。缺失会话、过期心跳、20 秒 shutdown 超时、CPU 空闲和等待 TTL 都不是零活动证据。唯一结果仍留在本地时不能停止或销毁。
- `submitStop` 在调用云 SDK **之前** 原子写不可逆停机意图，冻结 identity/epoch、operation ID、revision 和 proof hash。受理、超时、响应丢失均不得自动重新 ready、开启新 epoch 或重复提交未查明的停止。跨数据库和云 API 没有原子事务，不能以本地事务回滚假装外部停止未发生。
- 停机完成需可信 Describe 证明准确实例为 STOPPED、`LatestOperation=StopInstances`、`LatestOperationState=SUCCESS`，且 `LatestOperationRequestId` 与本次受理的 RequestId 一致。单独 RequestId 或 STOPPING 都不够。`LatestOperationRequestId` 可能为 null；若受理响应丢失或不能精确关联，不自动完成，不用 Describe 查询自身的 RequestId 代替实例最新操作 ID。发生漂移保持 unknown。
- foreign holder 仅在准确旧 epoch 的停止/销毁完成证据之后，按 holder 的完整前像 CAS 回收。失联不是死亡；容量释放不删除 billing unknown、不自动重发外部调用。云查询“查无此实例”也不能单独当销毁完成，须有准确销毁操作证据与身份范围。

共享契约以 `packages/contracts/src/execution-capacity.ts` 为单一来源：

| 接口 | 必需语义 |
| --- | --- |
| `snapshot()` | 同一权威 PG 的 policy revision、节点及 pending 操作预留、按可执行能力分组的需求与硬件容量 |
| `reserveStart(request, operationId, expectedPolicyRevision)` | 云调用前 CAS 预留最大保有量、费用与启动代次；Run 可暂缺 instance ID，Start 必须引用准确停止实例 |
| `beginDrain(identity, operationId, expectedRevision)` | 与领取事务互斥；重复相同操作返回既有状态，不同前像拒绝 |
| `drainProof(identity, operationId)` | 只在完整正向会话回执及零活动时返回 `ExecutionDrainProof`；否则 null |
| `submitStop(proof, action)` | 重新核准确前像与 proof，先写 tombstone，再准许一次云操作；首版自动动作只有 stop，没有 destroy |
| `recordCloudResult(...)` | submitted/unknown/completed/rejected 分开；保存可信云查询的安全元数据引用及 hash，拒绝旧代次、旧 revision 或没有完成证据的 completed |

节点和云操作不是新作业队列；业务作业仍在原有表中领取。控制入口每次事件只做有限状态推进，重复事件使用原 operation ID；处理者崩溃后依靠持久意图恢复，不能更换 ID 创建第二份云操作。

## 全群预算与单节点容量

新增迁移扩展 0179 的全库四槽约束，**不修改已部署迁移**。PG `global_model_limit` 默认 4，`node_model_limit` 固定 4；同节点编制、复核、助手和探测进程合计共享四槽，不能各自获得四槽。先保持旧行为，再显式启用 managed mode；managed mode 必须拒绝未登记的 legacy 领取与 holder，旧进程不能绕过新限额。

分配模型调用容量必须在一个原子事务内检查：准确节点代次/有效已有 lease、本节点剩余槽、全群模型槽、共享供应商账户并发/速率限制及现有费用预留资格。沿用公平 scope，固定锁顺序，不先占本地槽再无限等待全群槽。所有进程读 PG 权威 policy，节点环境变量只能选择模式/身份，不能提高权威限额。

两节点八路只有在显式配置 `global_model_limit=8` 且供应商账户、费用上限与已验负载允许时生效。不同节点凭据若属于同一供应商账户，仍共享同一预算。默认全群四路时，加机器不承诺模型吞吐翻倍。

`budget_available` 是权威预算检查结果，不是全部预算模型；必须关联 policy revision 和实际费用/供应商上限。腾讯控制配置至少固定每小时计算费上限、预算周期/币种、周期限额、已花费、已预留及未决操作成本；模型费用沿用现有 journal/账务预留，不另造账本。unknown 不按零费用处理。预算不足时禁止新增资源与新调用，正在安全排空但尚未结束的节点不能为强行满足账单上限而被杀；因此区分“严格新增支出准入上限”和无法瞬间截断的已有负债。

## 真实需求与扩缩容决策

可扩容需求来自原持久队列中 **已准入、依赖满足、没有业务阻塞、当前有独立执行价值** 的 run/group，按 authoring/review/assistant/probe 等实际能力分组，记录 `effective_queued_work`、最老等待时间、硬件 occupied/available。运行 lease 与已领取但等待模型的工作另列，不重复计入未领取积压。

共享计划的 250 个 waiter 不是 250 个独立任务。批次 parent、batch item 和子 run 采用规范 work key 去重；只有有限批内执行窗口已打开的独立工作计数，不将未展开项计为可立即执行。材料缺失、暂停、支付阻塞、unknown、共享计划等待、项目互斥和窗口外工作分别记录排除原因。最老等待从实际满足准入条件的时刻计时，不能拿早先被业务阻塞的创建时间冒充硬件等待。

一次扩容必须同时满足：相应能力存在独立可执行积压且等待超阈值；相应硬件槽实际不足；供应商与费用有余量；没有未决同池扩容；保有量和策略 revision 仍匹配。计算总保有量时计入 starting、ready、draining、drained、stop_submitted、stopped、lost 及未绑定实例的创建预留；lost 未证实销毁前不能免费腾出名额。启动停止备用优先于创建，永不因备用无库存启动失败而偷建第三台。

最少一台运行是目标，不是网络故障时绕过未知状态强制补机的授权。冷启动尚未业务 ready 不计可用槽；指标过期、PG 不可用、供方限流、预算已满和云操作 unknown 时停止新增动作。缩容只能选已有替代能力的弹性节点，完成真实排空后停机，保留常驻节点。冷却期与等待阈值可配置，依据实测 READY P50/P95 校准，不能声称秒起。

## 腾讯 API 的准确边界

官方 CVM 版本 `2017-03-12`；官方 AS 版本 `2018-04-19`。以下是公开 API 契约，不是已部署资源事实。[1][3]

| 操作 | 首版准确参数/返回语义 |
| --- | --- |
| CVM `RunInstances` | `InstanceChargeType=POSTPAID_BY_HOUR`、`InstanceCount=1`、固定 `Placement.Zone`、机型/镜像/VPC/子网/安全组；`ClientToken` 为同一操作持久化的 ≤64 ASCII 字符。同参数重试沿用原 token，未知结果先查询，不换 token。创建成功自动开机；返回 ID 仅受理，PENDING 不等于业务 ready |
| CVM `StartInstances` | `InstanceIds=[准确实例]`，仅 STOPPED 可启动；**没有 ClientToken 参数**。PG 先记意图，再单次调用，Describe 查 STARTING/RUNNING 与最新操作结果 |
| CVM `StopInstances` | `InstanceIds=[准确实例]`、`StopType=SOFT`、`StoppedMode=STOP_CHARGING`；**没有 ClientToken 参数**。不同时传旧 ForceStop，不用 HARD/SOFT_FIRST。仅在 drain proof 和 tombstone 后调用；返回 RequestId 不是完成 |
| CVM `DescribeInstances` | 核账户/地域/实例、归属、配置及 `InstanceState`、`LatestOperation`、`LatestOperationState`、`LatestOperationRequestId`、观察时间；安全原件 hash 留作完成证据。完成停止并回读 `StopChargingMode=STOP_CHARGING` 才确认选定停费模式；HTTP 200 或任意一个 SUCCESS 不替代对应操作完成 |
| AS Start/Stop | `StartAutoScalingInstances` / `StopAutoScalingInstances` 均无 ClientToken；Stop 默认 KEEP_CHARGING，且采用 SOFT_FIRST。首版不采用其停止路径 |

已核可规划规格为北京七区 `SA9.LARGE16`（4 核 16 GiB），按量计算费报价 0.8 元/小时；两台同时运行的计算费估算 1.6 元/小时。实施前报价与库存需有效；这不是整机全部费用，也不是固定月费。云盘、镜像、选定公网计费模式、网络及模型费用单列。按量全云盘实例通过 API 显式 STOP_CHARGING 才适用停计算费；操作系统内 shutdown 不等价，停止不保留 CPU 库存。[4]

可审参数必须包括：region/zone、固定已验 ImageId 和应用 digest、SA9.LARGE16、全云盘类型/容量、VPC/subnet、受限安全组、每节点角色、业务凭据 secret 引用、精确 PG 身份、外部 API/Blob 出口方式与价格、min_running=1、max_owned=2、预算/冷却配置。没有凭据值。未定字段保留明确缺项并拒绝 apply，不能填虚构 ID。业务需访问供应商和 Blob；仅设置公网带宽 0 且没有已验出口的节点不能宣称 ready，也不能暗中创建 NAT 等收费资源。

创建/启停请求前核精确资源归属和不可变参数 hash；标签只是检索条件，不是充分所有权证据。管理员并发漂移、部分返回或网络响应未知时记录 pending/unknown，并通过同一运维事件入口继续查明，不盲重发。在初始两台池内不自动销毁；重新制作镜像和替换节点另走明确排空、回滚和审查。

## 私网、无认证镜像与 bootstrap

Lighthouse 与 CVM 默认内网隔离。选择与唯一 PG 同账号同地域的 CVM VPC，经已有或经审查建立的云联网互通；先核 Lighthouse VPC 已有关联，不能为新池解绑现有网络。网段不冲突、路由和双方防火墙准确后，用受限私网传输验证原 PG 身份及真实 SQL；不公开明文 PG，不回绕跨云公网作为“私网已通”。Lighthouse 同账号同地域共用 VPC，且只能关联一个云联网；同地域 5 Gbps 及以下带宽免费条款不代表所有连接及其他组件免费。[5][6]

镜像仅含干净 OS、已验应用和依赖、固定应用/模型目录版本及启动校验逻辑，不含业务凭据、个人登录状态或可克隆节点身份。节点不现场 build、不追 latest。凭据在各自节点建立或由专属受限服务发放，禁止复制控制端 CAM 长期密钥或个人开发认证。

首阶段仅两节点，可采用 **每节点专属 CVM CAM role + 每节点独立业务 secret**：`CamRoleName` 由可信创建参数绑定，实例角色只读自己的 secret/制品，不授予 Run/Stop/角色管理权。官方要求角色载体包含 `cvm.qcloud.com`、实例使用 VPC，且每台实例同时只能绑定一个角色；不同节点可用不同授权策略，绑定角色本身无额外费用。云控制角色另设，仅受限操作该池和必要查询。通过官方实例角色临时凭据获取服务取密钥，按有效期刷新；凭据值只进入内存/受限运行文件，不进入 UserData、命令参数、镜像或日志。[3][7]

可信注册由控制面先将 Describe 证实的云 tuple、当前操作、immutable manifest、预期角色及一次性 epoch 绑定到 PG；bootstrap 使用该节点独有的业务注册凭据向受认证入口完成挑战与版本/PG 检查。注册凭据的服务端记录必须预先绑定该 tuple，不能信任请求体自报 account/instance。若一个共享 CAM role 可以读取两节点的所有 secret，则它不满足此隔离方案；需先收紧每节点角色/secret 权限。metadata 可辅助发现自身信息，不能替代控制面归属核验，也不能单独授权提升为 ready。

停止备用再次开机沿用该实例的业务身份但获受控新 epoch；只有前一次停止已查明完成，且没有旧操作在途，才允许新 epoch。旧会话、旧节点令牌与旧代次 lease 均不能领取或提交新任务。供应商凭据可属于共享计费账户，但节点授权、吊销和使用归属必须独立可追踪。

## 验收与交付顺序

1. **离线/隔离数据层**：两节点多进程模型总量默认 ≤4；允许全群 8 时每节点仍 ≤4，供应商与费用门不可绕过。claim/drain 竞态、旧 epoch、managed mode 下 legacy 入口、批次去重和 unknown 排除均有行为验证。
2. **故障路径**：进行中任务排空不被 20 秒计时杀死；缺任一会话回执就无 Stop。云调用前崩溃、受理后丢响应、重复事件、延迟旧 Stop、外部操作漂移都不让新任务被旧停止杀死。无可信死亡证据不回收 foreign holder，已收费 unknown 不重投。
3. **单节点云端**：已验镜像、独立凭据、私网原 PG SQL、领取/模型/持久成果、排空、API 停机和 STOP_CHARGING 费用边界可核；VM RUNNING 不替代业务 ready。
4. **两节点**：真实独立可执行工作触发一次备用启动，预算默认 4 与显式 8 两种行为符合契约；250 个共享 waiter 不误扩。含停止/创建未决的总保有量始终 ≤2。记录真实 READY 冷启动时延。
5. **自动入口**：前述通过后接现有运维事件的一次性 reconcile；证明事件丢失/重复及进程恢复不会导致无人处理的危险操作。若目前入口只有手工触发，明确自动触发尚未接通，不宣称已完成自动扩缩容。不新增定时监督服务。

发布需先完成兼容迁移和所有领取入口升级，保持默认全群四路，再启 managed mode；旧二进制不一定支持新表约束，不能在活跃八路时直接回滚旧程序。回滚先禁新增扩容/领取，保留续租与成果持久化，安全排空后降权威上限；不可通过删除 holder、账本或停机意图“解锁”。准确代码版本、镜像、云参数前像及行为证据分别留存。

## 官方来源

1. [腾讯官方 Python SDK：AS 模型与 ServiceSettings](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/autoscaling/v20180419/models.py)：ScalingMode、替换开关、Start/Stop 参数。
2. [AS 生命周期挂钩](https://cloud.tencent.com/document/product/377/34924)、[实例保护](https://cloud.tencent.com/document/product/377/33175)：超时结束挂起；缩容拒绝策略不构成否决；显式移除可绕过保护。
3. [腾讯官方 Python SDK：CVM 请求字段](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/cvm/v20170312/models.py)、[异步操作契约](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/cvm/v20170312/cvm_client.py)：RunInstances/StartInstances/StopInstances/DescribeInstances。
4. [CVM 按量实例关机不收费说明](https://cloud.tencent.com/document/product/213/19918)。
5. [Lighthouse 地域与网络连通性](https://cloud.tencent.com/document/product/1207/50103)。
6. [Lighthouse 内网互联](https://cloud.tencent.com/document/product/1207/56847)。
7. [CVM 实例角色](https://cloud.tencent.com/document/product/213/47668)：实施前据当前实例角色与临时凭据接口核精确权限；本设计未接触云账户凭据。
