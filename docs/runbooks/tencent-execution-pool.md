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
3. API RequestId 仅证明受理。Run 单独归档并持久保存原 RequestId、唯一 InstanceIdSet、操作／实例／epoch、固定 token、launch manifest 和完整云启动范围 hash。随后准确 DescribeInstances 核角色、镜像、区域、网络、盘、公网关闭及创建 tag；DescribeInstancesStatus 也必须返回同一单实例 RUNNING。Run 的三个 LatestOperation 字段可以为 null，公共 schema 原样保留，不制造启停字段。Start/Stop 则仍核 LatestOperationRequestId 与原 ACK、对应操作 SUCCESS 和准确状态。缺失受理 ACK 的 unknown Run 可按创建 tag 绑定库存归属，但仍不得完成、发行登记或重投。仅官方四个明确库存拒绝码、单实例 Run、真实请求 ID 和已归档原件可持久拒绝与冷却。
4. 停止前 `beginDrain` 禁止新领取；现有任务继续心跳和保存成果。只有所有预登记服务正向回执、租约、模型 holder、子进程和未提交成果均为零，才取得 `drainProof`。时间过去或租约过期不能代替回执。
5. `submitStop` 先冻结 epoch，随后唯一 dispatch。停止未决期间不得 ready、Start 或登记新 epoch。仅准确 Stop 完成、`STOPPED` 和 `StopChargingMode=STOP_CHARGING` 的证据才允许回收旧 epoch 容量；完整 holder 前像 CAS 与账务未知保留由 PG 适配器处理。
6. 验证阶段常驻实例明确固定，保留常驻节点；零底线自动阶段可按后文正向排空规则停最后一台。需要保留能力时，另一台必须已 ready 并覆盖相同能力；启动中或失联节点不能作为替代。连续空闲起点来自 PG 正向零活动回执，不用 TTL。

0182 仅新增 `run_acceptance` 列，旧操作不补造受理证明。控制端需按准确库存范围授予只读 `DescribeInstancesStatus`；节点角色仍仅读取自己的实例与独占 Secret。签发、登记和证书刷新共用 contracts 的分 action 完成校验，Run 的原证明随独占登记信封及本地 transport 状态传播。目标数据库迁移、实际业务节点启动和完整镜像验收分别执行。

## 自然日费用准入

`costcap.mjs` 从 PG 权威时钟及全历史 operation/node、受控报价和准确 Describe 库存生成上界。配置明确 `time_zone`（默认 `Asia/Shanghai`）、报价与费用策略 hash；自然日 periodKey 不能滚动刷新。报价必须给出计算、盘、IP、出口、网络和 Secret 六项运行/停止小时上界及价格原件、强制使用量边界 hash。仅单位价格或空账单不能证明出口上界；缺项禁止新增支出。

工程默认计算每台 0.8 元/小时、池 1.6 元/小时；整机费用上限 4 元/小时、自然日 48 元。这是工程准入参数，须用最新真实报价校验，不是新增用户每日任务/token 限额。上界保留上一日未决 Run/Stop 负债、当前预约、验证阶段的常驻剩余周期和两槽排空余量。已停止的盘等费用继续计入，只有原 ACK 精确匹配的停止完成允许计算费节省；无账单不归零。未来实际账单对账须与准确资源/操作去重，不替代现有模型用量账本。

运行和停止费用按同一账户／地域／实例的全历史操作分段，停止证明必须绑定当时已派发的 epoch、非空原 ACK、SUCCESS、STOPPED、STOP_CHARGING 和云观察原件。已证明停机区间不会因暖启动预约更新当前 epoch 或清空停止指针而丢失。下一次 Start 仅从 `dispatched_at` 开始保守计运行；未派发意图只预约未来成本，取消后恢复原停止前像。unknown Start 从原派发时刻计费，unknown Stop 不提供计算费节省；跨日未决负债也按历史运行／停止区间计算，盘、SSM、快照和安全排空余量仍保留。

费用缺失或耗尽调用 PG `setAdmissionBudget` 禁新领取；已有获准有效租约仍可在供应商并发上限内完成后续调用、心跳和成果提交。备用先排空，不能强杀。单次启动的未派发 intent 在费用/需求仍有效时以同 op/token/manifest CAS 重授权；失效时仅取消完全未 dispatch/无 ACK 的 intent，暖启动恢复完整原停止前像。unknown/submitted 保留冻结，不能走取消出口。

