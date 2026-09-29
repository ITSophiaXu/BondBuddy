# #31 模型阶段开发交接

本轮安装到 worker 的是有历史稿 `model_generation`，首个切片限同市场、同发行方式的上交所普通私募公司债。不缩减 M1 最终范围，也不关闭 #31。生产规则、财务事实入库/发行人绑定、真实模型联调和 Word 交付仍是验收前提。

## 接入与恢复

`src/historical-model-stage.ts` 导出 `historicalModelGenerationStage()`；`WorkerRuntime` 默认经 `modelGenerationRouter` 路由到此有历史稿阶段，并安装 `historicalWordDeliveryStage`。沿用 `input_lock → materials_ready → model_generation → word_delivery`，不改公开 DTO、计费模式或数据库 schema。无历史稿任务不进入此阶段；当前默认已安装历史稿 Word 阶段，最终交付仍须通过其检查。

1. `historical-generation-input.ts` 从 owner/project/input revision 读取锁定清单，校验材料版本/hash、唯一历史稿、解析作业和有效正文快照。使用原历史稿，不查 #77 参考库。
2. 首次模型调用前在私有 job checkpoint 的 `historical_generation_input` 固定 parse snapshot、profile version/hash、全部财务候选 ID/hash，以及各事实决策的 version/hash（尚无决策记为 0）。恢复时重读指定版本；缺失、篡改或身份冲突不能改用 latest。新增 `getFactDecisionAtVersion` 补充 #193 的精确版本读取，不改变原 latest reader 的行为。
3. `historical-generation-schema.ts` 只允许模型提出原文位置、候选事实 ID、公式、展示格式及逐块覆盖说明。模型不能提供最终数值、主体身份、证据或“已核验”状态。缺块、重复块、未知候选、错位原文、重叠修改和非法公式参数会被拒绝。
4. 遍历全篇有效块；每片最多 512 块/24,000 字符，prompt 最多 240,000 UTF-8 字节；首次调用前固定完整分块清单，超过 32 个逻辑调用即暂停。不截断超限内容；超限暂停并留下原因。完整小表尽量同片，大表不能靠片内数据伪造整列。全篇相同财务表达式合并 binding，由既有精确计算器统一计算和校验。
5. 每片经过现有 `codexModelStage`：私有 prompt 快照 → durable attempt → 模型结果/真实 usage 或 unknown。稳定 logical call ID 和 prompt 输入 hash 支持恢复复用；供应商结果未知交给现有 reconciliation，不盲目重发。进度 checkpoint 只含完成片数和块数；模型文本不进入公开事件。
6. 局部缺证据形成 `needs_confirmation` 计划及 `reviewNotes`，有依据的改动继续保留。只有占位符或没有任何可支持修改的结果暂停为 `historical_no_supported_changes`，不得当成已完成更新。

## #34 接收的数据

`ctx.values.get('model_generation')` 是 `HistoricalGenerationPlan`：保留 `historical-update-plan-v1` 字段，增加 `reviewNotes: [{recordId, message}]` 和 `generation: {version, preparationHash, chunks, reviewedBlocks}`。`planHash` 对包含扩展字段在内、去掉 `planHash` 的完整对象计算 `updateContentHash`；消费者不能只取旧字段重算 hash。所有值仍为 `deliverable=false`。

Word 端在原文锚点上执行 replacements/columns；将 reviewNotes 和 findings 中的局部缺口输出为用户可见的待人工确认标记/comments，并在结果摘要列出。不应仅因局部 `needs_confirmation` 丢掉其余有依据的修改，也不能把它升级为事实已确认。最终 Word 的来源、格式、真实修订、清洁版一致性和可获取性由 #34/#146/#17 验证。纯 domain 修改计划及 UTF-16 定位规则见 [HISTORICAL-UPDATE-HANDOFF.md](HISTORICAL-UPDATE-HANDOFF.md)。

## 真实运行的阻塞与交接

这些是开发端数据链路缺口，不是让用户重新提供已上传的四组样本。

| 原因/交接 | 当前状态及负责人 |
| --- | --- |
| `rule_pack_pin_missing` / 规则适用性未批准 | #19 / loooo139：registry、API pin、整体审核/撤回与loader代码已有；已发布字典、真实项目整体审核及正式发布仍不能用合成测试代替。#35 当前观测为 `rule_applicability_overall_review_required`。首次内部授权测试的执行接缝需单独交付，不伪造审核或绕过生产gate。 |
| `historical_fact_inventory_missing` | #15 / loooo139：需要从本次已锁定材料生成候选并落库；通用解析记录/上传样本不等于已有财务事实。 |
| `historical_issuer_identity_not_bound` | #15 与 #17 输入冻结的交接：服务端须在计算 input hash 之前，把经来源核对的本发行人 FactIdentity.entityId 写入私有 manifest 的 `issuer_entity_id`。API现已通过已核对主体绑定生成该字段，须保持与财务候选identity一致。不接受浏览器填写，不取候选中的第一家公司，不把子公司当发行人。需与 Xuefeng/平台对齐后接入，缺失时阶段明确暂停。 |
| `historical_profile_snapshot_missing` / `historical_structure_mapping_required` | #76 / loooo139：历史稿识别、有效基线/更正需提供对应版本；本切片不承诺跨市场/方式或扫描历史稿重建。 |
| Word真实成果验收 | #34 / ChrisLiu95：writer已安装，仍须用实际模型计划完成修订版/清洁版交付检查和WPS实测。 |
| 预发真实运行 | #35 / muhualing 协同：在 Linux 目标环境使用既有数据库/Blob/contained Codex adapter 配置，更新并重启 worker，记录 run ID、prompt/attempt/usage、修订稿及检查结果。仅合并代码不会部署。 |
| 真实样本有效基线/候选状态 | #13/#15 / loooo139：早期 Windows 300秒超时已有后续 Linux 约3–5秒解析证据，不继续列为通用性能阻塞。#314 实际16条年度候选仍是 `external/needs_confirmation`，且 `DOCX_DRAWINGS/DOCX_AUXILIARY_PARTS` 警告尚会影响基线入口；需按具体证据处理，不能批量清空。 |

