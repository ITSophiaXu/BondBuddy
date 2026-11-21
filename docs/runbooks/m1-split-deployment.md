# 主站与执行端独立发布（#907、#911）

> 2026-11-17（#994）：按调用模式核对实际 Codex 参数。文件编制首次及恢复均配置 `model_auto_compact_token_limit=128000`，并使用固定续跑与压缩交接指令；结构化调用配置 `900000`，两者声明窗口均为 `1000000`。下文迁移及复核容量记录中的900K不是当前文件编制阈值。128k是本地工作策略，供应商真实上下文能力与大PDF交付另以实际调用和成果验收为证，见[文件编制验证](../verification/copilot-file-authoring-20261117.md)。

第一阶段：腾讯云主站运行网页、API、唯一业务 PostgreSQL 与必要运维；原 Azure 业务机器运行编制、复核；当前迁移布局由主站运行纯解析。继续使用 PG 队列与原私有 Azure Blob。无新增 HTTP 执行协议、批内并发、价格、状态机、模型、认证或页面变更。双端迁移已由 #906/#908 完成；本 #911 的普通生命周期采纳与验收另行执行，隔离检查不冒充这次采纳验收。

## 角色与入口

任务级重试屏障的受限 cgroup 启动边界、既有节点／未来模板迁移及未完成的发布检查见
[任务级原生退出证明](../../deploy/tencent-elasticity/task-cgroups.md)。该实现尚未部署；
主站发布、旧节点仍在线或镜像存在均不能代替执行节点实际采纳证据。

| 角色 | Compose | 常驻服务 | 单次服务 |
| --- | --- | --- | --- |
| `main` | `deploy/m1/compose.main.yaml` | `postgres/api/ops/egress/web`，`BB_PARSE_ROLE=main` 时加 `worker-parse` | `migrate`，仅主站运行 |
| `execution` | `deploy/m1/compose.execution.yaml` | `worker/worker-review/egress/pg-tunnel`；仅 `BB_PARSE_ROLE=execution` 时加 `worker-parse` | 无迁移或本地 PG |
| 诚信核查 | 执行端按 `BB_INTEGRITY_MODE=beijing` 追加现有 `compose.integrity-beijing.yaml` | `integrity-beijing-tunnel`，保留原国内出口与浏览器配置 | 不启动 Azure 直出代理 |

两端从同一准确发布提交构建、加载镜像，首次切换必须同版。后续仅在确认数据库迁移向后兼容、队列/checkpoint/provider结果格式兼容后独立发布；不得仅凭健康检查认定兼容。共用环境策略从原 Compose 继承，主站用 `BB_MAIN_DATABASE_URL`（主机名 `postgres`、密码经URL编码）与原文 `POSTGRES_PASSWORD` 分别配置连接和PG账号；执行端用固定的 `BB_EXECUTION_DATABASE_URL` 覆盖连接；不需要主站的 `POSTGRES_PASSWORD`。包装入口仅为旧配置未使用的插值提供无效占位值，不创建本地 PG。

在构建环境准备归档，在各部署环境使用现有安全传输与 `docker load`：

```sh
bash deploy/m1/scripts/export-images-role.sh main <git-sha> <main-images.tar.gz>
bash deploy/m1/scripts/export-images-role.sh execution <git-sha> <execution-images.tar.gz> beijing
# 以下命令分别在对应部署环境执行。私有 env 不入库，不打印 config 或容器完整环境。
BB_ENV_FILE=<main-private-env> bash deploy/m1/scripts/deploy-role.sh main <git-sha>
BB_ENV_FILE=<execution-private-env> bash deploy/m1/scripts/deploy-role.sh execution <git-sha>
```

构建环境若没有可用默认bridge，可为镜像准备命令显式设置 `BB_BUILD_NETWORK=host`，只影响该次构建，不修改daemon。构建前核实 Docker 数据盘、源码归档、依赖/浏览器镜像和输出镜像归档所需空间，至少保留既有部署要求的 4GiB 构建余量，另计归档实际大小；目标环境复用预装镜像，至少保留 2.5GiB，迁移备份、恢复空间另计。构建归档不包含 env、支付文件或模板原件。发布入口只使用预装准确 SHA 镜像，拒绝来源标签 `org.opencontainers.image.revision` 不匹配完整提交的镜像；启动后核对实际容器的不可变 image ID，写入角色状态目录的 `images-<tag>.txt`。不能仅凭可漂移的tag或环境字段认定版本。不自动清理其他镜像、不做备份、不安装定时任务。旧同版模式仍要求部署目录与应用提交一致；独立配置版本见下节。每端独立保存 `state-main` / `state-execution` 的版本和部署锁；锁仅覆盖对应角色，不冻结其他环境。首次使用单独的项目名称，不能把旧同机项目当作可自动删除的孤儿。

只读展开、检查和运维入口：

```sh
BB_ENV_FILE=<private-env> BB_IMAGE_TAG=<sha-first-12> bash deploy/m1/scripts/role-compose.sh main config --quiet
BB_ENV_FILE=<private-env> BB_IMAGE_TAG=<sha-first-12> bash deploy/m1/scripts/role-compose.sh execution config --services
BB_ENV_FILE=<private-env> bash deploy/m1/scripts/role-compose.sh execution ps
```

模板见 `.env.main.example`、`.env.execution.example`：仅补角色字段，保留原收费开关、Blob、模型、Provider、认证、超时、条款及出口白名单。不要把示例占位值用于生产。业务 Codex 的**模型目录和真实执行参数继续固定 1000000 窗口、900000 压缩**；本次将 Dockerfile 的业务 CLI 最小更新到已核对的官方稳定版0.167.0及官方包校验值，并添加来源标签；保留业务适配器参数和模型目录契约。验收实际 `token_count.info.model_context_window=1000000`，不是只看目录。业务窗口与开发环境窗口各自独立。

`execution` 的编制、复核及放置于该端的解析服务默认 `BB_WORKER_LEASE_SECONDS=120`，为跨云 PG 续租留出余量；可在执行端私有 env 中覆盖为 5–600 的整数秒，未设置或空值均使用 120。现有续租调度为租约的 40%，120 秒租约对应约 48 秒续租间隔。旧同机 Compose 不新增此参数，全局运行时默认仍为 30 秒，三组执行服务并发仍各为 1。该参数不改变 SIGTERM 排空时限；切换前仍须核实在途调用。

## 私有覆盖、解析放置与独立配置版本（#911）

普通 `deploy-role.sh`、`role-compose.sh` 的重建/探测及上述应用回滚统一读取同一私有 env：

