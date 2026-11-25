# 受限内容读取修复验证与发布交接（2026-11-25）

本轮仅完成当前 develop 的独立只读诊断组件修复候选，尚未合并、部署或验证生产入口；不代表历史内容已经恢复。涉及 `read-content.mjs`、`broker.py`、`export.py` 及诊断测试/文档，不改变业务/API/模型、数据库投影授权或 SSH 配置。

## 读取行为与边界

- exec 的 helper/broker/本地导出固定期限为120/135/180秒；每页仍校验完整对象。只有 exec helper 实际触发期限时分类为 `CONTENT_READ_TIMEOUT`，SDK、范围、SHA、ETag、大小等其他错误保留安全类别。
- `content result ID --file operations.json --reason CODE` 只读取经原数据库授权的父 result 中的固定子文件描述符。父、子均校验原始 SHA、登记字节数和 ETag；子路径严格绑定 owner/project/run/attempt/子 SHA/固定文件名，最大1MiB，必须是 UTF-8 JSON。没有任意文件名、Blob 键或 SQL 接口。
- operations 的 helper/broker/本地导出期限为35/45/90秒；其他内容保持35/45/60秒。父子原始 SHA 与脱敏后的分页 SHA 分别报告。
- 导出接受合法前置参数、等号形式和标准 `--`，包括尾置 `--`；使用 `--` 时续页参数放在命令名之后、所有位置参数之前，普通查询保留原续页顺序。拒绝预填 offset/cursor（含等号形式），失败保留 `.partial`，完整哈希校验后才创建目标文件。
- 当前 `db sessions --time known|unknown`、不可变创建时间与旧数据 `legacy_unknown` 语义保留。

## Synthetic 验证

测试全部使用合成字节/本地身份和隔离 Linux、PG16、Azurite、loopback SSH；没有生产连接或模型调用。

```sh
python3 -B -m unittest -v test_diagnostics test_content_deadline test_export_deadline test_operations_broker test_operations_export_deadline
node --experimental-vm-modules --test test-read-content-deadline.mjs test-operations-helper.mjs
node test-reader-integration.mjs
node test-operations-integration.mjs
docker build -f Dockerfile.test -t bondbuddy-diagnostics-reader-test .
docker run --rm --network none bondbuddy-diagnostics-reader-test
```

执行 Node SDK/Azurite 集成时，以 `BB_DIAG_API_TEST_IMAGE` 显式选择本地已有且含 Azure Storage SDK 的测试镜像。Python 权限检查须在 root-owned Linux 正常文件模式目录执行，不能用 Windows 的权限语义替代或放宽 `trusted_file`。

冻结基线原44个 Python 测试在 Linux 全部通过；Windows 的6项 `fcntl`/POSIX可执行文件平台错误已与本轮改动区分。修复前大 exec 7,766,789/20,970,480字节在虚拟35秒后失败、operations selector被拒绝；复现后修复。独立审查发现尾置 `--` 的续页错误，补充三类调用先失败的回归后修复。最终计数以本文件冻结后的运行收据为准：Node58、Python77；定向 reader PG/Azurite8组、operations Azurite5组、loopback SSH7组。

原完整 `node test-integration.mjs` 保留1项改动前的失败：其 worker ACL 断言期望不能 SELECT `bb_model_attempt_execution_configs`，而当前 `deploy/m1/security/managed-execution-prerequisites.sql` 明确授予该读取权限。冻结基线与当前版本在相同断言失败，204份当前 migrations 与诊断视图安装此前通过。本轮未改业务 ACL 或放宽原断言；新增 `test-reader-integration.mjs` 复用原 fixture，单独验证诊断 reader 原表读取/写库拒绝、disabled owner/deleted project/tombstone和分页/私有内容读取，不能把定向通过称为完整集成门禁通过。

## 已授权发布者安装与恢复

1. 沿用 README 的统一发布流程和发布锁，先核验本轮提交/文件哈希、现有组件实际安装路径与配置；保存当前诊断安装收据、配置、ACL和受限入口前像。不得用旧生产版本号或本地候选替代实际安装绑定。
2. 在独立环境运行上方定向检查并记录当前原完整集成失败。若发布流程要求原完整集成门禁通过，须由对应维护者处理该旧差异，不能删除测试或放宽断言。
3. 用既有获授权的管理身份执行 `python3 install.py install /root/approved-main-config.json`。安装器生成固定内容哈希目录与回滚收据；它不会启用定时器、reload SSH或重启应用。合并现有配置，不整包替换业务部署，不给 `bb-logs` 管理权限。该读取修复不需要新增业务数据库授权；复验原诊断视图权限。
4. 按当前收据定位主站私有内容读取入口及其他实际安装节点，在既有发布流程下核对新安装文件哈希与严格主机密钥校验。用实际 reader 身份验证 exec 和固定 operations selector、SHA/分页、权限负控制，记录准确版本/生效时间；未来节点模板与现存节点覆盖按 README 原范围核对。
5. 如需恢复，保留失败记录与旧证据，使用安装器返回的备份路径执行 `python3 install.py rollback /var/lib/bondbuddy-diagnostics/install-backups/时间`，再核对受限入口和只读角色。账号/公钥不随文件回滚撤销；不删除历史归档、不重启业务容器。恢复后的内容范围与超时能力须如实复验。

尚未验证：生产实际安装版本、线上统一入口的新 selector、真实历史文件完整取回和生产验收。发布、源码/权限测试、历史内容恢复分别记录。