**API的issuer binding、规则pin与整体审核loader已有实现；实际审核/发布、内部授权测试入口及真实财务/模型/Word验收仍不能由组件测试替代。** #77 不阻塞有历史稿。首个授权联调样本是 `rq-202509`：目标上交所普通私募；2023、2024年度及2025年1—9月。Word/WPS桌面兼容性由#146独立跟踪，不作为#20关闭或生成同一份首次工作稿的前置。

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

## 2026-09-27 #20规则正文接入

`historical-generation-input.ts`读取持久化的 `ProductionRulePackPin.packId/version/contentHash`（修复旧snake_case读取），调用 `loadHistoricalRuleGuidance` 复用 `revalidateProductionRulePackPin`，再按已有适用性逻辑筛出规则和源。输入包含规则正文、例外、要求证据、来源原文/定位/版本及content hash；规则文本只作参考数据，不能提升用户事实状态或授予执行权限。v3的十一项研究checker不会由本阶段自动启用。

正式规则缺失/撤回转 `capability_not_ready`，内容或pin不一致不能选最新版本重试。正文超过180,000字节或完整prompt超过240,000字节时明确暂停，不截断。模板升为 `historical-sse-private-v2`，旧v1绑定回放会在供应商调用前报告 `UPDATE_GENERATION_INPUT_CHANGED`；不要删旧checkpoint/attempt冒充重试，保留原任务记录并按既有流程处理新run。

因表达式暂不能完成的法律条款改写/章节重组仍须标needs_evidence及待人工确认，不以retain隐去。新增研究输入与#15/#19交接见[工程记录](../../docs/acceptance/issue-20-rule-integration-2026-09-27.md)。

## 2026-09-27 #31财务来源接入

`historical-fact-policy.ts`统一worker的材料/证据映射；domain导出`isUsableHistoricalFact`供prompt候选筛选和确定性规划共用。锁定审计/财务/中期报表/附注及唯一历史基线的候选全部保留在冻结清单中，包括不确定候选；仅可用组进入模型。历史事实证据另逐项匹配有效基线的record、材料/version/hash、quote、locator及extractor version，不能读取已删除旧修订或另一个解析版本。

`audited/external`与`extracted/verified`是两条独立维度：有完整证据、已知值、足够置信度且无uncertainty的`external/extracted`可以支持工作稿修改，既有状态和审计范围不变。公式缓存、未核OCR、用户口述、参考企业材料和假verified不可进入；同一身份有存疑竞争候选时不隐藏它来提供干净候选。冲突仍需精确版本决策，选中不提升候选状态。数据的合并/母公司、期间、单位/币种、会计基础和版本继续由原身份约束。

prompt提供`source_kind/material_id/material_role`并禁止冒称审计机构确认；实际采用external的每个原文位置（包括插列）保留来源待核说明。模板升为`historical-sse-private-v3`，已有v1/v2模型绑定不可静默复用，发现绑定变化在新增供应商意图前报告`UPDATE_GENERATION_INPUT_CHANGED`；保留旧run/attempt/checkpoint并按新执行流程处理。

本切片不会清除#314的16条年度uncertainty，不新增#316的8项当期公式候选，不部署、不调用真实供应商。详见[验收与剩余依赖](../../docs/acceptance/issue-31-financial-input-2026-09-27.md)；[8项业务核对交接](../../docs/acceptance/issue-15-rq202509-review-handoff-2026-09-27.md)用于后续逐项确认，不是已签认结果。

2026-09-27评审修复：模型coverage允许1200字符的reason，Word单条批注保持512个UTF-16代码单元限制。`historical-review-notes.ts`将过长的完整说明按同一record分为有顺序编号的批注，不截断原因或external来源限定，不拆开代理对；总条数仍限1000，超限在模型计划阶段明确暂停为`historical_review_notes_exceed_limit`，不等Word阶段报笼统校验错误。#323已将8个公式缓存格落为external/needs_confirmation候选，本消费者仍排除其公式/来源链不确定性，保留冻结清单供审核。


## 2026-09-30 容量修复

原文及规则以 columns/rows 无损去除重复字段名，不删原文、来源、例外、事实或待核状态。新增整体 batch plan pin，旧模板调用不能静默按新分块回放。授权原 DOCX 的 9,690 条记录在完整规则＋20KB 其余上下文预留的离线检查中为 24 块；实际平台 pin 的块数与真实 token/Word 仍须验证。详见[容量验证与恢复要求](../../docs/acceptance/issue-31-bounded-context-2026-09-30.md)。