| 字段 | 契约 |
| --- | --- |
| `BB_ROLE_OVERRIDE_FILE` | 一份环境覆盖的绝对路径；在角色与诚信 Compose 之后自动追加 |
| `BB_ROLE_OVERRIDE_SHA256` | 覆盖文件原字节的小写 64 位 SHA-256；与路径成对设置 |
| `BB_ROLE_STATE_DIR` | 覆盖环境必填：既有角色状态目录绝对路径，跨 checkout 沿用；进程 `BB_STATE_DIR` 如设置必须与它一致 |
| `BB_PARSE_ROLE` | `main` 或 `execution`；有覆盖时必填，两端一致；无覆盖且未接管的旧角色默认 `execution` |
| `BB_DEPLOY_SCRIPT_SHA` | 当前干净部署目录的完整 40 位 Git 提交；与应用 SHA 分别固定 |

对当前迁移布局，两端均设 `BB_PARSE_ROLE=main`。主站纯 parser 只领取 parse、并发 1、租约 120 秒、0.5 CPU/1 GiB，直连 internal `postgres`；仅挂解析暂存卷，不继承模型凭据或模型环境。执行端 parser 通过 inactive profile **及 replicas=0** 停用，发布时不启动、不要求它存在，并在在途 SQL 门禁之后停止遗留 parser、检查其未运行。主站 parser 已内置；原私有覆盖中重复的 parser 定义应删除，或确保保持相同纯解析契约，不能再继承模型凭据。

PG 专用桥接可按 `deploy/m1/compose.pg-loopback.example.yaml` 整理到私有覆盖；保留已有 PG 参数、项目名称、唯一 pgdata、模板/支付/上传暂存及其他已核配置。PG 只连接业务 internal 网络与专用桥接；桥接关闭 masquerade，不能让 API/解析/其他容器加入。回环端口仍只绑定 127.0.0.1。此覆盖解决特定 Docker 环境的 internal-only PG 回环发布不通；声明端口、SSH监听或 Compose 渲染均不能替代真实认证 SQL。

```sh
# 私有文件保持受保护，不入库；校验和可写回私有 env。
sha256sum <private-role-override>
BB_ENV_FILE=<private-env> BB_IMAGE_TAG=<app-sha-first-12> bash deploy/m1/scripts/role-compose.sh main config --quiet
BB_ENV_FILE=<private-env> BB_IMAGE_TAG=<app-sha-first-12> bash deploy/m1/scripts/role-compose.sh main probe connect
BB_ENV_FILE=<private-env> bash deploy/m1/scripts/deploy-role.sh main <exact-app-sha>
```

应用镜像参数永远指真实应用源提交；仅升级这些部署脚本时，在已从可信 `origin` 获取的准确脚本提交上设置 `BB_DEPLOY_SCRIPT_SHA`，继续使用现有真实应用 SHA 镜像，无需重新打 tag 或构建应用。两种提交均须可从指定 BondBuddy `origin` 的已获取历史到达；脚本 checkout 必须等于 pin，`deploy/m1` 不得有已修改或未跟踪部署文件。缺 pin 时保留旧的“部署目录等于应用 SHA”检查，不提供忽略来源或 dirty 配置的开关。镜像导出仍按**应用 SHA**复用匹配标签的镜像，全部已存在时不创建源码归档/构建上下文。

入口禁止调用者增加 `-f/--file`、`--env-file`、项目/目录/profile/scale 改写和 `COMPOSE_*` 进程环境。`COMPOSE_PROJECT_NAME` 只能在私有 env 配置。Compose 插值优先采用该文件，进程中的业务环境变量不能替换数据库等配置。私有 env 始终按数据读取，绝不 source；校验中的真实配置只通过内部管道处理，不打印完整展开或连接细节。运行环境需有 Node.js 22、Git、Docker Compose 与 flock。

首次使用有效覆盖时，角色状态目录持久化 `environment-binding.json`，固定私有 env 的真实路径、项目名称、覆盖路径/hash、解析位置、数据库连接摘要与诚信模式；主站在同一原子绑定中保存准确 `pg_volume` 定义；已存在的旧 `pg-volume.json` 仍严格核对。后续漏掉覆盖、换回旧 env 或改变绑定直接拒绝，缺文件/hash、hash 不符均在 Docker 调用前拒绝；不允许旧整栈脚本绕过已绑定状态。保留同一状态目录、原子绑定及已有的旧卷绑定文件；发布还检查实际 Compose 项目容器，既有项目缺少 `current` 时，发布及普通生命周期变更均拒绝首发假设，必须承接已核实的版本状态；现有仅 `current`、无 previous/images/配置收据的状态可承接：先逐个检查实际运行镜像完整 source label 与 current tag、可信来源和不可变 ID 一致，再执行原只读在途 SQL 门禁，不补造旧收据；主站在每次操作前检查既有 PG 容器的实际数据卷就是被绑定的同一卷。不得通过另建状态目录、删除绑定、改变项目名称来执行日常发布或回滚。首次接管本身不迁移或恢复 PG 数据，必须先核对唯一卷就是既有卷。

若确需改变网络/解析放置/数据库身份等绑定，在维护状态下先核实无在途调用，保存原私有 env、覆盖、状态绑定及其 hash，独立审查目标配置和恢复路径；再明确更新受保护绑定并用普通入口重新验证。脚本不会自行删除或降级绑定。脚本 pin 或应用版本更新不需更改拓扑绑定。本 #911 负责后续统一入口的采纳与验收，不复开已完成的 #908；CI/自动整栈发布暂停策略不变。

## 复核容量配置（#1303）

执行角色的复核并发、Node 堆及容器配额可以在受保护私有 env 中分别设置
`BB_REVIEW_WORKER_CONCURRENCY`、`BB_REVIEW_NODE_HEAP_MIB`、`BB_REVIEW_CPU_LIMIT`、
`BB_REVIEW_MEMORY_LIMIT`。默认仍为 `1`、`768`、`0.75`、`2G`；不改变编制、解析或
confirmation 配置。最后加载的私有覆盖可能覆盖这些值，验收必须检查渲染配置和实际
容器，不能只检查 env。旧整栈生产配置不使用新增的复核资源参数。
角色入口在完整渲染后、停止或重建旧容器前预检复核配额：并发必须为 `1`–`16` 的
整数，Node 参数必须仅含严格正整数 `--max-old-space-size`，CPU 和内存必须为正且
有限的配额；零值（Docker 无限制语义）、负值和注入文本均拒绝。升级前还要核对私有
env 中原 `BB_REVIEW_WORKER_CONCURRENCY`，旧硬编码可能曾掩盖非默认值；不能借升级
配置入口意外提高并发。

四项复核的待测配额为并发 `4`、Node 堆 `2048` MiB、CPU `1.0`、共享内存 `6G`。
两核执行机器上保留编制现有一核配额；四槽共享六 GiB，而不是每槽六 GiB。
Node 堆之外还要计入 CLI、Python、Buffer 和 tmpfs。隔离验收和最终私有覆盖应将
`/tmp` 显式限为 1536 MiB；材料暂存仍使用磁盘卷。这些数值是候选配置，须通过下述
同机真实容量验收后才能应用。

