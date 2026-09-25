# #31 模型阶段开发交接

本轮安装到 worker 的是有历史稿 `model_generation`，首个切片限同市场、同发行方式的上交所普通私募公司债。不缩减 M1 最终范围，也不关闭 #31。生产规则、财务事实入库/发行人绑定、真实模型联调和 Word 交付仍是验收前提。

## 接入与恢复

`src/historical-model-stage.ts` 导出 `historicalModelGenerationStage()`；`WorkerRuntime` 默认通过 `defaultRunStages({ model_generation: historicalModelGenerationStage() })` 安装它。沿用 `input_lock → materials_ready → model_generation → word_delivery`，不改公开 DTO、计费模式或数据库 schema。无历史稿任务不进入此阶段；未安装的 Word 阶段仍暂停。

1. `historical-generation-input.ts` 从 owner/project/input revision 读取锁定清单，校验材料版本/hash、唯一历史稿、解析作业和有效正文快照。使用原历史稿，不查 #77 参考库。
2. 首次模型调用前在私有 job checkpoint 的 `historical_generation_input` 固定 parse snapshot、profile version/hash、全部财务候选 ID/hash，以及各事实决策的 version/hash（尚无决策记为 0）。恢复时重读指定版本；缺失、篡改或身份冲突不能改用 latest。新增 `getFactDecisionAtVersion` 补充 #193 的精确版本读取，不改变原 latest reader 的行为。
3. `historical-generation-schema.ts` 只允许模型提出原文位置、候选事实 ID、公式、展示格式及逐块覆盖说明。模型不能提供最终数值、主体身份、证据或“已核验”状态。缺块、重复块、未知候选、错位原文、重叠修改和非法公式参数会被拒绝。
4. 遍历全篇有效块；每片最多 80 块/24,000 字符，prompt 最多 240,000 UTF-8 字节，总计最多 500 片。不截断超限内容；超限暂停并留下原因。完整小表尽量同片，大表不能靠片内数据伪造整列。全篇相同财务表达式合并 binding，由既有精确计算器统一计算和校验。
5. 每片经过现有 `codexModelStage`：私有 prompt 快照 → durable attempt → 模型结果/真实 usage 或 unknown。稳定 logical call ID 和 prompt 输入 hash 支持恢复复用；供应商结果未知交给现有 reconciliation，不盲目重发。进度 checkpoint 只含完成片数和块数；模型文本不进入公开事件。
6. 局部缺证据形成 `needs_confirmation` 计划及 `reviewNotes`，有依据的改动继续保留。只有占位符或没有任何可支持修改的结果暂停为 `historical_no_supported_changes`，不得当成已完成更新。

## #34 接收的数据

`ctx.values.get('model_generation')` 是 `HistoricalGenerationPlan`：保留 `historical-update-plan-v1` 字段，增加 `reviewNotes: [{recordId, message}]` 和 `generation: {version, preparationHash, chunks, reviewedBlocks}`。`planHash` 对包含扩展字段在内、去掉 `planHash` 的完整对象计算 `updateContentHash`；消费者不能只取旧字段重算 hash。所有值仍为 `deliverable=false`。

Word 端在原文锚点上执行 replacements/columns；将 reviewNotes 和 findings 中的局部缺口输出为用户可见的待人工确认标记/comments，并在结果摘要列出。不应仅因局部 `needs_confirmation` 丢掉其余有依据的修改，也不能把它升级为事实已确认。最终 Word 的来源、格式、真实修订、清洁版一致性和可获取性由 #34/#146/#17 验证。纯 domain 修改计划及 UTF-16 定位规则见 [HISTORICAL-UPDATE-HANDOFF.md](HISTORICAL-UPDATE-HANDOFF.md)。

## 真实运行的阻塞与交接

这些是开发端数据链路缺口，不是让用户重新提供已上传的四组样本。

