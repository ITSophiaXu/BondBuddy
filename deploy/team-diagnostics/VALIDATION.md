# 团队只读诊断 v3 开发验证与交接

日期：2026-11-16。关联 [Issue #1460](https://github.com/ITSophiaXu/BondBuddy/issues/1460)。开发基线：`652d4b86f14a7015a67a720326e0c38ea4d23de0`，独立分支 `feat/team-log-read-access-20261116`。

状态：开发和自测完成；代码完成，尚未部署，待统一发布。线上 `bb-logs` 仍为原 v2 配置；尚未进行生产安装、数据库授权、SSH reload、业务重启或用户验收。本组件没有产品网页，不将命令行验证称为已交付统一本地产品验收版。

## 自动化证据

所有命令由本目录执行。Windows 开发机上的 Docker Linux 容器使用 synthetic 数据；不连接生产数据库、生产存储或真实模型。集成脚本创建带专用标签和随机名称的内部 Docker 网络，并在结束时核对标签后清理自身资源。

| 验证 | 命令 | 结果与范围 |
| --- | --- | --- |
| Linux 单元/权限检查 | `docker run --rm --network none --mount type=bind,source=本目录绝对路径,target=/code,readonly -w /code python:3.11-slim python -B -m unittest -v test_diagnostics` | 33 passed / 0 failed / 0 skipped；历史分页、固定查询上界、相同时间戳重复行、断线续传、重放防篡改、保留期、凭据脱敏、命令/SQL拒绝、完整导出及同名文件防覆盖 |
| PostgreSQL / Blob 集成 | `node test-integration.mjs` | 6组检查 passed / 0 failed / 0 skipped；191份当前应用迁移、诊断投影重复安装、25类投影查询、125条用户记录分页与状态筛选、原表读取和数据库写入拒绝、删除/停用/过期内容拒绝、真实 Azurite 的 prompt/result/exec 大小/路径/hash与脱敏检查 |
| SSH / sudo 集成 | `docker build -f Dockerfile.test -t bondbuddy-diagnostics-ssh-test .`，然后 `docker run --rm --network none bondbuddy-diagnostics-ssh-test` | 7组检查 passed / 0 failed / 0 skipped；真实loopback SSH登录、9种命令拒绝、独立上传身份、1,205条记录的SSH传输与全量分页导出、来源伪造拒绝、个人审计、撤权即时生效 |
| JavaScript 语法 | `node --check read-content.mjs`，`node --check test-integration.mjs` | 两个脚本通过 |

PG16验证使用 `postgres:16-alpine`；Blob验证使用本地 Azurite 和 `bondbuddy-quality-capacity-api:f029721966a7` 中已有的 Azure SDK。API镜像仅作为 SDK 运行环境，不启动真实业务链路。Python使用 `python:3.11-slim`。集成脚本仅在送入隔离数据库时把Windows迁移文本规范为Linux LF，未修改任何应用迁移。

本改动仅新增独立运维组件；没有改动应用 TypeScript、公共 DTO、页面或业务迁移，因此未重复全应用构建、产品端到端验收或真实模型质量回归。容器发现使用合成 Docker 清单验证重命名、扩容、停止和跨项目排除；生产节点的实际接入、systemd运行和采集完整性须在发布时核验。

## 安装与权限交接

完整步骤、开发命令和回滚见 [README](README.md)。发布者从固定代码版本按同一生产发布锁执行：

1. 核对主站 `bb-main`、Azure `bb-execution` 和腾讯节点 `bondbuddy-execution` 的实际标签，填写三个配置；备份配置、数据库和原读取器。
2. 安装固定哈希代码包、专用入口与系统单元。安装器本身不激活采集、不reload SSH、不重启应用。
3. 由管理员执行 `database.py` 输出的SQL，创建专用诊断视图和 `bb_diagnostics_reader`；这不是应用迁移。验证只读身份不能读身份原表或修改业务表。
4. 开发各自交公钥，登记为个人 reader；迁移 `bb-logs` 时保留原公钥。每个采集节点登记独立 ingest 账号与来源，不复用开发key或另一节点身份。主机指纹由管理员核验。
5. 启用采集timer，reload SSH并验证新账号；新执行节点模板纳入采集组件、配置、机器身份以及首次中央确认门禁。正常下线前做最后一次 `--collect --require-synced`，同步失败时保留节点排查。
6. 用户使用自己的账号复验新解析、确认、authoring/review、历史分页、模型内容和拒绝写入。记录部署commit、节点覆盖、用户验收状态；成功后再撤销旧读取器sudo授权。

默认保留180天；未上传的本地记录不清理。新服务在已批准Compose项目内自动发现；新物理节点仍需受控身份登记。未记录、已经轮转/清理或源头已经截断的日志无法补回；节点突然消失可能丢失最后一次同步后的内容。`sources`会显示缺失、陈旧、采集错误与积压，内容导出保留源截断标记，不能把这些情形报成完整日志。

最终统一验收待办：以上生产安装和授权、全部实际节点入池/退池验证、个人登录与全量导出、归档容量/保留期检查以及用户实际验收。未获授权向其他chat发送消息；本文件供集成/统一发布chat读取。