1. 先保存真实镜像 ID、完整源码标签、各服务容器 ID、运行配置与私有文件字节 hash，
   核对磁盘/内存增量预算以及现有部署锁、`current`、`pending-release.json` 和绑定。
   存在未解决的部署 pending 或未知漂移时拒绝切换；不删除绑定另起部署入口。
2. 使用同一运行镜像，在独立测试数据库、队列、端口、暂存卷及 cgroup 中提交四个
   独立项目的完整复核。合成输入明确标注，至少一项包含代表性大文件；使用真实业务
   模型和既有认证，不向生产队列写测试，也不复用其他验收容器。
3. 保留四项租约同时领取、真实 CLI 进程重叠及独立 attempt/CODEX_HOME 的证据；
   核四项终态、各项目成果归属、下载及 SHA-256。记录模型真实 usage、实际 1M 窗口、
   900K 压缩参数、总耗时，以及共享 cgroup 内存峰值、CPU、tmpfs 和磁盘峰值。
   模型失败、限流及 unknown 结果如实记录，不能冒充通过或自动重投。
4. 配置差异及准确版本容量证据经独立审查后，在同一受保护部署锁内备份完整前像，
   核目标复核 run/message 租约和实际模型进程已排空。运行时 drain 超时可能 abort，
   不能以等待固定时长代替排空检查。只以 `--no-deps` 重建复核执行服务。
5. 验证并发和全部配额实际生效，编制、confirmation、隧道及主站健康/容器 ID 保持。
   失败时在同一锁内恢复私有 env、覆盖及绑定的原字节，只重建复核到同一镜像、
   并发 1 / 0.75 CPU / 2 GiB / Node 堆 768 MiB，并复核租约与健康；保留 pending
   和失败证据，不将未完成调用自动重投。清理本次测试容器、数据和对象。

## 专用 SSH 转发契约

主站 PG 只发布 `127.0.0.1:${BB_PG_FORWARD_PORT:-15432}:5432`，不开放公网 5432 或 15432。仅允许专用 SSH 账号从执行端既有出口连接 SSH 端口。目标账号只允许本地转发至 `127.0.0.1:15432`，禁止 shell、PTY、远端转发、其他目标及认证代理转发；示例（按实际端口调整）：

```text
# sshd Match User 段
AllowTcpForwarding local
PermitOpen 127.0.0.1:15432
PermitTTY no
X11Forwarding no
AllowAgentForwarding no
# authorized_keys 单行的 options 前缀（后接专用公钥）
restrict,port-forwarding,permitopen="127.0.0.1:15432",command="/bin/false"
```

`ssh -N` 不请求 shell；强制命令只防止该密钥用于执行命令。使用目标环境专用服务密钥，不复制其他用途的身份。私钥由执行端隧道进程 UID 1000 可读，权限 0600、父目录 0700；只读挂载 `/run/pg-ssh/key`。可信通道核对的 known_hosts 只读挂载 `/run/pg-ssh/known_hosts`，非 22 端口使用 `[host]:port` 格式；不能把未核验的 `ssh-keyscan` 输出当信任依据。不存在的文件挂载直接失败，不自动创建目录。

| 字段 | 用途 |
| --- | --- |
| `BB_PG_SSH_HOST/PORT/USER` | SSH 目标与专用转发账号 |
| `BB_PG_SSH_KEY_FILE` | 执行端专用私钥绝对路径 |
| `BB_PG_SSH_KNOWN_HOSTS_FILE` | 已核验主机密钥文件绝对路径 |
| `BB_PG_FORWARD_PORT` | 主站回环映射端口；两端保持一致，默认 15432 |
| `BB_MAIN_DATABASE_URL` | 主站 API/migrate/ops 的 `postgresql://bondbuddy:<URL编码密码>@postgres:5432/bondbuddy` |
| `BB_EXECUTION_DATABASE_URL` | `postgresql://bondbuddy:<URL编码密码>@pg-tunnel:5432/bondbuddy` |

主站 `POSTGRES_PASSWORD` 保留原文；在私有Compose env里用单引号包裹，避免 `$` 插值。URL只对原文编码一次，不把编码串作为PG原密码。密码沿用标准 URL 编码：使用 `urllib.parse.quote(raw_password, safe="")`（不要手工替换字符），直接写入权限0600的私有 env，不向终端打印原值或编码值。隔离测试覆盖 `@ : # / ? % $ & = + !`，确认容器读回一致。

`pg-tunnel` 同时接入 `backend`（internal）和 `edge`，内部监听 5432，**没有主机端口映射**；执行容器仍只有 internal 网络。严格校验主机密钥、指定唯一身份、转发失败退出、15秒保活、断线重启。HTTP `egress:3128` 仍只处理原 Blob/模型/支付等出口，不能承载 PG；不放宽 Squid 到任意 TCP。隧道 TCP 健康只证明监听存在，发布前使用真实应用容器的只读 PG/schema 探测，防止远端不可达却误判健康。

诚信核查使用显式 `BB_INTEGRITY_MODE`：现有环境必须设置 `beijing`，角色入口自动追加原 `compose.integrity-beijing.yaml`，启动 `integrity-beijing-tunnel`，构建/导出对应 `bondbuddy-integrity-tunnel:<tag>`；worker 的代理URL为 `http://integrity-beijing-tunnel:3129`，同时保留该隧道和 `pg-tunnel` 依赖。保留现有 `BB_INTEGRITY_BEIJING_HOST` 与 `BB_INTEGRITY_SSH_DIR`，原专用目录只读挂载 `/run/ssh`（UID10001、目录0700、私钥0600、known_hosts0644），不与新的PG专用身份混用。不得把国内出口替换成Azure直出。

`direct` 明确选择原 `compose.integrity-browser.yaml` / `integrity-egress`，`disabled` 明确关闭该能力；这两个值不是迁移现有国内出口的默认选项，缺少模式直接拒绝。镜像导出的第四参数必须匹配执行端私有env中的模式。仍需单独核对现有授权/会话、allow-list和端到端公开检索；PG隧道不替代它们，配置渲染也不证明真实诚信核查完成。

## 切换与迁移边界

以下为 #907/#908 已完成迁移的操作边界记录；#911 不重新迁移数据库、不恢复日常备份或旧整栈发布。

