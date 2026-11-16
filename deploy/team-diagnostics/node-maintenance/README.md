# 腾讯节点只读日志部署回执与固定请求

关联 #1460。现存腾讯执行节点 `ins-p4i0pcub` 已安装并启用与主站、Azure 相同的独立诊断组件：commit `ac818a21241e9427f5bd8755d8aa5f4e0da1f304`，bundle `f3928f57c9f01a2f`。本目录保存实际请求、可审源码、哈希和脱敏回执，不部署 #1478 / #1481 业务恢复包。

## 已执行结果

| 阶段 | InvocationId | 结果 |
|---|---|---|
| 只读前像 | `inv-gb90ehg5v9` | SUCCESS / exit 0 |
| 独立安装 | `inv-gb90k90tiu` | SUCCESS / exit 0 |
| 首次启用 | `inv-gb90tsg5ep` | FAILED / exit 1；网络阻断上传，未启用服务 |
| 恢复同步和启用 | `inv-eb91crgp3n` | SUCCESS / exit 0 |
| 持续采集核验 | `inv-cb91gcggcj` | SUCCESS / exit 0 |

2026-11-16 21:57（北京时间），24,135条历史记录完成首次中央确认。22:00核验已持续增长至24,496条，node sequence与uploaded相等；采集errors为空、backlog为false。ready服务active/exited，采集timer enabled/active，最近一次采集exit 0。业务配置/helper/compose哈希和两个容器的ID、镜像及StartedAt与启用前一致。

上传身份仅为`bb-ingest-ins-p4i0pcub`，绑定来源`ins-p4i0pcub`；节点本地生成的私钥不离开节点。主站使用固定host key和ingest-only强制命令。开发继续使用原`bb-logs`读账号。

owner在21:55:44于`sg-43pbfq0p`增加出站规则：`10.2.0.5/32`、`TCP:22`、允许，备注“BondBuddy日志上传”；其后实际SSH认证和全部上传成功。没有新增公网开放、云启停、业务应用重启或数据库/账务变更。本机维护身份只持有目标实例TAT与CVM读取权限，凭据保存在本机Windows CurrentUser DPAPI存储中，不进入本仓库。

原开发者`bb-logs`已实读腾讯节点24,351条历史记录，共25页，固定快照内无重复、逐条SHA256匹配；authoring/review/bootstrap/PG四类服务均有实际日志。ingest、采集、shell和命令注入均由服务端拒绝，三来源均无积压或错误。未保存业务日志正文。

## 校验请求，禁止重放

```sh
python3 verify-requests.py
python3 build-request.py --check
```

四份请求的原字节SHA256、命令SHA256和大小见各`*-manifest.json`；校验同时确认源码对应、内嵌13文件归档、唯一目标和TAT base64 Content不超过65,536字节。manifest中的prepared/dispatched字段是生成时的历史状态；实际执行状态以本页及`deployment-receipt.json`为准。

`activate-request.json`是已确认失败的原尝试；`resume-request.json`保留原前像并从持久化上传断点继续。它们均不可重复执行。未知结果须查询原InvocationId，不能重新派发。恢复脚本还设置bootstrap、采集timer及service对ready服务的依赖，防止开机首轮同步和定时采集竞争。

## 备份与回滚

节点发布目录：`/var/lib/bondbuddy/diagnostics-node-release-20261116-ac818a21241e`。安装备份：`/var/lib/bondbuddy-diagnostics/install-backups/20261116T133059163605Z`。主站公钥登记备份：`/var/lib/bondbuddy/diagnostics-node-enrollment-20261116-ins-p4i0pcub`。

安装保留`preimage.json`、`prepared.json`；启用保留原`activation-preimage.json`、`resume-preimage.json`、每轮同步回执、`activation-dropin-preimage.json`和`activation-receipt.json`。全部位于root拥有的受限目录。

如需回滚，先持有节点`/run/lock/bondbuddy-diagnostics-deploy.lock`并核对当前版本和实际回执，停用诊断timer并停止采集服务。核验内容与本次请求一致后，仅移除`activation-dropin-preimage.json`中原本不存在的三个本次drop-in；先daemon-reload移除bootstrap对ready的依赖，再停止ready服务，避免Requires传播到业务bootstrap。按原安装器备份恢复诊断管理文件，保留归档、上传私钥和审计。主站身份撤销使用原配置/部署锁及登记备份，不回滚其他来源的配置或业务应用。安全组回退仅删除owner本次新增的精确规则，不替换整个规则集。

## 范围边界

此回执覆盖现存物理节点及其后续正常开机的已安装服务配置；没有为验证重启节点，真实停机/再开机与强制销毁前的最终同步未验收。未来新建实例的受控安装、独立身份登记和首次归档门禁尚未接入生产创建模板；不能将当前节点私钥或source identity复制进镜像。此范围需与统一节点发布流程接续，不执行另一个chat的业务包或控制端切换。
