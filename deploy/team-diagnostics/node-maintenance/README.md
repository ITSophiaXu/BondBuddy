# 腾讯节点只读日志接入：固定维护请求

关联 #1460。主站和 Azure 已部署独立诊断组件 `ac818a21241e9427f5bd8755d8aa5f4e0da1f304`（bundle `f3928f57c9f01a2f`）；本目录只接续腾讯执行节点，不重发业务应用、不替换 #1478 的恢复兼容包。

## 当前可执行步骤

`inspect-request.json` 是完整 TAT RunCommand 请求，仅针对账号 `100006372392`、北京 `ins-p4i0pcub`。`inspect-node.py` 为可审源码；请求原字节和解码命令 SHA256、字节数见 `inspect-manifest.json`。只读取限定项目的容器清单、单元状态、磁盘余量及配置/代码哈希，不输出环境、凭据、日志正文或业务数据。输出压缩并附原 JSON 哈希，避免回执被云输出长度截断。

先用 `python3 build-request.py --check` 核对固定提交中的原始请求；只由已有、授权的管理身份提交：

```sh
tccli tat RunCommand --profile bondbuddy-lighthouse --region ap-beijing --cli-input-json file:///absolute/path/inspect-request.json
tccli tat DescribeInvocationTasks --profile bondbuddy-lighthouse --region ap-beijing --Filters '[{"Name":"invocation-id","Values":["<actual invocation ID>"]}]' --HideOutput False
```

保留原始 InvocationId、RunCommand RequestId、任务状态/退出码及完整 Output；结果未知先查询原调用，不能重发。Output 解码后再解压 `gzip_base64`，核对 `json_bytes` 和 `payload_sha256`，仅 SUCCESS/Exit 0 与完整结果证明前像读取成功。

当前节点正常停费。此检查接在 PR #1428 / #1478 的既有统一维护窗口，**不为检查单独启动节点，不重复原 Start/Stop 链**。管理机 profile 的名称不是新的权限要求，不需要复制凭据或扩大应用控制角色 IAM。本目录的请求尚未派发。

## 安装与验收接续

1. 基于回传的实际前像，固定独立诊断安装请求；保留最新业务包、helper、OCI、compose、8/8 槽、max2、min_running0、idle300、创建/epoch/费用证据。运行包和 helper 以同一窗口的最新前像为准，不能覆盖回旧版本。
2. 节点本地产生独立上传密钥，只返回公钥；主站在已有部署/配置锁内登记仅绑定 `ins-p4i0pcub` 的 ingest 身份。私钥不离开节点，开发账号只有查询权。
3. 安装与主站/Azure相同组件和经过核实的项目/日志范围，固定主站指纹，启用采集并确认首次历史同步。锁定备份前像，只操作独立诊断路径；不重启业务应用、不执行迁移、不改任务或账务。
4. 现存节点和未来新节点模板分别验收；后者需受控身份登记、首次归档确认及退出前同步。未完成模板登记不能声称覆盖所有未来节点。
5. 用原 `bb-logs` key 读取该来源的真实 authoring/review 日志，核对历史分页、中央回执、积压/错误及写入拒绝。成功后更新 #1460 部署回执，不能以请求已提交或 PR 已合并代替部署。

前像读取无业务写入，因此无需回滚。后续安装请求须包含实际备份路径和恢复步骤；失败保留归档与执行回执，未知结果不得重新派发。

## 现存节点独立安装请求（已准备）

`install-request.json` 从真实前像 `inv-gb90ehg5v9` 固定生成，检查SUCCESS/Exit 0；节点为Ubuntu24.04，两业务容器正在运行，磁盘余量约25GB。准确请求字节/hash见 `install-manifest.json`，公开可审源码见 `install-node.template.py`。内嵌13个文件均取自已合并、已在主站/Azure验证的诊断组件 `ac818a21241e9427f5bd8755d8aa5f4e0da1f304`。

请求在修改前后核对业务配置/代码哈希与容器ID、镜像、StartedAt，持有节点诊断部署锁，拒绝既有未知诊断安装或同一路径的旧未完成尝试。只安装独立诊断路径，产生留在节点的上传私钥，回传公钥及备份路径。不会启用采集timer、reload SSH、变更业务配置、重启应用、执行迁移、修改IAM或发起云启停。安装器备份文件前像，安装阶段未启用服务；归档和节点私钥保留供故障恢复，未知结果先检查原回执。

公钥需在主站同一配置/部署锁内注册为 `bb-ingest-ins-p4i0pcub` 并仅绑定该来源，随后才执行独立固定的首次同步与启用请求。本请求准备完成仍不代表已安装或日志覆盖成功。