1. 保持现有自动部署停用；双端入口接入并完成验收前不恢复。只冻结同一生产环境的冲突写入。记录旧版准确镜像、环境、挂载、PG/Blob位置和已应用迁移，保留可恢复版本。
2. 在维护入口关闭新任务、上传、助手与支付回调等写入；按既有产品维护方式实施，不改变收费逻辑。核实所有在途编制、复核、解析及助手调用、运行中容器/子进程和供应商调用记录。默认 SIGTERM 只排空 20秒（容器宽限30秒），**不能对长模型调用直接 stop**。等当前调用完成，未知调用先复核；无在途调用后才停止旧执行服务、旧 ops、旧 API/web，并再次核对没有写入进程。不能只等租约过期就认定远程调用结束。发布脚本对已登记旧角色的 running job/leased message 非零返回76，查询/连接失败返回77；该检查不能代替首次迁移的旧栈检查或维护入口。
3. 用户已停用日常备份，不恢复 cron/定期备份。本次单独创建迁移备份及恢复演练，保留校验和、准确版本、数据量与恢复证据。迁移冻结后对旧唯一业务 PG `pg_dump -Fc`；源盘余量不足时通过既有安全通道将标准输出直接流式落到目标环境的受保护临时文件，检查整条管道退出码后再校验和、改名，不在源盘生成完整dump。恢复演练也在目标隔离库运行。随后一次性导出/保护配置、支付证书及**全量私有不可变底稿模板包（包括非发布原件及目录结构）**，记录 SHA-256。上传暂存卷必须保留：等待在途上传完成再快照/转移，不能把重建空卷当保留。解析暂存按无在途任务确认后处理，不丢未知执行证据。Blob 不迁移，保持原私有容器、账号、对象权限和 hash；恢复演练只用隔离库/测试容器，不能对共享 Blob 做覆盖导入。
4. 先启动新主站 PG，向全新目标库恢复 dump，核对表行数、迁移记录及关键账务/任务关系，完成隔离恢复演练证据。执行端保持停止。仅主站入口运行 `migrate`，执行端 Compose 没有 postgres/migrate，`deploy-role.sh execution` 只检查目标 schema。迁移无并发执行者，失败即停止切换，不能跳过失败继续启动。
5. 主站发布成功后，API 和 ops 接同一新库；**API 创建后强制重建 web**，避免 nginx 缓存旧 API 地址。即使支付关闭，也须显式预建空的 `BB_PAYMENT_SECRETS_DIR` 目录并设置容器可读权限；支付启用时复制完整原证书文件并保持既有文件路径，不能用空目录冒充配置。主站保留支付只读挂载 `/run/bondbuddy-payments`、完整模板包 `/opt/bondbuddy/private-file-templates`、uploadspool 卷；模板包强制存在。与 `compose.file-templates.yaml` 使用相同挂载契约，主站配置已经包含它，不额外叠加创建 API 的覆盖文件。不能只看 `/health`。
6. 建立受限 SSH 转发，确认执行容器连接的是新唯一业务 PG，再运行执行端发布。确认编制、复核及所选解析位置的三组心跳、领取和续租、原 Blob 读写、业务 Codex 实际窗口、真实编制/复核/解析和诚信核查。旧 PG 保持停止且不再有消费者连接。受控恢复流量前核对支付证书加载/签验、模板列表/预览/实际底稿生成、上传/续传与原有文件下载；配置证书存在并不证明支付业务验收。
7. 比较版本与健康、就绪、审计和任务结果，按 #906/#908 记录直接证据。全程保持单一业务库和写入入口。新代码发布完成与生产迁移验收分别记录。

## 备份、恢复和回滚限制

旧 `backup.sh` 绑定同机 postgres 并导出 Blob，旧 `restore.sh` 会重启整个旧栈且覆盖 Blob；旧 `deploy.sh`、`rollback.sh` 也启动同机服务。**split env 设置 `BB_DEPLOY_ROLE` 后，这些旧入口全部拒绝执行**。不能为执行端准备一份旧式无角色 env 来绕过保护。

迁移一次性备份使用原旧栈的准确 PG 操作（冻结后，显式指定旧项目），目标恢复仅用主站角色的 PG 工具，例如：

```sh
BB_ENV_FILE=<main-private-env> BB_IMAGE_TAG=<sha-first-12> bash deploy/m1/scripts/role-compose.sh main up -d --wait postgres
BB_ENV_FILE=<main-private-env> BB_IMAGE_TAG=<sha-first-12> bash deploy/m1/scripts/role-compose.sh main exec -T postgres pg_restore -U bondbuddy -d bondbuddy --no-owner --exit-on-error < <verified-db.dump>
```

`pg_restore` 只用于核对过的**新空库**；不得直接覆盖当前活动库。恢复失败保持维护状态，不重启旧整栈。不要运行旧恢复脚本导入共享 Azure Blob。必要数据回退需先冻结并停止两端写入，备份新库，核对新产生账务/任务与对象，明确迁移兼容和数据合并方案后才恢复，不自动丢弃切换后的数据。

仅应用回滚：先维护入口、核实在途调用和 schema/队列兼容，选择已保留的兼容双端旧版镜像。使用**当前准确脚本版本和同一私有 env/覆盖/状态目录**，传入旧应用的完整 SHA：

```sh
BB_ENV_FILE=<main-private-env> bash deploy/m1/scripts/deploy-role.sh main <old-app-sha> --rollback
BB_ENV_FILE=<execution-private-env> bash deploy/m1/scripts/deploy-role.sh execution <old-app-sha> --rollback
```

该入口复用来源标签、实际 image ID、只读 SQL 与在途门禁；主站不启动或重建 PG、不运行 migrate，应用服务显式 `--no-deps`，API 后强制重建 web；执行端先等既有 PG/诚信隧道和出口就绪，再启动编制/复核及所选解析服务。不会要求非本角色的 parser 存在，不会误启执行端 parser。配置与当前 PG 卷的绑定保持不变，成功后记录应用 SHA、脚本 SHA/tree、覆盖 SHA-256 与镜像 ID。每次操作另存不可覆盖的 `release-<record>.txt` 和 `current-release` / `previous-release`，同一应用 tag 的配置更新也独立留证。此命令不恢复数据，也不判定 schema/checkpoint 格式向后兼容。

部分发布失败同样使用上面的普通 `--rollback`。首次 Docker 变更（包括 SQL 探测的单次容器）前，在既有状态目录原子保存非成功的 `pending-release.json`：完整 A/B source SHA、各服务不可变 image ID、计划 Compose hash、已核 A 运行配置 hash、环境/项目/覆盖及同一 PG 绑定。失败保留 pending 和原 current，不写成功；不把 B 的标签当作完成。pending 存在时拒绝新发布和低层生命周期改写，只允许普通 `--rollback` 指向已记录的 A/B 来源。恢复重新核定来源、标签/ID和原配置绑定，只接受各服务已核 A/B 混合或缺失，未知 C、漂移 ID、未知配置 hash 一律在 Docker 变更前拒绝，仍执行原在途 SQL 门禁。成功核验全部目标服务和 smoke 后才原子更新 current 并清 pending；不删/reset pending 或绑定来绕过保护。这不恢复 PG 数据，也不替代迁移向后兼容判断。