## 运维入口与节点启动

自动路径为现有 `apps/worker/src/ops-scheduler.ts` 的 tick → `createExecutionPoolOpsHandler({control,configPath,expenseLedger,enrollmentBinder})`。未配置不发云请求；每 tick 先恢复 pending，最多一项云变更，费用失效仍推进安全排空。Dockerfile 明确 COPY 本目录依赖模块，须做实际镜像布局 import smoke。

按需人工管理入口可调用 `node deploy/tencent-elasticity/reconcile-entry.mjs <plan|start|drain|recover> <private-config> <private-request> <operation-id>`。仅按需调用；该入口不运行循环。配置、短控制凭据和登记文件须为当前 UID 的普通 `0600` 文件，拒绝 symlink。凭据只读入内存，不打印或存入云观察原件。

`bootstrap.service` 是一次性启动入口。审核镜像须预装 Node、Docker、本模块及已核 hash 的节点专属 broker/runtime adapter；配置缺失即启动失败，不执行默认个人 provider。公开 UserData 仅写服务 manifest；短凭据在控制端准确云绑定之后发行。具体 `enrollment.mjs`、`node-adapter.mjs` 已提供受限 SSM/STS broker 与 Docker/PG 接线。控制端先 PG 绑定，再精确 Get/Put/readback 同一 SecretName/VersionId（Put 受理丢失不换 token/版本）；节点必须匹配当前 Start/Run RequestId，暖启动不能读取旧 epoch 的 tag。开机握手最多等待 120 秒，不新建调度循环。真实云和 Secret 发行为延期验收项，函数单测不能证明实机可启动。

节点专属角色与同名 secret 使用 `bondbuddy-execution-node-1`、`bondbuddy-execution-node-2`。每个角色只能读取准确 creatorUin/SecretName 资源与自身实例，不授予云修改或 secret 写权限。控制角色独立发行新服务凭据，不使用个人登录状态。Secret 版本为当前已完成启动操作的固定版本，必须通过当前云 RequestId 与 PG 节点身份绑定。

`private-transport.mjs` 将 broker 返回的 `transport_credentials` 接到实际节点启动：版本 `execution-pg-mtls-v1`，必须含 account_id、region、instance_id、epoch、ca_pem、cert_pem、key_pem。客户端证书 CN 为 `<instance_id>:<epoch>`，须含 clientAuth、由已 pin 的 CA 签发、私钥匹配且有效期不超过一天。安装至 root 独占的 `/etc/bondbuddy/transport`（目录 0700、文件 0600），整个目录已被模型文件权限规则拒读。镜像、UserData 和公开证据不含这些字节；构建和镜像快照必须在发行前完成，清理时撤销证书并删除发行文件。服务登记与环境目录由 root 持有，group 1000 仅能遍历，文件按运行用户 UID 1000 安装 0600，禁止替换目录条目。

启动还核对 stunnel 配置、unit hash、远端 endpoint/SNI/CA 和受控 Docker bridge 的完整配置；不存在时创建专属 internal bridge，已有配置漂移或观察失败则拒绝。凭据安装后才启动 transport，每个服务从该网络执行真实 SQL system_identifier 预检，再启动消费者。已活跃 transport 的凭据不一致时不重启、不覆盖，保留既有持有者。私网路由与 cloud API/供应商/Blob 的受限代理出口必须另有实际连接和费用上界证据；internal bridge 不提供默认互联网出口。准确角色、网络、凭据、报价或不可变镜像缺失仍拒绝 apply。

独立 `compose.yaml` 只含编制和复核。`BB_EXECUTION_ENROLLMENT_FILE` 分服务绑定准确登记文件；必须在 runtime 的 managed-node 断言和 session gate 已接通后使用。运行 UID/GID 固定 `1000:1000`；登记与服务私有目录 `root:1000/0750`、文件 `1000:1000/0600`，按实际 UID 安装，不改世界可读。子工具 explicit deny 登记、服务凭据和宿主配置目录；Compose 保留受限 seccomp/AppArmor、cap-drop ALL 和 no-new-privileges，不允许 privileged/unconfined。编制能力仅 authoring，复核为 review/assistant，probe 显式关闭；launch capabilities 从 services 并集派生。任务种类限定 `run`、parse slots 为零、确认服务关闭；纯解析/确认等未纳入排空统计的入口不得启动。两进程共享 PG 单节点 4 槽，不能分别占 4 槽。总硬内存上限 9 GiB，两个临时目录共 1 GiB，余量留给系统与实际子进程；真实双节点混合峰值仍需核验。

