# 双稿历史修复验收（本地，未发布）

2026-10-27，基于 `1878d0fb685caefc4d93dbf2acb3b3df371514a9`，分支 `codex/desktop-ux-coverage-20261026`。输入与 Word 字节均为 synthetic；使用真实 PostgreSQL 16、真实 promoter/finish/receipt、Fastify HTTP 和受控私有内存字节存储。未调用真实模型、Azure、支付或浏览器，不将这些结果计为 G03 全旅程验收。

## 修复及边界

合法 revision+clean 两成员交付原先因 history 强制 baseline 而漏列。唯一公共契约将 `word_delivery.baseline` 改为可选；SQL 只在冻结 pair 未声明 baseline ID 时接受两成员，DTO 始终验证 revision/clean，仅对实际存在的 baseline 验证并返回。不创建基线，不将已声明但缺失或失效的基线降格省略。旧三成员和 legacy single/null 兼容，完整 phase、准确版本/hash、实时权限与微秒 cursor 保留，历史读取不创建下载授权。

没有新增迁移或前端流程。既有双 Word 决定已允许不交付辅助基线，见 `docs/product-decisions/2026-10-02-generated-word-download.md`；此次修复使历史接口与该决定一致。前端未直接使用此 history DTO，现有成果页双稿入口无需改动。

## 采用结果

下表为独立 invocation，**不将多轮或不同集合相加**。准确时间、参数、退出码、原始日志与 SHA-256 见 [summary.json](summary.json)、[manifest.json](manifest.json) 及 `records/runs/`。

| 集合 | 结果 | 采用范围 |
| --- | --- | --- |
| 最后一次 api-history | 17 pass / 0 fail / 0 skip | 整套历史 HTTP、实际交付 PG、生成 Word 可用性；含最后新增 baseline 字节断言 |
| api-consumers | 6 pass / 0 fail / 1 skip | 助手准确成果、集合与项目列表；此前完整冻结轮运行，后续仅历史测试 src/dist 改动 |
| contracts-check | 189 synthetic + 12 internal library examples；4 data-lifecycle examples；40 Node tests pass | 新增合法双成员、缺 clean、非法 baseline 三例，兼容原三成员/single 及其余契约 |
| 构建/类型 | contracts、API、Worker、web 类型检查通过 | API 在补最后一条 baseline 断言后重新构建；其余源码不变 |
| fresh migration | 0001…0126 全部重放通过 | 新专用 cluster/template，不复用旧迁移验收库 |

唯一 skip 为 `project collection: root membership, real uploads/downloads, task history, pagination, failed retry and owner isolation`，其既有条件需要未配置的 Azurite 连接。其余内存存储回归不被该 skip 替代，不声称此次验证了 Azure。

新增/保留的重要断言：

- 真实 finish 的无 baseline 双稿进入 HTTP history，准确 revision/clean 版本均返回；仅候选保存时仍无历史记录。后来的 mutable checkpoint 不能伪造基线。
- 三成员、single/null、两成员混合四页，保持微秒上界/after、无重复漏项；较晚成功不进入既有分页快照，INT 溢出 cursor 拒绝。
- 双成员 clean Blob 缺失或损坏返回 503；撤销成员隐藏整组，跨账号拒绝。非生产测试双成员仍需有效授权及功能开关，撤销授权后隐藏。
- 有效三成员 baseline Blob 删除返回 503；同长度末字节损坏仍返回 503；恢复后返回准确 baseline 且 grant 数不变。已有 baseline 质量失败、clean 撤销、缺 provenance 拒绝仍保留。
- 旧已交付 clean V1 不被后登记 V2 替换；无法读取任何必要私有字节时不发布不完整组合。

## 原始失败及冻结

先补契约/测试，保持生产 history 查询未改，red invocation 为 **17 tests / 15 pass / 2 fail / 0 skip**。两项失败分别是混合分页末尾漏列和真实 finish 双稿 history 返回空。修复后第一 green 为 17/17；独立审查建议补 baseline 同长损坏断言，补齐后整套最后 green 仍 17/17。第一 green 的消费者 6/1 与最后 green 不累计。