首次发布失败、尚无 current 时，仅允许 `pending.from` 为空且封存唯一目标的安全续执行：使用 `deploy-role.sh main|execution <sealed-target-sha> --rollback`，恢复原绑定的 PG/隧道、主站迁移和 schema 所需步骤，不冒充已有 A 的应用回滚。若已运行任何业务执行服务，先用封存目标执行在途 SQL 门禁，再进行基础设施和后续步骤；若没有消费者，先启动同一绑定的基础设施、验证认证 SQL/schema（主站按原新增迁移流程补齐），再执行 idle 门禁，之后才允许消费者启动或停止。连接/schema 失败不能当 idle；有在途拒绝且保留 pending。成功记录 `resume_first=1`，写 current 后清 pending。已有 A 的普通应用回滚仍不启动/重建 PG、不迁移。

只读 `logs --follow`、子命令后的 `logs -f` 在校验/必要首次采纳结束后释放配置锁；发布/重建仍保留同资源互斥。命令前 `-f`、任何 `--file/--env-file` 和项目/profile/scale 改写继续拒绝。PG 回环 published 端口必须与私有 `BB_PG_FORWARD_PORT` 一致，均为固定 1–65535，动态、0、范围或失配直接拒绝。首次采纳先检查现存实际 PG 卷，再原子提交含 PG 定义的绑定；失败不留下新绑定，纠正后正常重试。

`BB_ROLE_READONLY` 与 `BB_PENDING_COMMAND` 是入口内部标记，不能由外部环境解除写锁或 pending 保护；两个入口均先清零只读标记，普通 Compose 入口固定 pending 标记为 0，仅部署入口内部设为 1 并执行封存恢复核验。

回滚前后记录同一业务库和准确镜像。首次迁移若恢复流量前失败，可停止新两端、确认无新业务写入后回到旧冻结库与旧准确版本；恢复流量后不允许仅改连接字符串指回旧库。

最终统一验收待办：目标网络/密钥权限、真实恢复与完整资产迁移、支付签验与回调、模板及上传、真实模型1M窗口、三类任务与续租、真实诚信核查及旧库停用证据。隔离测试仅证明配置与合成行为。


## 隔离验证命令与边界

`node --test deploy/m1/scripts/split-deploy.test.mjs` 覆盖角色渲染、国内/直出模式互斥、两个隧道依赖、密码编码、资产挂载、旧脚本拒绝、发布在途门禁及镜像版本漂移拒绝。命令级替身仅检查脚本顺序，不代表真实部署。

`BB_SPLIT_TEST_RUNTIME_IMAGE=<verified-local-image-id> node deploy/m1/scripts/split-deploy.integration.mjs` 在本地Linux启动两套隔离Compose：完整主站API/ops/egress/web、PG16、受限SSH服务与执行容器；使用当前编译产物和合成模板，验证主站PG探测、Node22参数、空支付目录、完整模板包读取、上传暂存、队列领取/续租、运行时退出、一次性dump/restore、断库和错误主机密钥拒绝。执行前已有 `npm run build` 的产物及依赖；复用基础镜像必须先核对不可变ID。合成检查会创建并清理专属容器、卷、网络及临时密钥，不访问生产。当前临时构建网络使用host，不修改daemon。原诚信国内出口只做真实渲染回归，真实检索由最终发布验收执行。

Codex仅构建目标 `codex` 后，以断网容器运行 `deploy/m1/scripts/codex-business-runtime-smoke.mjs` 和既有 `apps/worker/test-fixtures/codex/completion-probe.mjs`：检查官方CLI实际版本、真实context事件、900K参数、目录工具回传和三种Stop续跑情形；供应商响应为本机合成服务。另运行 `node --test apps/worker/dist/codex-adapter.test.js`、`npm run check:contracts` 与 `bash deploy/m1/scripts/test-deploy-space-gate.sh`。这些检查不冒充真实供应商调用、完整候选发布镜像构建或生产验收；发布方必须基于最终准确SHA构建完整镜像并读回实际image ID。

`node deploy/m1/scripts/role-config.integration.mjs` 是 #911 的轻量合成验证：只用缓存 PG16/Node 镜像及小型专属 SSH 测试镜像，普通入口验证受限回环认证 SQL、专用桥接、跨网络受限 SSH、PG 重建后覆盖/同卷、非回环拒绝、inactive parser、实际测试镜像切换/回滚、在途和断库拒绝。测试不构建应用、不调用模型、不创建业务任务、不运行真实迁移或数据库恢复；合成最小表与测试容器/卷/网络/密钥用后清理。应用完整 `deploy-role.sh --rollback` 分支、来源/实际 ID 和版本分离由定向命令替身测试覆盖，不能据此声称线上应用回滚已验收。

`node --test deploy/m1/scripts/role-lifecycle-review.test.mjs` 针对上述五项审查回归：状态化 synthetic Docker 失败注入实际改变 A/B 服务 ID 并执行普通发布/回滚脚本，覆盖两端部分 B 失败、current 留 A、pending 保留、C/漂移拒绝、缺失服务恢复和同 PG/配置；同时检查首次采纳失败后纠正、非法端口、真实 Git 默认状态忽略/源码 dirty 拒绝，以及持续日志与写锁互斥。Compose 配置/hash 使用真实 CLI；容器行为为明确标注的合成命令模型，不冒充线上发布/回滚。既有 11 项真实隔离 PG/SSH SQL 证据可复用；后续 #911 采纳仍实际执行普通 deploy/rollback 入口。

首次恢复补充回归覆盖两端基础设施之前失败、已有部分消费者时失败、只接受唯一封存目标、SQL 在途拒绝/连接失败、普通入口续执行以及外部内部标记不能旁路 pending 或解除写锁；同时运行已改动的 `split-deploy.test.mjs` 25 项部署用例。


## 独立上传确认（#943）

`node apps/worker/dist/upload-confirmation-runtime.js` 只消费已有 `upload.complete_requested`，没有 run/parse 领取、扫描或模型调用。复用原 PG 租约、续期、最终 fence、归属、幂等、失败清理和全文件 SHA/大小/ETag 凭据；API 仍使用原异步接口，缓存命中仍检查当前 ETag。兼容 `1fee1d38797044dd13b6bfee57c16f99e7160ab4` API 与 PG 178 个迁移，不新增迁移、DTO 或计费行为。解析继续在主站。

执行端 `upload-confirmation` 服务默认 `BB_UPLOAD_CONFIRMATION_ROLE=disabled`，inactive profile 且 replicas=0，普通入口禁止显式启动。**11 月 14 日起采用现有 `execution` 放置**：两端 `BB_UPLOAD_CONFIRMATION_ROLE=execution`、`BB_PARSE_ROLE=main`；主站解析进程确认 enabled=0、lane=general、small-slot=0；Azure 独立确认 enabled=1、lane=general、small-slot=1，一个通用槽加一个保留的小件槽，共享 128MiB。解析、编制和复核的其他配置保持原值。此次只调整放置，复用原确认镜像，不发布新业务代码或镜像。

