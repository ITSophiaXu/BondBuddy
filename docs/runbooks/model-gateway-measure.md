# 模型请求测量网关（#994）

这项功能用于查清 DeepSeek 413 等“请求体过大”问题，统计每次模型请求的实际大小和组成。默认关闭。开启后，Codex 发给模型供应商的请求会原样经过网关转发；网关只记录大小、计数、图片尺寸、状态码、请求编号和用量，不记录任何内容。

## 开启和关闭

在执行端的私有环境文件中设置：

```text
BB_MODEL_GATEWAY_MODE=measure
```

然后按 [拆分部署手册](m1-split-deployment.md) 的正常流程重建 `worker` 和 `worker-review` 容器。关闭时改回 `off`（或删除该项）并再次重建。其他取值会让 worker 配置校验失败，不会被静默忽略。

## 工作方式

- 每次 Codex 调用单独启动一个只监听 `127.0.0.1` 随机端口的网关，Codex 的 `base_url` 指向它；调用结束后网关随之关闭。
- 网关仅允许 `/responses` 和 `/responses/compact`，固定转发到配置的供应商 origin 和 base path，保留合法查询参数。含反斜杠、路径穿越、绝对地址或其他路径的请求在转发前返回 `PATH_INVALID`，不会把鉴权头带到其他地址。
- 合法且未超过下述资源上限的请求体保持原字节，经过与 Codex 相同的出口代理（`HTTPS_PROXY` / `NO_PROXY`）转发。不压缩或重试；供应商返回的流式内容逐字节交回 Codex。
- 鉴权头由 Codex 自己发送，网关只转发，不读取、不保存。
- 网关启动失败时，本次调用自动改为直连供应商，并在 worker 日志写一条 `event: start_failed`。测量功能不会让任务失败。

## 查看结果

**按调用查（推荐）。** 团队诊断入口执行：

```text
exec-log ATTEMPT_ID --tail 400
```

执行日志末尾的 `[bondbuddy-model-gateway]` 段，第一行是本次调用的汇总，后面每次 HTTP 请求一行。该段最多 512 KiB；请求很多时保留前 10 条和最近的请求，中间用一行 `omitted` 说明省略条数。汇总行始终保留。

**实时查。** 在 `logs worker` 或 `logs review` 中搜索 `"kind":"model_gateway"`：

- `event: summary`：每次 Codex 调用结束一条，带 `run_id`、`call_id`、`logical_call_id`、`attempt_no`。
- `event: request`：只在请求失败（如 413）、网关或上游出错，或单次请求达到 4 MiB 时实时输出。

容器日志在容器重建后会丢失；执行日志随调用持久保存。

## 主要字段

| 字段 | 含义 |
| --- | --- |
| `request_bytes` | 网关从 Codex 接收的请求体字节数；本地拒绝或连接失败不代表供应商收到这些字节 |
| `request.items` | 按类型（如 `message:user`、`function_call_output`）统计的条数和字节 |
| `request.largest_item` | 本次请求中最大的一条输入及其字节数 |
| `request.image_count` / `image_data_url_bytes` | 请求中内联图片数量，以及它们在请求体中占用的字节 |
| `request.images[]` | 每张图片的位置、格式、宽高、请求内字节和解码后字节（最多列 16 张） |
| `response.status` / `upstream_request_id` | 供应商状态码和返回的请求编号，可用于向供应商查询 |
| `response.usage` | 流式响应结束时供应商报告的 token 用量 |
| `max_request_bytes` / `max_request_seq` | 本次调用中最大的请求及其序号 |
| `first_413_seq` / `first_413_request_bytes` | 第一次收到上游 413 的请求序号和大小；不包含本地拒绝 |

## 内容边界

记录中只有模型 ID、输入类型名、计数、字节数、图片尺寸、状态码、供应商响应编号和用量。不记录提示词、工具命令或输出、模型文字、图片字节、图片地址、请求头或密钥。

## 已知限制

- 网关到供应商使用 HTTP/1.1；直连时 Codex 可能使用 HTTP/2。请求体不变，每次请求多一次本机转发，代理隧道会被复用。
- 现有单请求资源上限为 **256 MiB**。超过上限时网关本地返回 413 / `GATEWAY_REQUEST_LIMIT`，记录为 `outcome=gateway_rejected`、`response=null`，没有转发给供应商。该保护不是测得的供应商上限，也不计入 `first_413_*`。
- 请求会在内存中缓存并解析，峰值可能高于原请求体大小；`request.items` 是重新序列化后的分项大小，不能用其总和替代原始 `request_bytes`。压缩请求的原始大小和解码后的 `request.json_bytes` 也须分别看。
- 供应商响应如果被压缩，只记录状态码和字节数，不解析用量。
- 这是诊断功能，不压缩图片；除上述资源保护外，不实现业务请求预算，也不能代替发布验收。

## 背景

Codex 执行日志不会记录 `view_image` 看图事件。用 Codex 0.167 做的合成测试中，一张 1542×2184 的灰度扫描页被缩放为 1333×1888 的 PNG 后，在下一次请求中占 2.56 MB；第一次请求只有 27.7 KB。该图片会随后续每次请求重复发送。生产中的实际比例需要开启本功能后测量。
