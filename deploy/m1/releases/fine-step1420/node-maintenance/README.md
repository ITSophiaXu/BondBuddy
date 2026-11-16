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
