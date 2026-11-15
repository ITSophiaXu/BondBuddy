# #1361 首次创建与私网接入物料

状态：可审字段清单，尚未 apply。本文不含真实账户、内网地址、凭据或身份私钥；尖括号值必须由受信控制入口在本地安全渲染并验证。任何必需项缺失时，自动创建保持 disabled。实现契约见 [腾讯按量执行池](tencent-execution-pool.md)。

## 文件及修改归属

| 路径 | 用途和状态 |
| --- | --- |
| `deploy/tencent-elasticity/pool.example.json` | 腾讯适配模块的公开配置模板，默认 disabled；实际私有值不提交 |
| `deploy/tencent-elasticity/tencent-cvm.mjs` | 准确 CVM Run/Start/Stop/Describe 请求与安全证据归档 |
| `deploy/tencent-elasticity/ops-handler.mjs` | 同模块正在实现的 `createExecutionPoolOpsHandler`，接既有运维周期；未接通不能称自动运行 |
| `apps/worker/src/ops-scheduler.ts` | 数据与运行时模块独占修改，启动/既有 tick/重启恢复接线 |
| `deploy/tencent-elasticity/bootstrap.mjs`、`bootstrap.service`、`compose.yaml` | 公共启动逻辑、独立登记和服务能力模板；真实 broker/runtime adapter 必须实现并验收 |
| 本文的网络/IAM/secret 表 | 云控制审查输入；腾讯适配模块可据此生成其模块内准确材料，不复制共享数据库 DTO |

## 网络与数据库入口

| 字段 | 审查值/约束 |
| --- | --- |
| Region / Zone | `ap-beijing` / `ap-beijing-7` |
| VPC / Subnet / CIDR | `<APPROVED_VPC_ID>`、`<APPROVED_SUBNET_ID>`、`<NON_OVERLAPPING_CIDR>`；记录现有网络关联与路由前像 |
| Lighthouse CCN 关联 | `<APPROVED_CCN_ID>` 与原 Lighthouse VPC 关联；同账号同地域，不解绑现有连接 |
| 节点业务入口 | 不开放入站业务端口或明文 PG；管理入口按现有受信运维方式限制 |
| 私网 PG TLS 监听 | `<PG_TLS_BIND_PRIVATE_ADDRESS>:<PG_TLS_PORT>`；独立监听，后端 `<EXISTING_PG_LOOPBACK_ENDPOINT>`，不修改唯一 PG 的对外监听 |
| 节点 pg_endpoint | `<PRIVATE_TLS_SERVER_NAME>:<PG_TLS_PORT>`，解析到上述私网入口；不得仅填写 CCN 可达地址 |
| 服务端信任 | `<PG_TLS_SERVER_NAME>` 必须匹配证书 SAN；固定可信 CA/证书指纹，禁止 verify=false |
| 客户端身份 | 每节点独立证书和 PG 业务凭据，按获审节点身份发行、可单独撤销；私钥在对应端本地产生 |
| 来源限制 | 仅该池准确节点私网来源/安全组；主站受限监听与主机规则另有准确前像和回滚 |
| 实际 PG 验收 | 受控身份 SELECT 确认为原唯一数据库、有界真实 SQL 与队列路径；保存身份/耗时/结果完整性元数据，不输出业务行 |
| 外部出口 | `<APPROVED_PROVIDER_AND_BLOB_EGRESS>` 及计费方式；公网带宽为 0 时仍需已有可用出口，否则不能 ready；不得隐式创建 NAT |

顺序：核网络关联 → 私网 TLS 入口配置审查 → 先证未认证客户端被拒绝且上游 PG 未连接 → 合法节点验证 mTLS/PG 身份与真实 SQL → bootstrap 允许 ready。路由或 TCP 监听健康不能跳过 SQL。旧诊断公网监听/安全组临时规则不沿用。