PG 通道使用 `pg-client.conf.example`/`pg-client.service`，仅绑定获审私有 bridge 地址，TLS 对端 SNI/CA/独立客户证书全部校验。节点启动核准确 stunnel 配置 hash、活动 unit 和每个 credential 权限，再以独立服务环境做真实 SQL system identifier 检查后才启动消费者；全服务 ready 再核同一数据库/epoch/pins。网络路由或其他任务的临时测试规则不是本池 ready 证明。

控制端 `node_secrets[].pg_issuer` 指定新 CA 的私有文件、hash 与新签名私钥文件。`transport-issuer.mjs` 从准确已完成操作的 instance/epoch 动态签发 clientAuth 证书，`issueNodeEnrollment` 在持久 vault 写入前注入；同操作重试仍发布同一 vault token/证书/SecretVersion，warm Start 新 epoch 必须使用新证书。真实 ops 入口在预算开启、未派发意图恢复或新增云支出之前检查 issuer；缺失/失效只关闭新增支出和领取，不妨碍既有排空。签名权只留控制服务，节点 secret 不含 CA 私钥。

数据库客户端 unit 刻意没有 Install 段，禁止 enable。安装时清除该专属 unit 的旧开机链接；warm 开机先等待当前操作的 broker envelope，再安装当前 epoch leaf 并显式 start。启动检查 unit 为 static/disabled，启用开机自启则拒绝。已有 active transport 的身份/凭据漂移仍拒绝覆盖或重启，不能以重启掩盖旧流量。

## 阶段、验收与撤销

按单节点、双节点、自动策略三阶段推进。自动阶段在供应商/费用策略、实际库存失败冷却和真实停机费用证据满足前保持关闭。定向云故障单测、真实隔离 PG 双节点测试、真实云启动/领取/保存/排空/停机分别记录，模拟云端不可冒充 live。

所有 live 操作先留准确配置、库存、运行版本和安全观察前像；测试最多两台，不新增无界资源。失败先禁领，保留运行任务、未知调用与成果。确认排空/云停止后才清本次合成资料和测试资源；带客户/成果/未决操作的盘不得删除。回退优先关闭扩容，保留常驻容量，再按本协议排空备用；不强停运行任务，不因客户端超时猜测云操作未发生。

