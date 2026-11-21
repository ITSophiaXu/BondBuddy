# 宿主固定编辑事务 v2

本页仅用于章节工作流宿主；模型输出受控业务数据，不负责事务 hash、manifest 或垃圾回收。

## 版本化请求

中期流程可在同一 `apply --operation-file` 入口提交一个 `word-edit-request-v2` 对象：

```json
{"version":"word-edit-request-v2","workspace_id":"从inspect复制","projection_version":0,"batch_id":"锁定批次ID","op_id":"update_1","node_id":"从inspect复制","expected_before":"当前完整原文","operation":{"id":"update_1","kind":"replace_text","node_id":"从inspect复制","before":"当前完整原文","after":"有依据的更新正文"},"input_hash":"请求规范JSON的SHA256"}
```

`input_hash` 覆盖除该字段外的完整请求，规范化为对象键排序、不转义 Unicode、无额外空白的 UTF-8 JSON；工具重新计算，不信任自报值。请求与 operation 的 ID、节点和 before 必须一致。工作区独占锁内重读 manifest 后校验版本、节点和原文。同一 op_id／同一请求原样重试返回原 receipt，不再次应用；同 ID 异内容、过期版本或已撤回操作明确拒绝。v2 是单个原子请求，不与旧数组／`--partial` 混用。

大表、表行等聚合节点可将 `expected_before` 与 `operation.before` 同时设为严格单字段对象 `{"sha256":"当前完整节点文字UTF-8 SHA256"}`。宿主先验证请求 hash、原 receipt、工作区和 projection_version，再从当前完整 node_text 重算 hash；只有匹配时才将 canonical operation.before 解析为完整原文并保存不可变日志。模型不能用摘要或截断文字代替正文，hash 对象不进入最终重放日志。错误 hash、额外字段或旧版本均拒绝；旧 literal v2 和 legacy 请求仍使用原规则。

`operations.json.manifest.json` 是唯一提交点，指向 `.operations.json.objects/` 的不可变 operations、projection、receipt 对象及其 SHA256。对象和目录落盘后才原子替换 manifest。`operations.json` 是兼容副本；它缺失或陈旧时，inspect、finalize、预检与反向回查仍读取 manifest 指向的已提交日志。不要删除或改写 manifest、对象、锁文件。撤回／重置仍使用固定命令，命令同步更新 manifest 并使被撤回 receipt 失效。

projection 以 `replay_overlay` 绑定底稿 SHA256、不可变操作 SHA256 和操作数，不在每次提交时重复保存整篇节点／格式。inspect、预检和最后交付仍从同一底稿及完整操作真实重放；这避免长稿逐操作写出整篇快照，又不把中间 ACK 当作全文或质量验收。

宿主维护可用 `gc --input input.json --operations output/operations.json --gc-limit 128` 有界回收异常留下的未引用对象。工具先验证 manifest 与全部历史 receipt 的可达对象，再最多扫描指定数量（上限2000）；当前对象与原 receipt 所需对象一律保留，无 manifest 或引用核验失败不删除。编制模型不需要执行此维护命令。

inspect 的 `offset` / `next_offset` 单位是节点序号（`offset_unit=node_index`），节点文字中的位置为 Unicode code points（`text_offset_unit=unicode_code_points`）。返回的 `workspace_id` 和 `projection_version` 绑定当前已提交版本。
