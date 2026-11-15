# 腾讯按量执行池

范围为同地域的最多两台按量 CVM，网站、唯一业务 PostgreSQL 和纯解析保持常驻。首版使用原生 CVM API，经现有运维服务的既有 tick 调和（启动、重启、无业务事件空闲期间均推进）；不启用 AS 告警扩容、健康替换或自动缩容。AS 的 `WAKE_UP_STOPPED_SCALING` 仍可能销毁实例或创建新实例，不能证明满足排空协议。关联 #1361；公共状态和方法只由 `packages/contracts/src/execution-capacity.ts` 定义。

## 准备物料

`deploy/tencent-elasticity/pool.example.json` 默认关闭，不含凭据。执行前填写并评审以下物料：

| 物料 | 首版约束与凭据 |
| --- | --- |
| 计算 | ap-beijing / ap-beijing-7，SA9.LARGE16，4 核 16 GiB；按量 0.8 元/小时，最多两台计算 1.6 元/小时 |
| 磁盘 | 每台 40 GiB 系统盘、80 GiB 数据盘；两台共 240 GiB。停止后继续收费，实际单价与周期余额须另留报价 |
| 网络 | 明确 VPC、子网、安全组、出口方式。连接唯一主站 PG 的受限通道须实测；不默认开放公网 PG，不自动创建 NAT 或公网 IP |
| 镜像 | 官方免费 Ubuntu LTS 制作的已审核镜像，记录 ImageId 和运行镜像/源码 hash。镜像无个人配置、认证、私钥或登记 token |
| 权限 | 控制角色与节点角色分离。两节点各自独立 CAM role，仅读自己的服务端短凭据；实例角色载体为 `cvm.qcloud.com` |
| 版本 | 公共 launch manifest 绑定盘、VPC、安全组、角色、出口、UserData、源码和镜像；Run 请求按该 manifest hash 核对 |
| 预算 | PG 权威策略默认全群 4、单节点跨进程总 4。提升至 8 须有供应商并发/速率和费用准入的实际评审凭据，未知费用仍保留 |
| 凭据发行 | 控制端先按云账户、地域、准确实例、启动 epoch 预登记；确认云启动完成后绑定短登记 token 的 hash。节点角色只能取得自己的 token，不能通过 metadata 自报获准 |

停止请求使用 `StopType=SOFT`、`StoppedMode=STOP_CHARGING`。单节点受控验收允许先验证实际停机免计算费模式；自动阶段必须已有对应原件。磁盘、IP 和网络费用均不因此归零。

## 生命周期与恢复

1. 从 PG 取得有效独立工作或组 leader、有限批内窗口和最老等待；共享等待、材料/业务/付款阻塞及未知调用不计扩容需求。再次查询准确云库存；未 ready、启动中和未决操作保留库存与费用预约，不计可用处理容量。
2. `reserveStart` 原子保存 launch request、库存/预算预约和固定 ClientToken；`claimCloudDispatch` 唯一 CAS 胜者先记录网络不确定性再调用云 API。Run 每次只创建一台，Start/Stop 没有 ClientToken，不依赖 SDK 重试。
3. API RequestId 仅证明受理。归档 Describe 的安全元数据，核 `LatestOperationRequestId` 与原 ACK、对应操作 SUCCESS、准确实例状态及完整启动范围。缺失 ACK、超时和外部漂移保留未决状态，不重新开池或自动重投业务。仅官方四个明确库存拒绝码、单实例 Run、真实请求 ID 和已归档原件可持久拒绝与冷却。unknown Run 先 Describe 查原创建 tag，绑定归属后仍不得冒签缺失 ACK。
4. 停止前 `beginDrain` 禁止新领取；现有任务继续心跳和保存成果。只有所有预登记服务正向回执、租约、模型 holder、子进程和未提交成果均为零，才取得 `drainProof`。时间过去或租约过期不能代替回执。
5. `submitStop` 先冻结 epoch，随后唯一 dispatch。停止未决期间不得 ready、Start 或登记新 epoch。仅准确 Stop 完成、`STOPPED` 和 `StopChargingMode=STOP_CHARGING` 的证据才允许回收旧 epoch 容量；完整 holder 前像 CAS 与账务未知保留由 PG 适配器处理。
6. 常驻实例明确固定；自动缩容要求另一台已经 ready 并覆盖相同能力。启动中或失联节点不能作为替代。连续空闲起点来自 PG 正向零活动回执，不用 TTL。

## 自然日费用准入

`costcap.mjs` 从 PG 权威时钟及全历史 operation/node、受控报价和准确 Describe 库存生成上界。配置明确 `time_zone`（默认 `Asia/Shanghai`）、报价与费用策略 hash；自然日 periodKey 不能滚动刷新。报价必须给出计算、盘、IP、出口、网络和 Secret 六项运行/停止小时上界及价格原件、强制使用量边界 hash。仅单位价格或空账单不能证明出口上界；缺项禁止新增支出。

