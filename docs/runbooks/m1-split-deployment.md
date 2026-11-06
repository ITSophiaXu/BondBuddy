# 主站与执行端独立发布（#907）

第一阶段：腾讯云主站运行网页、API、唯一业务 PostgreSQL 与必要运维；原 Azure 业务机器运行编制、复核、解析。继续使用 PG 队列与原私有 Azure Blob。无新增 HTTP 执行协议、批内并发、价格、状态机、模型、认证或页面变更。生产迁移及真实验收由 #908 实施；本说明和隔离检查本身不表示上线完成。

## 角色与入口

| 角色 | Compose | 常驻服务 | 单次服务 |
| --- | --- | --- | --- |
| `main` | `deploy/m1/compose.main.yaml` | `postgres/api/ops/egress/web` | `migrate`，仅主站运行 |
| `execution` | `deploy/m1/compose.execution.yaml` | `worker/worker-review/worker-parse/egress/pg-tunnel` | 无迁移或本地 PG |
| 诚信核查 | 执行端追加现有 `compose.integrity-browser.yaml` | `integrity-egress`；保留原浏览器配置 | `BB_INTEGRITY_BROWSER=1` |

两端从同一准确发布提交构建、加载镜像，首次切换必须同版。后续仅在确认数据库迁移向后兼容、队列/checkpoint/provider结果格式兼容后独立发布；不得仅凭健康检查认定兼容。共用环境策略从原 Compose 继承，主站用 `BB_MAIN_DATABASE_URL`（主机名 `postgres`、密码经URL编码）与原文 `POSTGRES_PASSWORD` 分别配置连接和PG账号；执行端用固定的 `BB_EXECUTION_DATABASE_URL` 覆盖连接；不需要主站的 `POSTGRES_PASSWORD`。包装入口仅为旧配置未使用的插值提供无效占位值，不创建本地 PG。

在构建环境准备归档，在各部署环境使用现有安全传输与 `docker load`：

```sh
bash deploy/m1/scripts/export-images-role.sh main <git-sha> <main-images.tar.gz>
bash deploy/m1/scripts/export-images-role.sh execution <git-sha> <execution-images.tar.gz>
# 以下命令分别在对应部署环境执行。私有 env 不入库，不打印 config 或容器完整环境。
BB_ENV_FILE=<main-private-env> bash deploy/m1/scripts/deploy-role.sh main <git-sha>
BB_ENV_FILE=<execution-private-env> bash deploy/m1/scripts/deploy-role.sh execution <git-sha>
```

构建前核实 Docker 数据盘、源码归档、依赖/浏览器镜像和输出镜像归档所需空间，至少保留既有部署要求的 4GiB 构建余量，另计归档实际大小；目标环境复用预装镜像，至少保留 2.5GiB，迁移备份、恢复空间另计。构建归档不包含 env、支付文件或模板原件。发布入口只使用预装准确 SHA 镜像，不自动清理其他镜像、不做备份、不安装定时任务。配置文件须与请求的提交一致。每端独立保存 `state-main` / `state-execution` 的版本和部署锁；锁仅覆盖对应角色，不冻结其他环境。首次使用单独的项目名称，不能把旧同机项目当作可自动删除的孤儿。

只读展开、检查和运维入口：

```sh
BB_ENV_FILE=<private-env> BB_IMAGE_TAG=<sha-first-12> bash deploy/m1/scripts/role-compose.sh main config --quiet
BB_ENV_FILE=<private-env> BB_IMAGE_TAG=<sha-first-12> bash deploy/m1/scripts/role-compose.sh execution config --services
BB_ENV_FILE=<private-env> bash deploy/m1/scripts/role-compose.sh execution ps
```

模板见 `.env.main.example`、`.env.execution.example`：仅补角色字段，保留原收费开关、Blob、模型、Provider、认证、超时、条款及出口白名单。不要把示例占位值用于生产。业务 Codex 的**模型目录和真实执行参数继续固定 1000000 窗口、900000 压缩**；原 Dockerfile/适配器保持不变。验收实际 `token_count.info.model_context_window=1000000`，不是只看目录。业务窗口与开发环境窗口各自独立。

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

密码沿用标准 URL 编码：使用 `urllib.parse.quote(raw_password, safe="")`（不要手工替换字符），直接写入权限0600的私有 env，不向终端打印原值或编码值。隔离测试覆盖 `@ : # / ? % $ & = + !`，确认容器读回一致。

`pg-tunnel` 同时接入 `backend`（internal）和 `edge`，内部监听 5432，**没有主机端口映射**；执行容器仍只有 internal 网络。严格校验主机密钥、指定唯一身份、转发失败退出、15秒保活、断线重启。HTTP `egress:3128` 仍只处理原 Blob/模型/支付等出口，不能承载 PG；不放宽 Squid 到任意 TCP。隧道 TCP 健康只证明监听存在，发布前使用真实应用容器的只读 PG/schema 探测，防止远端不可达却误判健康。

诚信核查需单独核对现有浏览器专用出口、既有授权/会话挂载或隧道、allow-list 和端到端公开检索；PG 隧道不替代这些。代码保留现有 overlay，不自动推断线上隧道有效，不宣称隔离检查完成真实诚信核查。

## 切换与迁移边界

