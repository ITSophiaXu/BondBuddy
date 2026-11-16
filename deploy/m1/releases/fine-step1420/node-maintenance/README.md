# #1420 现存执行节点维护

本目录接续已授权的细粒度日志发布。主站已于 2026-11-16 07:15 UTC 完成；本目录不重复主站发布、迁移或重建。

## 只读前像

`inspect-request.json` 是完整 TAT RunCommand 请求，目标仅 `ins-p4i0pcub`。`inspect-node.py` 是其可审查源码；准确字节的 SHA-256 在 `inspect-manifest.json`。内容由 base64 编码，未嵌入凭证、环境、业务内容或安装操作。输出为 gzip/base64 的脱敏 JSON（附原 JSON SHA-256），避免云输出截断。

由已有运维身份在管理环境核对固定 commit 的请求字节后执行：

```sh
tccli tat RunCommand --profile bondbuddy-lighthouse --region ap-beijing --cli-input-json file:///absolute/path/inspect-request.json
tccli tat DescribeInvocationTasks --profile bondbuddy-lighthouse --region ap-beijing --Filters '[{"Name":"invocation-id","Values":["<actual invocation ID>"]}]' --HideOutput False
```

保留 RunCommand 原 RequestId、InvocationId 和查询回执；未知派发先查询原调用，不能重复执行。解码 Output 后再解码 gzip_base64，校验 payload_sha256。仅 SUCCESS/Exit 0 加完整节点结果才证明本次检查成功。

这一步只读，不占长时间部署锁，不修改消费者、配置、数据库、IAM、云实例或调度。后续安装须基于实际前像，使用同一生产锁与控制协调锁，正向排空后才重建消费者。候选固定为 e4f5a17ae876f2f31e7d231ab250599f5c0f72ae 下 managed-node-eight；保持系统镜像/OCI、8/8 槽、max2、min_running0、idle300、原节点创建/epoch/调用/账务。现存 helper 与未来启动模板分开验收。

当前仅交付可执行的前像检查，不代表节点已安装或步骤耗时已入库。

## 当前恢复兼容候选（2026-11-16）

实时基线已变更：#1471 恢复包 `2d86f135`、helper `60afbcc`、#1473 最小权限及迁移台账190。旧日志包不再直接安装。本候选 `recovery-candidate/` 将原日志增量接到该恢复包，固定归档 SHA256 `8776d6abebc19efa6643a649b69428bccc56f11d0646d66a00bf9141efdd4ed5`（435959 B），严格版本 `shared-business-eight-performance-recovery-v1`，编制44项、复核26项。归档中的4份SQL仅留存，不执行迁移。

队列、runtime和两入口pipeline的源码三方输入、编译哈希与冲突处理在 `source-merge.json`；原恢复的释放上下文锁、原生进程屏障、心跳完成等待保留。两个原OCI镜像均在 network=none、无凭证、无模型条件下成功导入，8槽检查通过，恢复回归20/20；旧helper4项、新helper与bootstrap3项通过。启动UserData两槽均16376 B。实际云节点尚未安装，此处测试不代表生产采集生效。

`install-request.json` 是完整节点安装请求；源码为 `install-node.template.py`，唯一占位内容是已固定公开helper的gzip/base64。原字节数、SHA及启动前置见 `install-manifest.json`。安装前必须在共享发布/控制互斥内核对当前精确停机回执，完成主站pool/authority/service templates、公开helper/紧凑bootstrap及私有Blob归档准备；随后使用正常持久化Start流程，新epoch完成后执行TAT，拒绝运行中的消费者和activating bootstrap。不能直接调用云Start绕开持久化登记，也不能修改旧创建UserData/launch hash。

节点只修改已核对helper与node配置的business pin，保留原OCI/compose/adapter/注册信息。原字节备份在 `/var/lib/bondbuddy/timing1420-recovery-install`；同一调用未知先查询，失败不自动重装。安装后请求原bootstrap服务使用同一个已完成Start/epoch，返回请求不等于节点ready。回滚先正向排空，再恢复该目录备份与主站对应旧pool/authority/templates；保留当前迁移、ACL、业务输入和全部历史调用/账务。

后续验收：节点真实文件及只读挂载、两服务ready、正常业务任务产生sessions/spans、授权dashboard显示各步骤和coverage；未有这些回执前整批仍未完成。