此前的 `size-split` 仍是受支持的备选放置：两端同为 size-split，主站 small/slot0，执行端 large/slot0。阈值单源为 API 的 `UPLOAD_CONFIRMATION_SMALL_MAX_BYTES`：small 包含 16MiB，large 为 >16MiB，领取 SQL 在加租约/attempts 前过滤。独立镜像 target `upload-confirmation` 仅安装 Node、CA 与 flock，不安装模型 CLI、浏览器、OCR 或认证 helper，不继承其环境、挂载或 AppArmor 配置。只有独立入口持专用 spool 的 CLI flock，主站解析入口没有独立 CLI flock。现有 egress/PG 转发保留。

入口最小配置：显式 `BB_UPLOAD_CONFIRMATION_ENABLED=1`、原 `DATABASE_URL`/`AZURE_STORAGE_CONNECTION_STRING`、绝对 `BB_UPLOAD_SPOOL_DIR`、严格 `BB_UPLOAD_SPOOL_MAX_BYTES=134217728`。`BB_UPLOAD_CONFIRMATION_LANE` 默认 general，独立入口可选 large；large 必须 small-slot=0。general 模式的 `BB_UPLOAD_CONFIRMATION_SMALL_SLOT=1` 增加一个不超过 16MiB 的槽，与通用槽同进程共享 128MiB；size-split 两节点各保持 128MiB，不能扩大预算。默认 small-slot=0，非法值拒绝。`BB_UPLOAD_CONFIRMATION_CONTAINER` 默认 `bondbuddy-private`，独立入口隔离测试必须设专属 container；主站现有 CLI 仍使用默认材料容器，class/factory 隔离测试须显式注入专属存储，不能冒称真实 CLI。不会用 `BB_LIBRARY_CONTAINER` 选择材料容器。`BB_UPLOAD_CONFIRMATION_POLL_MS` 默认 1000ms，允许 100–60000 的整数。模型环境或执行 kind 配置导致启动拒绝。

四路源码候选增加独立的显式 profile，合入代码不自动改变上述在线配置：只在 execution/general/small-slot1 下允许 `BB_UPLOAD_CONFIRMATION_CONCURRENCY=4`。Compose 输入需同时设 `BB_UPLOAD_CONFIRMATION_SPOOL_MAX_BYTES=469762048`、`BB_UPLOAD_CONFIRMATION_HEAP_MB=384`、`BB_UPLOAD_CONFIRMATION_CPU_LIMIT=1` 和 `BB_UPLOAD_CONFIRMATION_MEMORY_LIMIT=1536M`；容器实际 `BB_UPLOAD_SPOOL_MAX_BYTES` 为 448MiB，启动磁盘至少 464MiB。四个通用槽加一个小件槽最多预约四个 100MiB 和一个 16MiB 原件，共 416MiB；错误 lane、缺小件槽或不匹配的磁盘/内存/CPU/heap 配置均拒绝。旧 concurrency1 保持 128MiB/512MiB/0.5CPU。受保护 overlay 如已有显式 limits，须精准更新目标块并按原 binding/CAS 规则更新摘要，不能以环境输入冒称已覆盖实际 limits。

四路新代码发布须同时更新 HTTP API、Web 和独立确认所含的 API 实现，并按当前质量及真实金样要求验证准确发布源。排空、独立 spool/flock、pending 和对称恢复沿用下述保护；除明确需要更新的组件外，保留 current、编制/复核实际镜像及既有配置。传输仍由一个 SHA 准备槽逐个读取 1MiB 文件片段、四个实际 PUT 槽独立传输，确认与业务采用顺序不混同。资源上限实测和本地同源计时见[四路候选验收](../acceptance/upload-four-2026-11-14.md)；不将合成 opaque 原件、门控在途计数或本地网络结果当作最坏解析/国内速度保证。

`BB_UPLOAD_CONFIRMATION_SPOOL_HOST_DIR` 是执行端预建的独立 bind 目录，运行 UID 所有、0700，固定挂到 `/var/lib/bondbuddy/upload-confirmation`。不得使用 parser 目录、共享上传目录或 tmpfs。公开配置保持 `create_host_path: false`；校验拒绝 true、默认长/短语法。部分 Compose 版本会在 JSON 省略 false，省略值只在原挂载与可信显式 false 只读渲染一致、且与显式 true 对照可区分时接受；缺少 bind、探针失败或语义不可区分都拒绝。两个探针 overlay 从不用于实际生命周期命令，不改写原渲染结果。启动核目录/文件身份及至少预算加 16MiB 的空余磁盘，取得进程期内排他 flock 后才清理遗留私有 UUID `.blob/.part`。第二进程不能扫除第一进程的文件；未知文件导致拒绝，先完整检查再清理。Azure 可按实际余量选 `/mnt` 上专用可重建目录，禁止额外占用根盘预算。持久依据仍是 PG/Blob。

启用放置及本端 spool 路径进入原 `environment-binding.json` 和发布配置摘要。默认 disabled 保留旧 v1 binding 形状；size-split 同时绑定本端 small/large lane；已有 binding 下改变放置严格拒绝。维护时保存原 env/overlay/binding 原字节、权限与 hash，审查前后字段差异；明确更新受保护绑定，再由普通配置校验复核，不能删除 binding 或换 state。恢复时使用同一份已备份前像并复核 hash。新增服务进入来源标签/不可变镜像 ID 检查、pending 快照、恢复消费者清单和发布白名单；disabled 不要求旧提交存在从未构建的新镜像。

执行端镜像导出根据**传入提交**的 Dockerfile 是否提供 `upload-confirmation` target 选择新镜像；旧 `1fee`/`5e` 等提交不构建、不导出不存在的 target，包含该 target 的新提交才导出。旧调用格式、可信来源与准确 revision 校验保留，旧镜像未缓存也可按原路径重建。

**现有组件混版环境不能运行整角色 deploy/rollback 完成本次切换。** 新源码通过现行发布门禁后，发布者先记录主站 API/解析/Web 与执行端编制/复核各自准确镜像、源码、配置摘要和挂载，保留整角色 current，不将组件升级记成整角色升级。取得既有配置/部署锁并检查 pending；停止旧确认新领取、排空所有确认租约及暂存，纯放置调整只用原不可变镜像重建主站解析与执行端独立确认两个目标，使用 `--no-deps`；不得借此对齐其他组件版本。不得重建 PG 转发、编制、复核、执行端 inactive 解析或其他在途组件。实际执行前仍须核磁盘增量、镜像 UID/文件权限、来源与独立组件收据。回滚先停止新增确认领取并排空，保存新收据后恢复两端原确认配置、镜像及原 binding/overlay；不降库、不删除 Blob、不重启编制/复核。

主站解析的 `stop_grace_period=10m` 与独立入口一致，确认循环单独等待 read/commit settled 后才关闭 PG/退出；其他解析/编制 drain 语义不变。项目锁仍串行，跨 PG 的 commit 往返仍存在，不承诺所有小件始终先完成。