| 原因/交接 | 当前状态及负责人 |
| --- | --- |
| `rule_pack_pin_missing` / `production_rule_pack_selector_unavailable` | #19 / loooo139：API 尚未写入可供生产验证的规则 pin；当前 input_lock 即使 pin 完整也暂停。需正式 registry/selector、规则来源及验收，不伪造审核人或绕过 gate。 |
| `historical_fact_inventory_missing` | #15 / loooo139：需要从本次已锁定材料生成候选并落库；通用解析记录/上传样本不等于已有财务事实。 |
| `historical_issuer_identity_not_bound` | #15 与 #17 输入冻结的交接：服务端须在计算 input hash 之前，把经来源核对的本发行人 FactIdentity.entityId 写入私有 manifest 的 `issuer_entity_id`。当前 input-revision API **尚未生成此字段**。不接受浏览器填写，不取候选中的第一家公司，不把子公司当发行人。需与 Xuefeng/平台对齐后接入，缺失时阶段明确暂停。 |
| `historical_profile_snapshot_missing` / `historical_structure_mapping_required` | #76 / loooo139：历史稿识别、有效基线/更正需提供对应版本；本切片不承诺跨市场/方式或扫描历史稿重建。 |
| `word_delivery` 的 `stage_not_implemented` | #34 / ChrisLiu95：需要真实 DOCX writer，消费上述内部计划并通过交付检查。 |
| 预发真实运行 | #35 / muhualing 协同：在 Linux 目标环境使用既有数据库/Blob/contained Codex adapter 配置，更新并重启 worker，记录 run ID、prompt/attempt/usage、修订稿及检查结果。仅合并代码不会部署。 |
| 真实样本解析性能 | #13/#15 / 解析负责人协同：`rq-202509-01` 在本机直接调用现有 Python parser 超过 300 秒。需在 Linux 预发复测/定位；不能据此宣称实际样本已经进入模型阶段。 |

**API 尚未写入 issuer binding 和生产规则 pin，本轮不能宣称用户上传后已经能够直接下载更新成果。** #77 不阻塞有历史稿。首个授权联调样本是 `rq-202509`：目标上交所普通私募；2023、2024年度及2025年1—9月。

## 验证方法

正常 Linux 开发/部署环境按根脚本安装及构建，然后运行：

```sh
npm ci
npm run build
node --test apps/worker/dist/historical-model-stage.test.js apps/worker/dist/historical-update.test.js apps/worker/dist/fact-decision-repository.test.js
BB_RUN_AUTHORIZED_SAMPLE_TESTS=1 BONDBUDDY_TEST_PYTHON=python3 node --test apps/worker/dist/historical-model-stage.test.js
```

模型/存储替身明确只用于组件测试。真实样本测试调用现有 Python parser、核对获授权原件 hash，再检验模型分片覆盖；不伪造财务金标准、不调用供应商、不生成 Word，也不替代全流程行业验收。原件从不修改。

2026-09-25 本轮验证环境为 Windows、Node 24.19.0：contracts/domain/API/worker 的 TypeScript 构建通过；公共契约校验通过 93 个合成例子和 12 个内部参考库例子。相关六个测试文件共 100 项：97 通过，3 跳过（真实 PostgreSQL/Azurite及默认关闭的授权大样本测试）；已启用两项合成 DOCX 的实际 Python 解析测试并通过。

额外显式启用真实 `rq-202509-01` 测试时，现有 Python parser 在 300 秒后超时，故真实样本分片验收**未通过**。该原件 926,528 字节，原始 XML 有 10,343 个段落、7,878 个单元格、134 张表；这只是只读结构统计，不是已完成解析。现有四组样本 bridge 测试在本机因 Node parser runner 只接受 POSIX 路径而失败。全 worker 测试在现有 `codex-adapter.test.ts` 的权限/进程组相关用例出现失败和超时，已终止，不能报告全绿。这些 parser/adapter 实现未在本轮修改。

当前本机未配置数据库、Azure Blob 或 DeepSeek 凭据，不能提供实际 provider/队列/Word/WPS 验收。生产 Node 22/Linux 仍须完成全套检查及上述性能复测。