网段选择需额外校准官方文档差异：[CreateVpc API](https://cloud.tencent.com/document/product/215/15774) 的字段说明及 SDK 写 `10.0.0.0/12`，而[控制台操作指南](https://cloud.tencent.com/document/product/215/36515) 写整个 `10.0.0.0–10.255.255.255`、掩码 12–28。首版选两份文档共同允许且实际无重叠的网段，不把未调用验证的范围写成 API 已通过。CreateVpc、CreateSubnet、CreateSecurityGroup 请求未声明 ClientToken；结果不明时先查准确创建记录，不套用 CVM RunInstances 的 token 契约盲重试。

## IAM 和 secret 发行

| 身份 | 最小权限和发行边界 |
| --- | --- |
| 云控制调用者 | 独立短期服务身份；只操作获审执行池的 CVM，必要 `RunInstances`、`StartInstances`、`StopInstances`、`DescribeInstances`，以及 `GetCallerIdentity` 和账单只读；首版不授自动销毁/重装或 AS 替换能力 |
| 节点 A / B 角色 | 两个不同 `CamRoleName`，角色载体为 `cvm.qcloud.com`；每节点只读自己的 bootstrap/business secret 版本与必要制品，不授 Run/Stop、CAM 管理、读取另一节点 secret |
| 注册发行者 | 仅在可信 Describe 与本次创建/启动完成后，绑定 account/region/instance/epoch、准确角色槽位、镜像/启动 manifest hash 和服务集合；向该节点独立 secret 写入短期登记材料，并在 PG 保存对应校验摘要 |
| PG / 模型业务身份 | 每节点独立业务授权，不是云控制 CAM 身份或个人开发登录；供应商账户费用上限仍全群共享 |

实际 CAM policy 的 Resource 必须按该产品官方资源级授权格式及准确资源 ID 渲染；模板不猜 QCS ARN，不以 `Resource=*` 代替可收窄的 secret 权限。RunInstances 等创建前没有实例 ID 的动作，须核官方支持的地域/标签/角色等条件，并由同一控制入口核准参数和双节点保有量；不得伪称所有创建字段都能由 CAM 条件独立限制。无法表达的限制必须由已验参数/CAS 门守住，保留审查前像。

官方 SSM `2019-09-23` 的 `GetSecretValue` 请求为 `{SecretName, VersionId}`，返回文本 `SecretString` 或 Base64 `SecretBinary`，二者最多一个非空。采用该节点获审的独立 secret 和固定发行版本；不得将另一节点 secret 命名成自己的，也不得无界读取全部版本。云产品“当前轮转版本”的 `SSM_Current` 语义不自动等于本业务登记代次。

`PutSecretValue` 仅对用户自定义 secret 增加版本，最多 10 个版本；VersionId 最长 64 字节、字母/数字起首，其余允许字母/数字及 `-_.`，且没有 ClientToken。官方未承诺重复同版本写入幂等：发行者先持久化固定 operation/version 与内容，再精确 Get 读取目标版本；已存在且内存内容校验一致才复用，不同则拒绝。Put 返回不明也读同一版本确认，不另造新 token 或版本。旧版本清理必须先排除在途启动、回滚与未决操作引用，不能为腾版本删除仍被节点使用的凭据。获取返回的 SecretName/VersionId 必须匹配明确请求，不能假设 `SSM_Current` 会解析成某个自定义 operation ID。

官方 STS `2018-08-13` 的 `GetCallerIdentity.AccountId` 是所属主账号，角色 `UserId` 为 `roleId:roleSessionName`；它不是实例 ID。实例 metadata 提供周期更新的角色临时凭据，只作本机获取服务权限和一致性核查，不能单独授权业务注册。secret 值、临时密钥和 PG 密码只进入内存或 0600 运行文件，不进入 UserData、镜像、日志或本文。

必须验收：A 角色读取 A 的准确版本成功、读取 B 被拒绝；过期/旧 epoch 登记失败；未绑定云实例或错误角色/manifest 不能 ready；启动 material 不能覆盖持久 operation 中的请求和角色槽位。受控停机完成前不能发行下一 epoch。

## 创建参数与费用准入

首台 `RunInstances` 必需：`InstanceCount=1`、`InstanceChargeType=POSTPAID_BY_HOUR`、`SA9.LARGE16`、固定已验 ImageId、全云盘类型/容量、VPC/subnet/security group、准确节点角色、仅公共 UserData、稳定 `ClientToken` 和完整 launch manifest hash。镜像中不含个人或业务认证。第二台优先启动已有停止备用；所有 stopped/lost/starting 和未决创建计入最多两台。

工程默认（可配置，并非新增用户预算承诺）：计算报价 0.8 CNY/台小时，池计算上限 1.6 CNY/小时，整池含非计算项小时估算上限 2.4 CNY，日周期新增支出准入上限 48 CNY。须补 `<CURRENT_DISK_QUOTE>`、`<EGRESS_QUOTE>`、`<OTHER_SERVICE_QUOTE>`、预算时区/期间、账单观察水位、已花/估算/未决 reservation 的去重规则及安全排空余量。模型沿用既有费用账本和默认全群四路，不新增每日用户测试上限。

Billing `2018-07-09` 的 `DescribeBillSummaryByTag` 按同月 `BeginTime/EndTime`、`TagKey/TagValue` 汇总；`DescribeBillDetail` 按 `Month`、`PeriodType`、准确 `ResourceId` 分页，`Limit≤300`。整月/滞后账单不能当实时日费用闸门，费用为空不能视为零。标签辅助关联，资源归属与计费期间仍逐项核对；停止后云盘和选定网络/镜像费用继续计入。

## 首次创建前的清理与回滚材料

- 列出将创建/修改的准确资源及其当前不存在/现有前像，记录云操作 reservation、ClientToken、manifest hash；不把别的项目资源算成本池库存。
- 首台创建失败或结果不明时保留 reservation 并查询，不更换 token 重建、不自动创建替代第三台；新节点未 ready 就不领取业务任务。
- 新网络规则、私网 TLS 监听、证书/secret 与角色绑定分别有准确撤回步骤；只能撤回本次资源，不能整份覆盖现有规则或解绑别人已有的 CCN。
- 实例已运行后按 drain proof → PG tombstone → `StopType=SOFT, StoppedMode=STOP_CHARGING` → 精确 `LatestOperationRequestId` / STOPPED / Stop SUCCESS 验证；若不能关联保持 unknown。首次停费验收与自动策略启用分阶段，不能要求尚未创建过的节点预先具有真实停费回执。
- 停机不等于释放云盘/全部费用。确需销毁本次孤立失败资源时先核无任务/唯一成果、精确归属与账单影响，另走获授权清理，不提供自动 destroy 旁路。

官方来源：[CVM 实例角色](https://cloud.tencent.com/document/product/213/47668)、[SSM 请求契约](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/ssm/v20190923/models.py)、[STS 身份契约](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/sts/v20180813/models.py)、[Billing 请求契约](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/billing/v20180709/models.py)、[Lighthouse 内网互联](https://cloud.tencent.com/document/product/1207/56847)、[CVM 停机计费](https://cloud.tencent.com/document/product/213/19918)。