1. 保持现有自动部署停用；双端入口接入并完成验收前不恢复。只冻结同一生产环境的冲突写入。记录旧版准确镜像、环境、挂载、PG/Blob位置和已应用迁移，保留可恢复版本。
2. 在维护入口关闭新任务、上传、助手与支付回调等写入；按既有产品维护方式实施，不改变收费逻辑。核实所有在途编制、复核、解析及助手调用、运行中容器/子进程和供应商调用记录。默认 SIGTERM 只排空 20秒（容器宽限30秒），**不能对长模型调用直接 stop**。等当前调用完成，未知调用先复核；无在途调用后才停止旧执行服务、旧 ops、旧 API/web，并再次核对没有写入进程。不能只等租约过期就认定远程调用结束。发布脚本对已登记旧角色的 running job/leased message 非零返回76，查询/连接失败返回77；该检查不能代替首次迁移的旧栈检查或维护入口。
3. 用户已停用日常备份，不恢复 cron/定期备份。本次单独创建迁移备份及恢复演练，保留校验和、准确版本、数据量与恢复证据。迁移冻结后对旧唯一业务 PG `pg_dump -Fc`，一次性导出/保护配置、支付证书及**全量私有不可变底稿模板包（包括非发布原件及目录结构）**，记录 SHA-256。上传暂存卷必须保留：等待在途上传完成再快照/转移，不能把重建空卷当保留。解析暂存按无在途任务确认后处理，不丢未知执行证据。Blob 不迁移，保持原私有容器、账号、对象权限和 hash；恢复演练只用隔离库/测试容器，不能对共享 Blob 做覆盖导入。
4. 先启动新主站 PG，向全新目标库恢复 dump，核对表行数、迁移记录及关键账务/任务关系，完成隔离恢复演练证据。执行端保持停止。仅主站入口运行 `migrate`，执行端 Compose 没有 postgres/migrate，`deploy-role.sh execution` 只检查目标 schema。迁移无并发执行者，失败即停止切换，不能跳过失败继续启动。
5. 主站发布成功后，API 和 ops 接同一新库；**API 创建后强制重建 web**，避免 nginx 缓存旧 API 地址。主站保留支付只读挂载 `/run/bondbuddy-payments`、完整模板包 `/opt/bondbuddy/private-file-templates`、uploadspool 卷；模板包强制存在。与 `compose.file-templates.yaml` 使用相同挂载契约，主站配置已经包含它，不额外叠加创建 API 的覆盖文件。不能只看 `/health`。
6. 建立受限 SSH 转发，确认执行容器连接的是新唯一业务 PG，再运行执行端发布。确认三组心跳、领取和续租、原 Blob 读写、业务 Codex 实际窗口、真实编制/复核/解析和诚信核查。旧 PG 保持停止且不再有消费者连接。受控恢复流量前核对支付证书加载/签验、模板列表/预览/实际底稿生成、上传/续传与原有文件下载；配置证书存在并不证明支付业务验收。
7. 比较版本与健康、就绪、审计和任务结果，按 #906/#908 记录直接证据。全程保持单一业务库和写入入口。新代码发布完成与生产迁移验收分别记录。

## 备份、恢复和回滚限制

旧 `backup.sh` 绑定同机 postgres 并导出 Blob，旧 `restore.sh` 会重启整个旧栈且覆盖 Blob；旧 `deploy.sh`、`rollback.sh` 也启动同机服务。**split env 设置 `BB_DEPLOY_ROLE` 后，这些旧入口全部拒绝执行**。不能为执行端准备一份旧式无角色 env 来绕过保护。

迁移一次性备份使用原旧栈的准确 PG 操作（冻结后，显式指定旧项目），目标恢复仅用主站角色的 PG 工具，例如：

```sh
BB_ENV_FILE=<main-private-env> BB_IMAGE_TAG=<sha-first-12> bash deploy/m1/scripts/role-compose.sh main up -d --wait postgres
BB_ENV_FILE=<main-private-env> BB_IMAGE_TAG=<sha-first-12> bash deploy/m1/scripts/role-compose.sh main exec -T postgres pg_restore -U bondbuddy -d bondbuddy --no-owner --exit-on-error < <verified-db.dump>
```

`pg_restore` 只用于核对过的**新空库**；不得直接覆盖当前活动库。恢复失败保持维护状态，不重启旧整栈。不要运行旧恢复脚本导入共享 Azure Blob。必要数据回退需先冻结并停止两端写入，备份新库，核对新产生账务/任务与对象，明确迁移兼容和数据合并方案后才恢复，不自动丢弃切换后的数据。

仅应用回滚：先维护入口、核实在途调用和 schema/队列兼容，在对应端用 `role-compose.sh` 显式选择已保留旧版镜像（`BB_IMAGE_TAG=<old-tag>`）启动该角色常驻服务，主站随后 `up -d --no-deps --force-recreate --wait web`；**不运行 migrate、不使用 deploy-role.sh 回退、不启动旧 PG**。回滚前后记录实际镜像、准确提交和同一业务库。首次迁移若恢复流量前失败，可停止新两端、确认无新业务写入后回到旧冻结库与旧准确版本；恢复流量后不允许仅改连接字符串指回旧库。

最终统一验收待办：目标网络/密钥权限、真实恢复与完整资产迁移、支付签验与回调、模板及上传、真实模型1M窗口、三类任务与续租、真实诚信核查及旧库停用证据。隔离测试仅证明配置与合成行为。