官方依据：[CVM SDK 模型](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/cvm/v20170312/models.py)、[CVM API 方法](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/cvm/v20170312/cvm_client.py)、[实例角色](https://cloud.tencent.com/document/product/213/47668)。


客户端证书续期复用现有运维入口和运行状态上报。控制端按同一已完成 Run/Start 操作提前六小时发行新叶证书，固定私有 vault/SSM 版本先持久化派发标记；不确定写入只精确回读，禁止重发。CN 保持 instance:epoch，SAN URI 绑定账号、地域、实例、epoch、operation SHA-256 和云 ACK SHA-256。节点安装前验证全部绑定；旧证书过期只关闭新领取，不阻止取回合法替代证书。

本地 transport 服务将两服务的刷新请求串行化。证书落盘后必须收到原生 stunnel 配置成功确认，再验证全新 PG 连接；换证或确认失败维持禁止新领取，后续继续尝试确认，不用磁盘 hash 或相同 SQL 身份推断内存证书。SIGHUP 保留已建连接。transport unit 必须包含 AF_UNIX，并保持 static；暖启动只能在 bootstrap 安装当前 epoch 证书后启动。未知 unit 或活跃旧代际拒绝安装和新容量，不强制重启消费者。

新源凭据只由根权限控制服务读取 `/etc/bondbuddy/execution-control/source-credentials.json`，父目录 root:root/0700、文件 root:root/0600，JSON 严格为 secretId、secretKey。source signer 仅允许 AssumeRole 到固定控制角色；取得短 STS 后校验 AccountId、roleId:sessionName 和 PrincipalId。业务运维进程通过 `/run/bondbuddy/elastic-control/issuer.sock` 取得短 STS，不挂载长效源文件或 CA 私钥。独立签发服务使用 PG 只读操作/费用接口及准确云回读授权签发，私钥留在本地根权限目录。当前接入只准独立隔离数据库，正式数据库迁移和策略开启需要各自验收。

运维入口共享持久 flock/时间前像，至少 60 秒才能开始下一次云协调，进程退出不重置调用间隔。启动入口必须在任何 SSM 请求前取得跨重启保留的 60 秒锁和时间前像，持锁覆盖全部握手；每个节点分别受限，普通故障或手动重启不能绕开。调用费用采用下述跨日报价的完整版本扫描上界，另叠加管理调用和已花费用。只有一次性服务或持久 enable 不能证明此频控成立；必须绑定准确启动代码及跨进程、时钟回拨和重建反例证据。当前 role 的 Get/Put 授权不能替代 ListSecretVersionIds/DeleteSecretVersion；版本清理授权不足将安全关闭发行。

报价需明确 secret 与 snapshot 两项固定未决义务，保留到真实对账证据解除；自然日变化不能清零。2026 年 11 月 15 日计算加两盘报价为单节点 0.91 元/小时、双节点 1.82 元/小时，准确停算力后双节点磁盘为 0.22 元/小时。SSM 和自制镜像快照费用另行完整预留；未知快照字节/费率禁止新增支出。主站套餐余量只能支持有效到当日北京时间 24:00 的网络报价，不代表永久免费。自动长期模式还须绑定运行状态刷新消费、旧会话继续、新 TLS/PG 成功和模型 socket 拒绝的准确版本证据。

小时总费用上限允许四元，计算双节点 1.6 元与自然日总额 48 元仍保持。当前主站 5Mbps 的物理上界与有限当日套餐余量用于网络报价，不人为激活每节点 1Mbps 限速。

容器保持 `/run/bondbuddy/service/transport.sock` 路径，但只挂载宿主专用 `/run/bondbuddy/transport-socket` 目录；该目录只允许 socket，绝不包含 service env 或 key。重启 transport 后新 inode 会在同一个容器内可见。两个根权限 unit 通过 RuntimeDirectory/Group 1000/0750 创建冷启动目录，并保留目录以便代码拒绝未知残留，不自动删除未知内容。


## 自动阶段停至零台

单节点／双节点验证阶段保持 `min_running=1`，正式自动配置使用 `phase=automatic, min_running=0`。无达到等待阈值的有效独立积压时，空池不创建或启动实例；共享计划等待、业务材料缺项和预算关闭不构成扩容需求。达到阈值且全群／费用准入有效时，优先暖启动已停止实例，否则按原不可变请求创建一台。

最后一台执行节点可以在有效积压为零、正向零租约／模型活动且空闲已达到阈值后开始排空。排空继续沿用既有租约和成果保存；只有全部服务正向完成回执、零 holder／子进程／未提交成果的完整 proof 才能 dispatch Stop。随后必须按原 ACK 核实 SUCCESS、STOPPED 和 STOP_CHARGING。失联、过期和费用关闭本身不能充当停机证明；费用关闭仅禁新领取并请求正常排空。网站、唯一数据库和原有执行端保持原范围。

零台自动池不再预约一台计算至自然日末。历史实际运行、启动前等待、未决 Run／Start／Stop、停止后的磁盘及 SSM／快照完整负债仍计入，并保留两槽安全排空和下一次启动预约。计算池 1.6 元／小时、整机总上限 4 元／小时、周期 48 元、最多两台同时受约束。双节点性能验收先保持全群 4；单节点安全验收及供应商／预算审核通过后显式提高全群至 8、每节点 4，并覆盖同一数据库内全部消费者，不承诺固定速度倍数。

## 同一镜像的两套节点身份

镜像只含公共共享配置和两套非敏感 `node_slots` 模板。公开启动 manifest 的 `slot_binding` 固定 role 名称、role ID 和 Secret 名称，并与 CamRoleName 一同进入完整 launch hash。入口把同一个 manifest 交给配置选择器，必须唯一逐字匹配预装模板；配置选择不代替 STS、准确 Describe 角色／原 ACK、独占 Secret、PG operation／epoch 和准入校验。未知、多匹配和交叉 Secret 不回退。

## 受限私网出口

节点仅连主站私网的数据库、初始化代理与 mTLS 代理。初始化代理仅允许精确域名的 443 CONNECT；运行阶段通过同代际客户端证书连接 `proxy-execution.internal`，继续校验目标站点自身 TLS。Node 22 使用官方 `NODE_USE_ENV_PROXY`，link-local metadata、本机与私网数据库走 NO_PROXY。受控 stunnel 配置由单一 renderer 生成并逐字验证，禁止夹带额外监听段。主站共享 5Mbps 物理出口，不附加单节点 1Mbps 限流。独立构建源的临时额外域名只允许准确 builder 私网 IP，验通后使用、退役时移除，不扩大业务节点出口。
# 跨日报价刷新（#1389）

自动 tick 和手动入口共用既有控制锁及一分钟调用边界，在预算同步前读取受限控制角色的 Lighthouse 实例与流量包。只接受约定账户、地域、实例、套餐和 5 Mbps 整机出口上界。流量余量按字节核验，必须覆盖观测至北京时间当天结束的**全部主站出站**最坏流量；不只计算执行池，不跨流量包结束时间借用下一期额度。新周期必须由真实 API 返回，并与上一周期边界一致。

原 `cloud_quote_file` 和 `quote_sha256` 保持为已审价格模板；配置可增加 `cloud_quote_refresh`：

```json
{
  "version": "lighthouse-quote-refresh-v1",
  "instance_id": "REVIEWED_LIGHTHOUSE_INSTANCE",
  "bundle_id": "REVIEWED_CURRENT_BUNDLE",
  "bandwidth_mbps": 5,
  "traffic_package_total_bytes": 536870912000,
  "pricing_valid_until": "REVIEWED_TARIFF_EVIDENCE_EXPIRY",
  "snapshot_file": "REGISTRATION_DIRECTORY/cloud-quote-snapshot.json"
}
```

`pricing_valid_until` 是单价材料独立复核后的有效期，不能照抄下一天日期来延长旧报价。缺少完整价格证据时保留关闭状态。快照保留原六项费率证据、SSM 月费及两张快照完整负债，并核 `222*N+264` 次 SSM 调用费用上界：两节点续期每分钟最多 68 次、心跳版本扫描最多 22 次，两个节点**各自**启动最多 N+2 次，每次最多 6 轮、每轮 List 1 次及 Get 最多 10 次，单次握手总截止 180 秒。N 是采样至日末的实际分钟数向上取整，包含普通故障和手动重启；该上界依赖上述持久启动门和六轮握手，未合入并验证前不能称为已强制上界。旧 `94*N+48` 的低预留不能代替新分支；`354*N+528` 或 `618*N+1056` 属更保守的预留，仍需满足相同预算和价格门禁。

全天 N=1440 时共 319944 次 API 请求，按每万次向上取整、每万次 0.4 元计为 12.8 元；另加六元 SSM 整月义务和十二元快照义务，至少 30.8 元。还需纳入计算、磁盘、网络、管理调用及已花费用，不能由公式测试通过推断长期自动准入可用。换日不清零固定承诺，也不以缺少账单为零费用。小时上限 4 元、自然日上限 48 元保持；不足时禁止新增，原任务与正向排空继续。

发布只替换一个私有 JSON 快照，内含有效配置、报价及观测证据。消费者校验源配置哈希和报价哈希；不分别改写两个文件。模板或配置漂移、时间回拨、套餐到期/不足、API 错误、发布中断及超时均关闭新增准入；原任务、结果持久化、未知调用恢复和正向排空继续。超时工作不能迟到发布，也不能在未决查询结束前重复请求。同一分钟内重复费用检查仅复用刚发布且已覆盖整机余量的快照。

控制角色仅需 `lighthouse:DescribeInstances` 与 `lighthouse:DescribeInstancesTrafficPackages`。前者官方 CAM 支持的实例查询范围为地域内 `instance/*`；后者绑定约定实例资源。客户端额外固定账户、地域和准确实例，不能把 API 支持的地域级权限说成 IAM 的单实例隔离。新私网代理仅增加 `lighthouse.tencentcloudapi.com` 的 CONNECT/443 出口，保留原代理与其它服务。