工程默认计算每台 0.8 元/小时、池 1.6 元/小时；整机估算 2.4 元/小时、自然日 48 元。这是工程准入参数，须用最新真实报价校验，不是新增用户每日任务/token 限额。上界保留上一日未决 Run/Stop 负债、当前预约、常驻剩余周期和两槽排空余量。已停止的盘等费用继续计入，只有原 ACK 精确匹配的停止完成允许计算费节省；无账单不归零。未来实际账单对账须与准确资源/操作去重，不替代现有模型用量账本。

费用缺失或耗尽调用 PG `setAdmissionBudget` 禁新领取；已有获准有效租约仍可在供应商并发上限内完成后续调用、心跳和成果提交。备用先排空，不能强杀。单次启动的未派发 intent 在费用/需求仍有效时以同 op/token/manifest CAS 重授权；失效时仅取消完全未 dispatch/无 ACK 的 intent，暖启动恢复完整原停止前像。unknown/submitted 保留冻结，不能走取消出口。

## 运维入口与节点启动

自动路径为现有 `apps/worker/src/ops-scheduler.ts` 的 tick → `createExecutionPoolOpsHandler({control,configPath,expenseLedger,enrollmentBinder})`。未配置不发云请求；每 tick 先恢复 pending，最多一项云变更，费用失效仍推进安全排空。Dockerfile 明确 COPY 本目录依赖模块，须做实际镜像布局 import smoke。

按需人工管理入口可调用 `node deploy/tencent-elasticity/reconcile-entry.mjs <plan|start|drain|recover> <private-config> <private-request> <operation-id>`。仅按需调用；该入口不运行循环。配置、短控制凭据和登记文件须为当前 UID 的普通 `0600` 文件，拒绝 symlink。凭据只读入内存，不打印或存入云观察原件。

`bootstrap.service` 是一次性启动入口。审核镜像须预装 Node、Docker、本模块及已核 hash 的节点专属 broker/runtime adapter；配置缺失即启动失败，不执行默认个人 provider。公开 UserData 仅写服务 manifest；短凭据在控制端准确云绑定之后发行。具体 `enrollment.mjs`、`node-adapter.mjs` 已提供受限 SSM/STS broker 与 Docker/PG 接线。控制端先 PG 绑定，再精确 Get/Put/readback 同一 SecretName/VersionId（Put 受理丢失不换 token/版本）；节点必须匹配当前 Start/Run RequestId，暖启动不能读取旧 epoch 的 tag。开机握手最多等待 120 秒，不新建调度循环。真实云和 Secret 发行为延期验收项，函数单测不能证明实机可启动。

独立 `compose.yaml` 只含编制和复核。`BB_EXECUTION_ENROLLMENT_FILE` 分服务绑定准确登记文件；必须在 runtime 的 managed-node 断言和 session gate 已接通后使用。运行 UID/GID 固定 `1000:1000`；登记与服务私有目录 `0700`、文件 `0600`，按实际 UID 安装，不改世界可读。子工具 explicit deny 登记、服务凭据和宿主配置目录；Compose 保留受限 seccomp/AppArmor、cap-drop ALL 和 no-new-privileges，不允许 privileged/unconfined。编制能力仅 authoring，复核为 review/assistant，probe 显式关闭；launch capabilities 从 services 并集派生。任务种类限定 `run`、parse slots 为零、确认服务关闭；纯解析/确认等未纳入排空统计的入口不得启动。两进程共享 PG 单节点 4 槽，不能分别占 4 槽。总硬内存上限 9 GiB，两个临时目录共 1 GiB，余量留给系统与实际子进程；真实双节点混合峰值仍需核验。

PG 通道使用 `pg-client.conf.example`/`pg-client.service`，仅绑定获审私有 bridge 地址，TLS 对端 SNI/CA/独立客户证书全部校验。节点启动核准确 stunnel 配置 hash、活动 unit 和每个 credential 权限，再以独立服务环境做真实 SQL system identifier 检查后才启动消费者；全服务 ready 再核同一数据库/epoch/pins。网络路由或其他任务的临时测试规则不是本池 ready 证明。

## 阶段、验收与撤销

按单节点、双节点、自动策略三阶段推进。自动阶段在供应商/费用策略、实际库存失败冷却和真实停机费用证据满足前保持关闭。定向云故障单测、真实隔离 PG 双节点测试、真实云启动/领取/保存/排空/停机分别记录，模拟云端不可冒充 live。

所有 live 操作先留准确配置、库存、运行版本和安全观察前像；测试最多两台，不新增无界资源。失败先禁领，保留运行任务、未知调用与成果。确认排空/云停止后才清本次合成资料和测试资源；带客户/成果/未决操作的盘不得删除。回退优先关闭扩容，保留常驻容量，再按本协议排空备用；不强停运行任务，不因客户端超时猜测云操作未发生。

官方依据：[CVM SDK 模型](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/cvm/v20170312/models.py)、[CVM API 方法](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/cvm/v20170312/cvm_client.py)、[实例角色](https://cloud.tencent.com/document/product/213/47668)。