SIGTERM/SIGINT 停止新领取，持续续租并等待现有读取/提交结束，不提前释放暂存或 fence。Compose 宽限 10 分钟，这不是全量读取总 deadline。强制杀死后仍按 PG 租约和原 fence 恢复，不能把未返回当成已取消；正常切换先排空。

分段日志 `upload_confirmation_phase` 含 upload ID、lane、phase 与实测 `elapsed_ms`：`read` 包括完整读取、hash 和可选落盘，canonical 另读另记，缓存命中不伪造 read；`inspection` 是原声明/落盘文件检查（例外路径照实计时）；`commit` 包括事务、ETag复查和提交。失败阶段也计时，必须结合最终 outcome 与持久凭据判定成功。总 `upload_confirmation.elapsed_ms` 还含领取和准备查询，不能称为 reader 时间，也不能相加并行 lane 耗时。不记录连接、SAS、文件名或内容。

功能回归覆盖独立入口不领取 run/parse、16MiB 精确边界、wrong-lane 零领取、主站 SIGTERM 仍等待确认完成、受控大件 full-read gate 下 small 完成、共享暂存、202→200/同一材料重放及 owner/fence/完整性。放置调整复用未变代码的有效回归，只补新增组合验证：100MiB 最大文件加 16MiB 小件槽共 116MiB，不超过 128MiB spool；启动磁盘至少 144MiB；在实际 512MiB/0.5CPU 容器核并行预约、无 OOM、完整性、幂等与释放。生成文本流的预算验证不代表扫描 PDF 的最坏内存。隔离本地 PG 只证明功能与预算，生产延迟须以正式 HTTPS 的自有文件直传、确认、刷新唯一性及实际确认日志验收；不为调整位置重传历史大件或操作客户已完成记录。

分开记录 PUT、created→queued、queued→首个 read、read/inspection/commit 与最终 HTTP 200。created→queued 混合客户端、PUT 和请求时间，不能称为 PUT 实测；queued→首个 read 也包含领取与准备查询。PG `now()` 是事务起点，确认行 `updated_at` 可能早于 commit 结束，不能据此缩短总耗时。历史网络路径、时间段和 reader 落盘方式不同，不直接计算全链路提速倍数。位置优化只减少确认读取及排队，不承诺国内大件直传速度；当前 DNS/连接事实与历史 ESA 429/TCP 长尾分别记录。机械回归不代表准确版本真实模型金样、独立业务复核或生产性能已通过，新源码不继承旧热修例外。

## 弹性节点的诚信浏览器

弹性节点的 authoring 服务同样使用 `init:true` 和既有
`integrity-browser-seccomp.json`；保留 Chromium sandbox、cap-drop、
no-new-privileges 和 AppArmor。PID 上限仍为 512，不以进程残留为由直接提高额度。
网站循环串行，每站会创建自己的桌面和浏览器；排查资源问题须区分活跃线程与僵尸，
结合 cgroup 的 peak/events 和 rlimit，不能把批次数等同于浏览器并发数。

诚信浏览器显式使用 `http://172.28.61.1:15435`。该端口由节点既有 mTLS
transport 的独立 section 转发到主站 `10.2.0.5:15435`，主站独立监听转交
`127.0.0.1:3129` 的既有官网代理。沿用既有 CA、客户端身份与经过验证的服务端
证书/SNI，不复制认证，也不改通用模型代理 15434 或其白名单。
`private-integrity-server.conf` 和对应 service 是独立主站组件；部署前先核对
3129 实现/策略版本、mTLS 证书用途和网络规则，不能用端口监听代替官网成功。

现存节点切换前保存准确容器、模板、模块、配置及 hash 前像。活动模型未终结或
调用结果未知时不重建 authoring；新增主站专用监听不重启原模型代理。节点 transport
配置更新应使用已验证的 stunnel 无损 reload 并保留原流，或在排空后启动。
服务切换须沿用既有进程身份和节点 epoch 的登记规则；当前版本若要求正常排空、
Stop/Start 与重新登记，则完成该原生流程，不能直接重建后复用旧进程身份。
同步两槽启动模板的专用 profile、transport 与 hash，
不更新业务包、业务模型、上下文或其他组件。回滚恢复本次保存的原字节和 hash，
只回退受影响组件，不删除既有任务、batch、调用或账务记录。

失败 observation/batch 仍是原 run 的审计记录，不删除或改成成功。获授权复验使用
关联的新 run，先核原模型尝试/未决用量并防重复扣费；成功验收必须包括真实官网
查询、截图、Word、成果归属及正常授权下载和文件 size/hash。

