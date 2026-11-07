# 主站与执行端独立发布（#907、#911）

第一阶段：腾讯云主站运行网页、API、唯一业务 PostgreSQL 与必要运维；原 Azure 业务机器运行编制、复核；当前迁移布局由主站运行纯解析。继续使用 PG 队列与原私有 Azure Blob。无新增 HTTP 执行协议、批内并发、价格、状态机、模型、认证或页面变更。生产迁移及真实验收由 #908 实施；本说明和隔离检查本身不表示上线完成。

## 角色与入口

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

首次使用有效覆盖时，角色状态目录持久化 `environment-binding.json`，固定私有 env 的真实路径、项目名称、覆盖路径/hash、解析位置、数据库连接摘要与诚信模式；主站同时固定 `pg-volume.json` 中的准确卷定义。后续漏掉覆盖、换回旧 env 或改变绑定直接拒绝，缺文件/hash、hash 不符均在 Docker 调用前拒绝；不允许旧整栈脚本绕过已绑定状态。保留同一状态目录及这两份文件；不得通过另建状态目录、删除绑定、改变项目名称来执行日常发布或回滚。首次接管本身不迁移或恢复 PG 数据，必须先核对唯一卷就是既有卷。

若确需改变网络/解析放置/数据库身份等绑定，在维护状态下先核实无在途调用，保存原私有 env、覆盖、状态绑定及其 hash，独立审查目标配置和恢复路径；再明确更新受保护绑定并用普通入口重新验证。脚本不会自行删除或降级绑定。脚本 pin 或应用版本更新不需更改拓扑绑定。线上采用与验收由 #908 执行，CI/自动整栈发布继续停用。

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

该入口复用来源标签、实际 image ID、只读 SQL 与在途门禁；主站不启动或重建 PG、不运行 migrate，应用服务显式 `--no-deps`，API 后强制重建 web；执行端先等既有 PG/诚信隧道和出口就绪，再启动编制/复核及所选解析服务。不会要求非本角色的 parser 存在，不会误启执行端 parser。配置与当前 PG 卷的绑定保持不变，成功后记录应用 SHA、脚本 SHA/tree、覆盖 SHA-256 与镜像 ID。此命令不恢复数据，也不判定 schema/checkpoint 格式向后兼容。

回滚前后记录同一业务库和准确镜像。首次迁移若恢复流量前失败，可停止新两端、确认无新业务写入后回到旧冻结库与旧准确版本；恢复流量后不允许仅改连接字符串指回旧库。

最终统一验收待办：目标网络/密钥权限、真实恢复与完整资产迁移、支付签验与回调、模板及上传、真实模型1M窗口、三类任务与续租、真实诚信核查及旧库停用证据。隔离测试仅证明配置与合成行为。


## 隔离验证命令与边界

`node --test deploy/m1/scripts/split-deploy.test.mjs` 覆盖角色渲染、国内/直出模式互斥、两个隧道依赖、密码编码、资产挂载、旧脚本拒绝、发布在途门禁及镜像版本漂移拒绝。命令级替身仅检查脚本顺序，不代表真实部署。

`BB_SPLIT_TEST_RUNTIME_IMAGE=<verified-local-image-id> node deploy/m1/scripts/split-deploy.integration.mjs` 在本地Linux启动两套隔离Compose：完整主站API/ops/egress/web、PG16、受限SSH服务与执行容器；使用当前编译产物和合成模板，验证主站PG探测、Node22参数、空支付目录、完整模板包读取、上传暂存、队列领取/续租、运行时退出、一次性dump/restore、断库和错误主机密钥拒绝。执行前已有 `npm run build` 的产物及依赖；复用基础镜像必须先核对不可变ID。合成检查会创建并清理专属容器、卷、网络及临时密钥，不访问生产。当前临时构建网络使用host，不修改daemon。原诚信国内出口只做真实渲染回归，真实检索由最终发布验收执行。

Codex仅构建目标 `codex` 后，以断网容器运行 `deploy/m1/scripts/codex-business-runtime-smoke.mjs` 和既有 `apps/worker/test-fixtures/codex/completion-probe.mjs`：检查官方CLI实际版本、真实context事件、900K参数、目录工具回传和三种Stop续跑情形；供应商响应为本机合成服务。另运行 `node --test apps/worker/dist/codex-adapter.test.js`、`npm run check:contracts` 与 `bash deploy/m1/scripts/test-deploy-space-gate.sh`。这些检查不冒充真实供应商调用、完整候选发布镜像构建或生产验收；发布方必须基于最终准确SHA构建完整镜像并读回实际image ID。

`node deploy/m1/scripts/role-config.integration.mjs` 是 #911 的轻量合成验证：只用缓存 PG16/Node 镜像及小型专属 SSH 测试镜像，普通入口验证受限回环认证 SQL、专用桥接、跨网络受限 SSH、PG 重建后覆盖/同卷、非回环拒绝、inactive parser、实际测试镜像切换/回滚、在途和断库拒绝。测试不构建应用、不调用模型、不创建业务任务、不运行真实迁移或数据库恢复；合成最小表与测试容器/卷/网络/密钥用后清理。应用完整 `deploy-role.sh --rollback` 分支、来源/实际 ID 和版本分离由定向命令替身测试覆盖，不能据此声称线上应用回滚已验收。
