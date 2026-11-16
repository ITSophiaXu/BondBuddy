# BondBuddy 团队只读诊断 v3

关联缺陷：[#1460](https://github.com/ITSophiaXu/BondBuddy/issues/1460)。本目录是可安装的独立运维组件；生产仍使用 v2。代码交付不代表账号已升级，安装、数据库授权、SSH 配置生效和采集服务启用由统一发布 chat 执行。

## 已实现的访问范围

- 按经过管理员配置的 Compose project 标签发现该主机的全部容器（包括停止容器）；容器重建、扩副本、解析服务迁移和新增确认服务不再依赖旧名称。独立启动的容器通过精确名单登记。不会仅凭名字含 `bb` 读取同机其他产品。
- 主站、Azure、腾讯弹性节点使用同一采集程序。每个节点独立的机器 key 只能上传其绑定来源；开发使用个人账号/key，只能查询。节点的上传重试按不可变序号/哈希去重，中央确认落盘后才推进上传位置。
- 中央归档可按来源、服务、容器和时间分页；单页条数/字节限制不再限制总查询范围。默认保留180天，可配置30–3650天。旧于保留期的内容清理后仍保留去重哈希，尚未上传的本地记录不清理。
- `sources` 同时显示丢失、超过120秒未更新、采集错误和待上传条数；主站核对执行节点登记表，列出 starting/ready/draining 但没有新鲜采集回执的节点。缺失来源不会冒充空日志。
- 25类数据库诊断投影：用户ID/用户名、任务、jobs、模型尝试/运行/用量/观测、结构化错误、事件、操作、outbox、提示词/提交版本/结果/执行日志引用、积分/冻结/计费拒绝、执行节点/会话/心跳和浏览器错误。过滤字段按项目/用户/run/job/attempt/状态/时间开放。没有任意 SQL 接口，不授予业务表全库读取。
- `content` 通过数据库引用读取私有 Blob，先检查主体状态、删除/清理记录、对象路径、大小、ETag和SHA256，再脱敏并按字节分页。原执行日志已截断时返回 `capture_truncated`，导出报告保留该标记。可看所有**已保存**的授权日志；未记录、已经轮转/清理的字节不能恢复。

## 开发使用

管理员完成升级后，以分配给个人的 `bb-log-姓名` SSH 账号登录统一入口。已有 `bb-logs` 可在迁移期间保留，但共用key不能区分个人。

```text
capabilities
sources
services
logs upload-confirmation --source azure --since 2h --tail 500
logs authoring --from 2026-11-01T00:00:00Z --limit 200
db runs --user USER_ID --limit 100
runs pending
run RUN_ID
attempt ATTEMPT_ID
db attempts --run RUN_ID --cursor RETURNED_CURSOR
db errors --job JOB_ID
content prompt SNAPSHOT_ID --reason incident_1460
content result RESULT_REF_ID --reason incident_1460
exec-log ATTEMPT_ID --reason incident_1460
processes authoring
```

`services` 返回真实服务名；腾讯执行节点的服务名为 `authoring`/`review`，Azure解析为 `worker-parse`，不能再用旧 `worker` 名称推断当前执行位置。`run`/`attempt`每个分区都返回继续查询的cursor，不用摘要冒充完整明细。数据库查询固定首次请求的创建时间上界，但运行中任务的状态仍是实时数据。

新内容接口以JSON/base64返回脱敏后的UTF-8字节；不沿用v2的直接 `--all` 文本输出，避免单次大响应丢失尾部。`--since`、`--until`、`--tail`保留，`--tail`选择最近N条并仍可分页。归档通常在采集后约15秒可查询；实时跟踪使用重复分页读取，v2的 `--follow` 容器直连不再开放。

一次导出全部匹配记录，在开发电脑执行；无需服务器写权限：

```sh
python3 export.py --target bondbuddy-logs --ssh-config ./ssh_config --query "logs authoring --from 2026-11-01T00:00:00Z" --output authoring.jsonl
python3 export.py --target bondbuddy-logs --ssh-config ./ssh_config --query "db attempts --run RUN_ID" --output attempts.jsonl
python3 export.py --target bondbuddy-logs --ssh-config ./ssh_config --query "content exec ATTEMPT_ID --reason incident_1460" --output execution.log
```

导出先写 `.partial`，全部页成功且内容哈希一致后才生成目标文件；失败保留 partial，不声称完成，不覆盖已有文件。SSH配置应指定个人key和经管理员核对的 `UserKnownHostsFile`；必须保留严格主机密钥校验。

## 统一发布步骤

前置依赖：Linux Python 3.11+、Docker、OpenSSH/sudo，主站现有 PostgreSQL16 与 API 容器里的 Azure Storage SDK。归档目录默认 `/var/lib/bondbuddy-diagnostics`，配置目录 `/etc/bondbuddy-diagnostics`，均由root控制；建议把归档目录挂载在持久数据盘并监测空间。低于512MiB余量暂停新采集并报告错误，机器保留未确认上传的数据。准备数据库/配置备份，按项目发布锁串行执行。

1. 在本批固定版本审阅并填写三个 `config.*.example.json`。主站范围为 `bb-main` 加精确登记的弹性出口；Azure范围为 `bb-execution`；腾讯执行节点范围为 `bondbuddy-execution`。逐个核对实际标签与需要采集的systemd单元。弹性配置的 `node` 必须填写登记表中的真实 `instance_id`；未来节点模板也需包含本采集组件、配置及该节点专用上传身份。
2. 在主站管理员会话安装：`python3 install.py install /root/approved-main-config.json`。程序安装固定内容哈希目录、受限入口、sudoers、SSH配置和定时服务，校验配置并输出备份目录；**不会启用定时器、reload SSH或重启任何应用服务**。
3. 生成诊断投影SQL：`python3 database.py > /root/diagnostic-views.sql`。由管理员用已核实的当前主站PostgreSQL容器执行该SQL。它只建立 `bb_diagnostics` 视图和 `bb_diagnostics_reader` 读取角色，不改业务状态、账务或应用迁移。应用较旧、可选表不存在时在 `collections` 中明确列为 unavailable；新表不会自动获得权限。通过psql验证该角色可读视图、不能读 `bb_users` 原表或写业务表。
4. 每位开发自行产生key，只交公钥。管理员执行 `python3 install.py account bb-log-alice /root/alice.pub`。迁移原账号则指定 `bb-logs` 和现有团队公钥；执行前保存 `getent passwd bb-logs` 的原登录shell及旧读取器sudo配置。账号命令会锁定密码并改用新受限shell，这些账号调整不在安装器文件回滚范围内。不生成或转交个人私钥，不给开发docker/sudo/adm组权限；诊断组的唯一sudo入口会再次校验具体账号的reader角色。
5. 每个采集节点使用独立机器key，在主站执行 `python3 install.py account bb-ingest-node1 /root/node1.pub --role ingest --source INSTANCE_ID`；Azure来源使用 `azure`。此操作同时登记预期来源。节点上的上传私钥、known_hosts和 `upload-ssh.example.conf` 安装成root所有、私钥0600；地址只使用本批已批准的主站路径。开发拿不到上传key。新实例必须在受控入池时完成同一登记，不能继承另一实例的来源身份。
6. 各节点安装经核对的配置。主站个人key就绪后，由发布者显式 reload SSH；节点和主站执行 `systemctl daemon-reload`、`systemctl enable --now bondbuddy-diagnostics-collect.timer`，再执行一次 `/usr/local/sbin/bb-diagnostics --collect --require-synced`。这些是**待发布操作**，本开发chat未执行。迁移v2时 `90-bondbuddy-diagnostics.conf` 优先于旧95配置；验证成功后撤销旧读取器sudo授权，保留其备份供回滚。
7. 将 `execution-bootstrap.drop-in.conf` 安装到实际 `bondbuddy-execution-bootstrap.service.d/`，随执行节点模板固定版本。它在新节点入池前要求首次中央归档确认。正常排空节点后、物理停机/销毁前，再执行 `--collect --require-synced` 并核对回执；失败应保留节点排查。突然断电/销毁仍可能丢失最后一次同步后的日志，不能把15秒周期声称为零丢失保证。
8. 用个人身份复验：新解析/确认/两类执行服务均出现在 `services`；`sources` 无未覆盖的活跃执行节点；跨用户任务可定位；超过50条任务和5000行日志能导出；保留期内历史可查；模型内容损坏/缺失准确报错；写库、exec、shell、跨源伪造被拒绝。记录实际部署版本、节点、个人账号和用户验收结果。

新增服务只要属于已登记的Compose项目便自动采集；新增物理节点必须经过上述受控身份登记和采集就绪检查。已经禁用的日志（例如配置为 `access_log none` 或 `StandardOutput=null`）没有可读取的历史，本组件不会伪造补录。

## 撤销与回滚

- 撤销个人：从root配置的 `actors` 删除该账号并删除对应 `/etc/bondbuddy-diagnostics/keys/账号` 公钥文件；下一条命令即被拒绝，不修改历史审计，不删除人员的其他账号。
- 回滚本组件：停用本组件timer，使用安装回执里的路径执行 `python3 install.py rollback /var/lib/bondbuddy-diagnostics/install-backups/时间`。账号/公钥登记不随文件回滚撤销；迁移过的 `bb-logs` 需用 `usermod --shell 已备份的原shell bb-logs` 恢复原shell，并恢复发布时另行备份的旧读取器sudo授权。新建账号继续保持禁用或受限，不恢复密码登录。校验sshd/sudoers后由发布者reload SSH与systemd，并用原只读账号验证。归档和审计保留，不删除源日志、不重启业务容器。诊断视图可暂留；如撤销DB访问，仅撤销专用角色授权，不drop业务表。
- 安装旧配置不能修复v2的服务遗漏；回滚后须如实恢复“覆盖不完整”状态。

## 验证

```sh
python3 -B -m unittest -v test_diagnostics
node test-integration.mjs
docker build -f Dockerfile.test -t bondbuddy-diagnostics-ssh-test .
docker run --rm --network none bondbuddy-diagnostics-ssh-test
```

第一组验证权限拒绝、采集重放、相同时间戳、分页、字节上限、脱敏、留存及导出；第二组从当前迁移建立独立PG16并验证真实视图/权限，再用独立Azurite验证三种私有内容读取；第三组使用真实loopback SSH/sudo验证个人与机器身份、1,205条记录的上传/分页导出和撤权。合成数据，无真实模型调用，不连接生产数据库/存储。集成脚本只清理自身随机名称且标签匹配的测试资源。最终本批结果见[验证与发布交接](VALIDATION.md)。