15435 的独立 TCP/代理验证与故障边界见[官网出口 #1544](integrity-egress-1544.md)。
浏览器本地渲染 smoke、PG 预检及主站监听均不能替代该通道和真实官网查询验收。

## 托管执行池模型配额

`0194_provider_driven_model_capacity.sql` 允许按 PG 策略设置正整数全局容量。提高之前，核对实际生产供应商账号及模型的额度和费用依据，在同一次策略修订中写入 `global_model_limit`、`provider_concurrency_limit` 和批准凭据摘要。控制器的 `provider_budget_review_sha256` 要匹配 PG 的 `provider_policy_sha256`。现有控制器配置若仍持有 `global_model_limit`，则其用途是扩容前核对 PG；可在受控配置更新时移除该字段。修改配置时按原流程重绑报价快照并复核正式报价。供应商账号能力未获新证据时，沿用已批准的生产配额。

迁移和控制器可先在现行配额部署。提高之前，现有编制、复核和新建模板都要采用按 holder 数量找槽的运行模块，并核对准确字节及原启动绑定。旧进程仍可在原生产配额下读取新 schema。回退时先按原证据和策略版本降低准入，等待在途自然结束。保留迁移、任务、holder 和待对账用量，再按原组件收据恢复需要回退的模块。若恢复旧控制器，先确保 PG 全局值已恢复为它支持的原有配置。

更换节点模板前，逐台用原 Run、对应角色和历史公开引导字节验证完整创建清单。将需要保留的字节写入受控配置的 `retained_warm_bootstraps`，并重新核对报价的配置绑定。暖启在 PG 标记发出前验证完整创建清单。对旧版本已登记为 `unknown` 的操作，只有受控恢复路径能凭准确的本地未发出证据、原 Stop ACK、停费状态和完整节点前像进行取消。原派发时间与证据保留在审计中，已证明未发出的操作延续该节点的停机计费区间。

## 数据库备份恢复隔离与受控恢复（中期工作流）

运行固定已审源码和对应镜像，先保存主站、每个执行节点、解析节点、数据库及存储绑定的组件收据和回滚前像。`restore.sh` 继续拒绝分离部署的历史整栈恢复；下面的独立数据库工具和 operator CLI 用于分离环境，不以恢复旧整栈代替当前角色部署。恢复过程中主站 API、执行/复核、ops 准入保持冻结；解析服务与私有存储按既有角色处理，不能停整台 Azure 机器。

需要两份独立来源：准确 `db.dump` 字节及 SHA256，以及离机调用/云 Stop/账务对账清单。后者使用 `database-restore-safety-v1`，包含 `restore_id`、新的 `control_epoch`、`backup_sha256`、全体旧账号、全部模型 attempt 的原始 job/run/owner/logical_call_id 与完成/未发出/unknown 状态、实际结果私有对象 ref/hash、每个旧节点 epoch 的准确 Stop/Terminate 完成 operation、源/image/launch manifest/start 绑定、云 observation hash，以及每账号冻结后的 ledger/现金/订阅/活动计量 snapshot hash。`manifest_sha256` 是除该字段外的键排序、无空白 UTF-8 JSON SHA256。离机 audit 的 `covered_until` 必须覆盖实际源库冻结时刻；`complete` 不能由缺记录推定。没有证据的调用保持 `unknown`，不能补 `confirmed_not_sent`。未开始的 run 也必须有原始 `never_admitted_v1`、attempts=0、无 session 和无模型 attempts 的证明。

在已有运维入口的私有环境中设置 `DATABASE_URL` 为原库；`RESTORE_DATABASE_URL` 与 `BB_RESTORE_DATABASE_NAME` 指向不同名字的独立恢复库；`AZURE_STORAGE_CONNECTION_STRING` 指向原私有存储，`BB_RESTORE_STORAGE_CONNECTION_STRING` 指向不同账户/endpoint 的隔离存储。operator CLI 的 `BB_RESTORE_OPERATOR_ID` 记录真实运维主体，`BB_PROVIDER_RESULT_CONTAINER` 与已部署私有结果容器一致（默认 `bondbuddy-private`）。不要把连接串或模型凭证复制进 repo、receipt 或终端输出。目标 storage 使用同账户的另一个 key、别名或重排连接串仍会被拒绝。

执行顺序如下；代码中没有自动启动 worker 或恢复云节点的动作：

1. 对初始有签名摘要的 receipt 执行 `node db/verify-restore.mjs --restore-freeze <receipt.json> <db.dump SHA256>`。它冻结外部调用和执行预算，不删除资源。沿用既有控制器/运维入口，对全部旧 epoch 完成真正的 Stop/Terminate 和停费观察，导出完整 completed operation 到隔离私有对象存储；只提交 Stop 请求不是完成。停主站 API/worker/ops 进程，记录各角色实际停止回执。完成离机 audit 和冻结后的账务 snapshot，封存最终 receipt；同一 restore_id 的重复 freeze 不制造新的冻结时刻。
2. `node db/verify-restore.mjs --restore-safety-dry <final-receipt.json> <db.dump SHA256>` 不需要数据库凭据；接着 `--restore-safety-preflight` 对原库核对全部旧 epoch、正式云 Stop completion、调用全量覆盖、never-sent 和 ledger hash。缺完整 audit、源库不能读、旧 legacy holder 无节点证明、Stop 结果未知或任何绑定不匹配，都停止在冻结状态。源库事件和钱不回写为成功。
3. 由已有数据库运维身份创建独立库并导入准确备份（`pg_restore --no-owner --exit-on-error`）；不 DROP 原库。在恢复库执行完整新增迁移，再执行 `node db/verify-restore.mjs --restore-safety-apply <final-receipt.json> <db.dump SHA256>`。这个直接入口会再次核对源库，检查实际 target 名称，然后保存 immutable quarantine/preimage、新 control epoch 和逐 job 分类。旧 job token/holder/usage/credits 保留；非终态 run 以原 run ID 发布暂停事件/outbox，不触发计时扣费。重复 apply 同一 receipt 幂等。
4. `node deploy/m1/scripts/restore-control.mjs validate-storage` 验证存储隔离，按原字节 manifest/hash 导入材料和结果到隔离存储。核对所有原材料、prompt、provider result 和已提交 workflow chapter/operation/projection/receipt 对象的私有 ref、归属、大小及 SHA256。禁止以模型再发一次替代丢失结果。
5. 每个旧 node/epoch 分别准备普通单链接私有请求文件并执行 `node deploy/m1/scripts/restore-control.mjs fence <request.json>`。请求字段是 `quarantineId,manifestSha256,nodeId,epoch,expectedTokens:[{kind:"job"|"message",id,token}],evidenceRef`。`expectedTokens` 必须精确等于 quarantine.preimage 中这个 epoch 的旧 job/message token 全集；`evidenceRef` 指向步骤 1 导出的完整 source completed operation JSON，包含原 operation/account/region/instance/epoch/action/provider_request_id/cloud_observation。入口先有界读/hash，再短事务重核 q/current node/jobs/messages/holders/waiters，精确释放旧 epoch 职责并写 immutable fence receipt。异 token、新 epoch、哈希变化或 receipt 变化拒绝，不影响其他节点。
6. 对已完成调用与账务对账的账号执行 `node deploy/m1/scripts/restore-control.mjs reconcile <request.json>`，请求为 `quarantine_id,manifest_sha256,owner_user_ids:[...]`，每次最多16账号。所有 source attempt 必须在恢复库有准确原身份、completed 私有结果真实字节/hash/完成观察或供应商 `confirmed_not_sent` 观察；不存在的 intent、未知调用、遗留 token/holder、账务/meter 不一致会拒绝。它仅追加该账号 reconciliation 并开放全局证据门，未核旧账号仍被数据库 intent trigger 拦截。普通 evidence resume 无法绕过此入口。
7. 对可恢复原 run 执行 `node deploy/m1/scripts/restore-control.mjs resume <request.json>`，请求为 `quarantine_id,manifest_sha256,owner_user_id,run_id`。唯一 resume CAS 重新验证已封存 workflow 对象、原输入 hash、账号许可、Stop fence、供应商/用量、钱包隔离、预留状态和取消/暂停意图，再将同一 run 排队并发布事件。unknown、丢对象、已取消、用户仍暂停或钱未对清的 run 留在隔离状态。此步骤不改费用政策，不重置 retry/batch/checkpoint，也不调用供应商。
8. 按角色部署 runbook 接入已验证的恢复库/隔离 storage、新节点 epoch 和准确组件版本；通过既有预算策略与凭据恢复准入，逐角色核对实际进程/配置及原症状验收。真实 Word/模型/云恢复验收需另留证据。本 PR 的 synthetic PG 和文件测试不代表已执行生产恢复。

任一步失败保留 receipt、quarantine、旧 tokens、unknown 和原账务；不调用普通 resume、手工清 holder、直接设成功或删除审计。回滚先冻结新库、新 epoch 与准入，核对新产生的调用/账务再使用受控角色切换；不能把旧备份覆盖回有新副作用的数据库。