三轮各冻结 **1,900** 个真实源码/构建/契约样例/迁移文件，逐轮 before/after 完全一致。red→第一 green 仅 history 产品 src/dist 改变；第一 green→最后 green 仅 history 测试 src/dist 改变。`summary.json` 给出实际差异路径；最后快照再次逐字节核对当前文件。

保留而未改写的前提/工具失败：

1. Windows sandbox initdb 受限令牌 code87，未创建 cluster；获提升权限后在新目录成功初始化。
2. 初版 API 构建指出新增测试的 `PrivateBlobs.put` 缺 media type 参数；只修正该测试后重建通过。
3. 独立 PostgreSQL 已 ready，但初版 readiness 的 300ms 连接预算超时。原进程未重启；10 秒 probe 与恢复模式核对相同 PID、目录、端口及启动时间后通过。初版和恢复版验证脚本均按每条 `start.json.script_sha256` 保存。
4. 初版收尾 audit 把迁移自带 `bb-platform-probe-project` 误判为业务残留，audit/stop guard 拒绝，未停止进程。随后按 0027 核验唯一固定禁用平台用户、项目、输入及 principal，并继续要求所有测试业务表为空、无 clone/其他客户端。保留失败记录，不删除合法迁移种子以凑零。

## 重现及清理

Windows，Node 24.22.1，PostgreSQL 16.14。新 cluster `.local/history-pairs-postgres/data`，仅监听 `127.0.0.1:15529`，角色 `bb_history_test`，模板 `bb_history_pairs_template_20261027`。验证器清理继承的 BB/provider/Azure/PG/Node options 等环境，明确设置合成测试数据库与 Python 路径；不改全局配置或运行时/JIT。

在已安装本仓库依赖、父目录 embedded PostgreSQL 以及所列 Python 的新 checkout 中，将 `reproduction/verify.mjs` 放到 `.local/history-pairs-20261027/verify.mjs`；该模式只允许新目录，不覆盖已有 cluster/database。顺序执行：

```powershell
node .local/history-pairs-20261027/verify.mjs initdb
node .local/history-pairs-20261027/verify.mjs pg-start-direct
node .local/history-pairs-20261027/verify.mjs database-create
node .local/history-pairs-20261027/verify.mjs migrate
node .local/history-pairs-20261027/verify.mjs contracts-build
node .local/history-pairs-20261027/verify.mjs api-build
node .local/history-pairs-20261027/verify.mjs worker-build
node .local/history-pairs-20261027/verify.mjs web-typecheck
node .local/history-pairs-20261027/verify.mjs contracts-check
node .local/history-pairs-20261027/verify.mjs source-before
node .local/history-pairs-20261027/verify.mjs api-history
node .local/history-pairs-20261027/verify.mjs api-consumers
node .local/history-pairs-20261027/verify.mjs source-after
node .local/history-pairs-20261027/verify.mjs database-audit
node .local/history-pairs-20261027/verify.mjs pg-stop
```

本轮最终清理精确核对 PID **46196**、目录、端口和启动时间，模板仅保留准确迁移种子，无测试任务/成果、clones 或其他 clients。成功停止及 status=3、无 `postmaster.pid` 的原始证据纳入归档；这些旧 PID 不能用于后续轮次。

## 完整 goal 状态

G03 / UX-A03 与整体 UX goal 仍 active、未完成：同任务采用新材料、版本化报告/editor/M4 登记及检查点/调用、旧工作实际复用与增量处理、B 追加报价确认/账务和新 Word 桌面全旅程仍待完成。用户已选必要重做另行报价，具体 B1/B2 公式尚未确定。本次不实现推定价格，不重算用户旅程覆盖率，也未 push、创建 PR 或部署。
