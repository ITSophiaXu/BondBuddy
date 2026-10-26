# 暂停后补料并继续原任务：现状审计与实施提案

日期：2026-10-26。审计基准：`50bd3dfb`，本地产品修复提交：`4cd1c39a`。

**状态：需求已确认；用户已选择 B——重做部分另行报价，确认追加金额后继续；具体报价公式待确定。补料准备的保存/读取协议已在本地实现，采用新输入并续做的协议仍未实现或通过验收。** 用户无需再次决定是否需要这项能力或是否另行报价。本文不改变现行计费、不宣称发布，也不将原任务换成新业务 run。

## 已确认的目标与当前证据

| 要求 | 当前权威依据 | 审计结论 |
| --- | --- | --- |
| 主动暂停，补齐材料，继续同一任务，最终成果反映补料 | [v6.1 UX-A03](../testing/bondbuddy-test-plan-v6/user-scenarios.md#ux-a03-运行中漏材料想暂停补齐后继续原任务)，尤其第 252–256 行 | 业务目标已确认，不能以取消后新建或下一轮草稿替代 |
| 暂停立即冻结计费，当前调用保存后停在检查点 | [10/11 实时进度决定](../product-decisions/2026-10-11-authoring-live-progress.md)，第 25 行；`apps/api/src/queue.ts:148`、`:255` | 后续已实现暂停；旧 FG-001“没有 pause”不能继续当作现状 |
| 原任务充值恢复，复用固定输入与检查点 | [10/11 动态积分决定](../product-decisions/2026-10-11-authoring-dynamic-balance.md)，第 6–9 行 | 已定义普通恢复，明确使用原不可变输入，没有采用补料的约定 |
| M4 和复核的动态积分及人工暂停优先 | [M4 动态过程](../product-decisions/2026-10-13-material-dynamic-progress.md)、[复核过程](../product-decisions/2026-10-13-review-live-workflow.md) | 后续已覆盖这两类任务的普通暂停/恢复，未定义补料重做 |
| 不把新上传材料偷偷用于旧任务 | `apps/web/src/project-execution.ts:386`；[10/20 项目更新计划](../plans/2026-10-20-update-project-e2e.md)，第 22–24 行 | 当前保护是正确的；它不能替代新增的明确采用协议 |
| 旧输入、已完成调用和账本可追溯 | UX-A03 第 253–254 行；`AGENTS.md` 公共契约约定 | 必须保留，不得覆盖旧 snapshot、删除调用或重置消耗来假装续做 |

源码核对：`packages/contracts/src/index.ts:298` 的 `RunActionRequest` 仅包含 `reason`；第 441–443 行的 cancel/pause/resume 共用该请求。`apps/api/src/server.ts:1536` 将这三类请求交给 queue；`queue.ts:255–314` 的 resume 只恢复原 job，没有新输入采用步骤。`apps/worker/src/run-pipeline.ts:592` 从 run 读取同一个输入，`:593` 从单一 stage 检查点恢复；`file-authoring-stage.ts:26` 按该 input_hash 验证已保存模型结果。仅把新 input_hash 换入 run 会破坏这些关联，不能作为实现方案。

最初审计时，`apps/worker/src/authoring-pause.pg.test.ts` 的单条测试只验证“保存当前处理后暂停，继续时不重复已保存步骤”；没有补料或新输入。后续[初始执行身份专项](../acceptance/desktop-ux-coverage-20261026/initial-execution-identity/README.md)已增加完整 main 下受控本地 adapter 在途调用保存、暂停、补料准备和原结果复用证据。它证明固定输入恢复的真实 worker 机制，仍没有采用新输入，也不能证明 UX-A03 已完成。最初的源码缺口没有被伪报为一次运行失败。

因此：FG-001 历史暂停入口缺口已被后续能力覆盖；FG-002“新材料明确进入同一业务任务”仍为 `functional_gap`；补料后的输入/执行版本与必要重做费用仍有 `design_gap`。UX-A03 新协议验收为 `not_run`。既有 15/15 旅程和 662 个浏览器 pass 保留其原始证据范围，完整 goal 尚未达到主要功能全部覆盖。

## 桌面操作提案

沿用现有任务过程页和材料区，不增加导航页面。募集书编制/更新、完整或差异复核、单份 M4 文书的任务面板采用相同动作；文件包逐份任务和整包“停止后续”保持各自含义，不把一个文件的续做扩展为全包重开。QA 和诚信核查没有这项已确认的编制补料流程，不借本提案改变其执行/收费。

1. 用户点击现有“暂停”。保存中显示“正在保存进度后暂停”，积分按现行规则冻结；只有服务端确认暂停且没有在途调用待核对，才开放“补充本次材料”。
2. 在原材料区上传/选择补充资料。分别显示“文件已保存”和“尚未用于本次任务”；上传失败、回执未知可恢复，保存不等于采用，也不启动执行。
3. 展示本次继续将使用的清单：原资料、补充资料、明确替换的资料，以及从已保存工作继续处理的范围。用文件名、版本和业务说明呈现，不向普通用户暴露 run ID、hash 或 attempt。
4. 只有资料准备就绪且费用规则已说明后，用户点击“采用补充材料并继续本次任务”。这一次动作固定新输入版本、记录采用回执并恢复原任务；不要求新建项目或重复整个准备流程。
5. 页面仍显示原任务和原开始时间，过程记录说明“已采用本次补充材料”。成果下载对应最后采用的输入；可核对本次采用资料及先前记录。

“继续原材料”保留为单独动作；有已保存但未采用的补料时需明确说明这些资料不会用于该动作。放弃补料只放弃本次采用草稿，不删除已保存文件或原输入。充值、上传完成、刷新和另一个页签的旧响应均不能替代用户的采用授权。

## 输入与执行协议提案

以下执行版本和采用协议仍是实现前可审阅的设计；已经实现的准备协议单独列在下节，不代表采用能力。

已落实一个独立前提：新增迁移 `0117_run_origin_input_immutable.sql` 保护已有任务的原 run/owner/project、原 input revision/hash 和原执行请求身份，正常状态、积分与成果更新仍可执行。隔离 PostgreSQL 回归为 34 pass / 0 fail / 1 skip；[验证范围与原始记录](../acceptance/desktop-ux-coverage-20261026/run-origin/README.md)单独列明。该保护没有增加活动执行版本、新材料采用、追加费率或续做能力，以下新协议仍为 proposed，G03 不关闭。

后续迁移 `0119_initial_run_execution_identity.sql` 已追加不可变初始 V1，真实 queue、Lease、prompt、provider、OCR 和独立 worker 写入核对准确身份；数据库仍明确禁止 V2。当前又通过 `readRunExecutionInput()` 将补料准备与 M1/M3/M4 实际 loader 接到同一准确输入读取，M3/M4 gate 消费该读取返回的归属一致快照。它没有版本化原业务表或开放后继执行；[候选输入专项](../acceptance/desktop-ux-coverage-20261026/supplement-input/README.md)记录当前边界。

本地追加 `0120`、`0121` 后，带准确 prompt 的模型调用还会自动保存不可变 execution/input 绑定，真实 provider latest、结果恢复、runtime 和 observation 读取实际核验该绑定。补料保存事务在同一安全人工暂停边界冻结 checkpoint 及准确已完成结果引用，旧回执不会冒充已有捕获；进度变化会提示重新保存。内服读取旧结果时核验原输入、schema、字节及清理记录，并与 prompt/provider 内容清理串行。它只冻结私有来源，尚未把旧 Word 文件交给后继业务处理，也不延长原清理或账号/项目删除规则。详见[保存工作引用验收](../acceptance/desktop-ux-coverage-20261026/supplement-saved-work/README.md)，G03 仍开放。

- 保留 `bb_runs` 的原始执行请求和原始输入关联；每份 `bb_input_revisions` 继续不可变。追加“run 的执行版本”关系，记录业务 run、序号、前一版本、本次完整输入 revision/hash、补料采用请求及旧工作引用。活动版本以 CAS 推进；不得原地修改旧输入或执行请求哈希。
- 补料草稿从该任务的已采用输入构建，不从项目最新草稿猜测。原始募集书、目标企业/期间、文种、规则、模板及授权保持明确。可新增或明确替换证据材料；修改任务目标、文种或范围须先按现有业务规则确认，不能借补料隐式改变任务类别。
- 拟新增 owner-scoped 的续做准备/读取和明确采用操作，唯一 schema 放在 `packages/contracts/`。采用请求携带幂等请求 ID、预期活动执行版本、预期暂停边界、完整新输入引用及费用确认引用。旧 `resume {reason}` 继续表示原输入恢复。
- 采用事务锁住 run、job 和所需账务对象，核验用户/项目/文件归属、输入 hash、暂停状态、无有效执行租约、无未核对供应商调用、版本 CAS 和取消/交付竞争。输入关联、采用回执、活动版本及 outbox 同事务提交。重复请求读回同一采用结果；同 key 不同内容拒绝；两个页签只有一个版本可被采用。
- 安全暂停需有持久边界及已保存调用结果；租约过期本身不能证明旧进程/供应商已停止。采用前核对整个 job 历史中所有未决调用，新逻辑调用身份不能绕过旧调用核对。事务锁顺序需与项目互斥、账务、成果登记和取消路径一致，避免新增死锁反转。
- 新增只读采用回执查询。响应丢失后按原请求读取结果，不凭页面超时再次采用或重扣。已采用但列表读取失败显示真实保存事实，不回退为“未采用”。
- 检查点、模型逻辑调用身份、prompt、文件结果及最终成果都绑定执行版本及准确输入。未受影响的解析/材料结果按准确 pin 复用；旧模型调用及用量记录全部保留，未知调用先核对，不能重发。
- 已完成旧模型结果且后来补料时，从旧结果及新增/替换的证据发起明确的增量处理调用，记录其依赖和受影响范围；这属于新输入需要的工作，不重放原已完成调用。不存在可用旧结果时先如实保留状态并按新输入开始尚未完成的工作，不能伪称复用。每个业务执行器须实现并验证这条规则，不能只给队列换输入而继续跳过旧 stage。
- 单次 CLI 编制目前没有可直接复用的章节依赖图。新增处理调用须收到准确旧工作文件、材料变化、完整采用清单及重做计划；无法可靠定位影响范围时，保守复核所有依赖该材料的正文工作，保留原调用不变并使用新调用身份，不能声称已经做到局部复用或重复发送原 prompt。
- Word/复核报告/编制说明及下载登记都绑定最后采用的版本。旧输入形成的暂存文件只作为准确标识的旧工作记录；不得在采用新材料后把旧结果当新成果交付。文件族、成果卡、原稿来源和继续修改入口同时读取该绑定。
- 账务计量仍跨执行版本单调累计，暂停/准备补料不计时；每个版本保留其样本及既有扣款关联。不能重置计时、按原检查点重复累计或抹除旧消费。新材料采用与取消/到账/自动恢复的竞争统一通过 run/job 锁裁定，人工暂停期间自动续跑不能越过采用确认。

### 必须一起修改的现有边界

| 当前边界 | 新协议需要的处理 |
| --- | --- |
| Lease 已必带 V1/revision/hash，queue、provider、OCR 和独立写入已检查准确身份；当前无可执行后继版本 | 后继采用时继续核验活动版本及租约；旧执行版本的迟到写入不得进入新版本，不能直接放宽现有 V1 限制 |
| prompt snapshot 已锁住原任务并验证准确 V1 输入，保留原身份约束 | 后继输入须有准确执行关联与授权；不能直接去掉检查。Run DTO、执行回执和历史明确区分初始输入与当前采用输入，保留原执行请求的幂等身份 |
| `durable-probe-journal.ts:81` 按逻辑调用查最后 attempt；file authoring 使用常量 `file-authoring-v1` | 每个执行版本使用稳定的工作单元身份及依赖指纹；崩溃恢复重用同一调用，补料的新处理使用新身份。不能靠盲目增加 attempt 重放旧工作 |
| stage 检查点仍只按 stage 名索引；共享输入 reader 与三个实际 loader 目前只接受 V1 | 后继执行统一解析活动版本；按阶段依赖判断复用/新处理，保留旧检查点。不能复用依赖已变的 stage，也不能把所有 stage 一律清空重跑 |
| 旧 `bb_review_executions` / `bb_review_reports` 和 `bb_m4_executions` 保留 run 唯一约束；0124 已追加完整身份的业务快照，0128 已追加准确执行版本的 canonical 结构化报告，0129 已追加 M3 文件成果登记并迁移实际消费者 | 仍须开放受控的后继业务快照创建并版本化 M4 成果登记；模型、交付及历史继续核验准确版本，旧记录保持不可变。当前只有 V1 不能支持后继执行 |
| 本地 `0127` 已将复核 editor 正文追加到 `(run_id, execution_version)` canonical 表，V1 保留旧表镜像；API、writer、导出 pin 和本机恢复记录带准确执行身份，[专项验收已封存](../acceptance/desktop-ux-coverage-20261026/execution-editors/README.md) | editor 拆分不等于报告、M4 或成果登记已全部版本化；全局 V1 gate 和 current-input integrity 共享 view 未改，仍不能采用后继输入 |
| `0125` 已追加不可变 artifact→准确 V1 执行/输入关系，实际 API/Worker 成果消费者读取严格来源 view；0129 的 M3 文件登记使用 `(run_id,execution_version,kind)`，M4 仍按 run/kind 唯一 | 后继采用时仍须版本化 M4 登记并开放受控新成果来源，保留历史关联与当前结果投影；不能只放开 V2 约束。项目募集书、文件族、previous_output、复核来源和助手续改继续读取准确版本 |
| `0126` 已冻结准确 V1 实际交付成员、命名、配对和时间，下载/历史/命名/previous_output 使用交付记录；旧非动态 M4 的耐久读取独立记录 | 仍须把后继执行的业务报告/成果登记版本化，并以采用回执与增量处理实际消费前序工作；不能把候选可用状态或另一阶段的 durable 权限当作新版成功交付 |
| `0097_m4_cross_project_material_retention.sql` 的材料 pin 判定沿原 run 输入/M4 快照读取 | 保留所有已采用执行版本、旧模型结果及历史成果所引用的材料字节，不能只 pin 原输入或当前输入。清理/归档/账号删除继续遵守既有生命周期政策 |
| run 的 `test_grant_id` 绑定原不可变输入；规则/模板、source metadata 和跨项目材料也有准确授权范围 | 每个新执行版本重新核验所用输入的授权，必要时记录版本级 grant；不改写或借用原 grant 授权不同输入，不绕过原有测试/生产隔离 |
| 双 Word 已保存、尾款不足时也可能处于暂停 | 采用补料后，旧暂存 Word 的输入归属继续保留，新版本不得直接复用旧交付登记；在正确新成果完成后才进行一次最终结算/开放下载。与成功终态竞争时只有一个事务胜出 |

上述只描述追加兼容方案；所有 migration 只能新增。既有 run 追加初始版本关联，不改写原输入、供应商调用或账本历史。代码实施还必须覆盖测试授权的准确输入绑定、项目活跃任务互斥、模型预算和材料生命周期，不借补料跳过任何已有授权检查。

## 已实现的独立切片：按原任务保存补料准备

本地新增 `GET/PUT /runs/{run_id}/supplement-draft`，公共 schema 唯一定义在 `packages/contracts/src/run-supplement.ts`，迁移 `0118_run_supplement_drafts.sql` 只追加不可变准备回执。M1 编制/更新、M3 复核和单份 M4 文书的暂停页共用真实面板：先完成原文件上传，再明确保存补料草稿；可新增或明确替换原任务中的准确材料版本，替换类别沿原材料。没有增加采用、活动执行版本、队列任务或追加计价。

准备依据为原 run 的固定输入和对应 M3/M4 不可变执行快照，不读取项目后来编辑的目标/要求作为基础；M4 原有跨项目来源保留，新增材料限定同 owner 的该任务项目。保存必须处于服务端持久人工暂停、无租约、无待核对调用的边界，沿用 queue 完整供应商核对规则。归档、删除、错误归属/hash、重复或冲突替换均拒绝；仅因积分耗尽自动暂停不开放保存。人工暂停与耗尽并存时，只要安全边界已持久化，仍可免费准备。

每次保存使用预期草稿 revision 和请求身份：并发页面仅一个 CAS 成功，相同请求重放同一回执，相同 key 不同内容拒绝。GET 可按原 `request_id` 读取准确回执，并与 PUT 使用相同 run 锁，响应未知时不能凭超时换 key。文件上传的恢复记录与业务草稿保存独立；本机待确认请求跨刷新保留。冲突先保留本页选择，只有用户明确选择后才使用最新内容或再次保存。迟到读取不能将已确认新版本回退成旧版本。

保存前后原 run/job、输入、业务快照、项目草稿和已有非空积分账户/流水保持不变；只写准备 revision 与明确的 outbox。草稿独有材料不获得永久保留 pin。普通“按原材料继续”仍走原 resume，在存在本机或已保存补料时明确确认排除这些资料，不会偷偷采用或保存；未知原回执未核实前不得绕过。页面明确区分“文件已保存”“草稿已保存”和“尚未采用”，采用按钮继续禁用并说明 B 的追加计价口径待确定。

验证与当前源码绑定见[补料准备专项验收](../acceptance/desktop-ux-coverage-20261026/supplement-preparation/README.md)。隔离真实 PostgreSQL/HTTP 与合成桌面组件测试分开记录，均不冒充完整新输入续做、模型处理或最终 Word 验收。**G03 / UX-A03 仍未完成，原目标保持 active。**

后续[真实主页面联通专项](../acceptance/desktop-ux-coverage-20261026/supplement-preparation-real/README.md)又验证完整 main → session/CSRF → PG → 私有本地字节上传/下载 → 准备保存 → 刷新 → 明确原材料恢复，含准确失落回执和两个浏览器 context 的 CAS，最终 6/6；后端准备专项 44/44。同时修复真实 `review-updates` 任务的 `authoring.review_result` 合法输入被误判 503 的兼容问题，原快照/输入/账本和 job 身份保持。普通 queued 起点和合成源成果均明确标记，没有模型保存进度暂停、采用新输入、追加报价/收费、Azure 或新 Word 证据；该联通专项仍不关闭 G03。

### 当前候选输入与材料核对

`GET/PUT supplement-draft` 当前还会按冻结 manifest 和准确准备回执确定性编译完整候选输入。可表达的普通补料同步 M1 材料、M3 输入与候选快照、M4 证据清单，原目标、知识、要求和来源保持；响应仅增加 `input_preview` 的编译版本、候选 hash 和材料核对结果。页面在保存回执确认后显示核对结果和完整材料清单，本机未保存变更不会沿用旧“已核对”提示。

M1 新历史/参考原稿当前可在补料中填写准确原稿声明，复用唯一 `SourceProspectusSchema` 和原填写控件；声明绑定准确 material/version/hash，不继承旧稿或目标报告期。来源集合改变且原任务关联 `previous_output` / `edit_baseline` 时，只有明确选择在本次候选中放弃旧成果关联才可完成候选编译。原任务、旧输入、原成果不被删除或修改，尚未采用的候选也不会执行。新声明未填完整仍可免费保存，预览如实列出缺项；来源字段和明确选择进入原 changes 的请求 hash、CAS、回执恢复及本机刷新协议。

已确认复核范围/报告续改、M3 被引用证据替换或修订导出、非 Word/PDF 复核原稿，以及 M4 主文档/模板替换仍会保留草稿并显示明确限制；不能用形状合法的旧 pin 或声明假装新材料已经可执行。登记材料被删除或登记校验不符时不返回候选 hash；预览不读取 Blob，实际字节仍由执行门验证。候选只在读取/保存响应中计算，没有新输入 revision、持久候选表、采用回执、新保留 pin、报价或执行授权。`prepared` 只表示材料候选可完整编译，原任务的其他业务门、后继版本协议和已确认追加报价仍须逐项满足。历史证据见[候选验收](../acceptance/desktop-ux-coverage-20261026/supplement-input/README.md)，本轮证据见[来源与文件读取验收](../acceptance/desktop-ux-coverage-20261026/supplement-source-files/README.md)，G03 保持开放。

### 私有旧工作文件的实际边界

服务内部可从准确补料回执的冻结 checkpoint 和已完成 provider JSON 派生文件 pin，逐项绑定 owner/project/run、草稿 revision、execution/input、来源 hash、准确文件名/key/hash/size。读取再次核对完整 pin 并 bounded 校验字节；损坏、缺失、错误调用目录、错误 schema 或 prompt/result tombstone 均拒绝，不调用模型、不扣费、不创建 artifact 或下载 grant。已保存 JSON 的计数不等于文件可用；缺工作文件不阻止免费保存材料。

实际文件来源包括 provider-backed M1/M3/M4、M3 本地 `correction_result`，以及项目文件操作的本地结果。最后一类目前没有开放 HTTP 补料准备，不能以底层文件格式识别宣称其已支持补料。旧版纯本地 Word writer 的 JSON 可能只有 plan/report，只有已提升 artifact 或准确 pair checkpoint 才能证明存在对应 Word，不能推造文件。

来源与文件读取专项曾确认 `owners/...` 原始工作文件没有完整 inventory/intent/tombstone：当时内容清理删 provider JSON，项目清理删已提升 artifact 的复制品，均不足以证明所有原始工作文件已清除。该轮记录保留原来的缺口和验证范围；后续生命周期增量见下节，不能将后来的实现倒记为此前已经通过。

### 后续独立增量：原始工作文件生命周期

基于 `a35034b3` 的本地增量追加 `0122_run_working_file_lifecycle.sql` 与 `0123_run_working_file_result_claims.sql`，不改写已经应用的 `0122`。九个实际 writer 模块的原十处 Blob put 接到共同 writer：先提交准确物理对象及 execution/input/producer 来源声明，再取得 run/file 内容锁，重新核验后写入、读回并记录 `stored_at`。物理对象和多个准确来源分表保存；同一文件可由不同 producer 或本地 correction 共同引用，一次收集器内曾写入但后来被替换的 report hash 也保留清理地址，不依赖最终 JSON 是否选中它。

清理沿既有日志内容窗口，默认 180 天，仅对终态工作执行年龄清理；活跃及人工暂停任务继续保留。账号关闭沿既有关闭规则，项目删除沿现有 storage 删除窗口，不新增产品时长。清理先持久化单调 `purge_started_at`，使迟到写入和读取立即失去权限，再删除准确对象并记录 `purged_at`；删除或回执失败可从同一地址重试。prompt/provider 父内容删除前须登记仍可准确核验的已知 legacy 文件并完成到期附件清理；已登记 raw 文件但尚无 result 的失败窗口也会通过准确来源关联处理。

复核发现旧父内容清理可能漏掉同 run 较新 legacy 结果对同一 correction 文件的引用；原 source 唯一键也可能合并同一 attempt 的多个不可变结果，丢失较新的准确留存时间。现行年龄清理在 W/F 锁外先逐个核验该 run 全部已知 collector 结果，再持 run 行锁核对准确 result ID 集合未变，随后取得 W/F 并重判到期；集合变化则保守失败，下一轮重新发现。`0123` 把准确 `discovered_result_id` 纳入来源唯一性，预写 claim 与每个真实结果候选各保留原时间，不由清理选择成功结果或消解调用冲突。已持久化的清理标记重试及账号/项目删除不依赖这次年龄发现。

legacy 登记后只有准确 raw 字节经 bounded 长度/hash 核验才记录当下的 `stored_at` 观察，避免新登记反而阻断仍应保留的有效旧文件；缺失/损坏 raw 保留清理地址与来源、`stored_at` 仍为空，实际 reader 继续拒绝。观察不是历史写入意图或历史存储时间，也不重置按对象/来源时间计算的留存窗口；不能复活已经开始清理的文件。

组合内容锁遵守 prompt/result → run 工作 → 准确文件的相对顺序（同时需要两个父锁时为 prompt→result），关系范围锁在内容锁前取得。内服 captured-file 与公开 readable-report 均在等待后重验归属和父/文件清理状态，已清理登记即使仍有残留字节也拒绝；有效旧来源缺 registry 时不伪造历史写入事实。存储扫描新增 `owners/`，已登记存储、未完成写入、未知/清理中/已清理残留分开报告，未知文件绝不按目录前缀自动删除。

详细范围、复现与所选轮次见[工作文件生命周期验收](../acceptance/desktop-ux-coverage-20261026/working-file-lifecycle/README.md)。`0122`、`0123` 已分别实际应用，最终构建/类型/契约检查通过。工作文件专项 31 pass、worker 108 pass/12 skip；API 完整集合为 264 pass、1 fail、30 skip，唯一失败是合成 readable-retention fixture 缺必要 raw Word，补齐该测试后准确组 9/9。完整 API 未重跑，不相加冒充一次全通过；五个 Windows sink 标题是额外按名排除，不计入 30 skip，也不构成验收。两次冻结间自动核对仅该测试 src/编译 JS 变化，生产源码无变动；最终 before/after 2052 项一致，数据库空模板无测试 clones，本轮专用 PostgreSQL 已按准确 PID 停止，证据均列入专项 summary。本次没有接通后继采用/生成、追加计价或新版 Word。历史上父内容已先清理且未登记的 raw 文件仍可能只能诊断；不可变数据库 editor 正文生命周期和 provider JSON 自身的一般写入意图窗口也不在本次修复范围。G03 / 完整 UX goal 继续 active、未完成。

### 执行版本业务快照基础

追加 `0124_run_execution_business_snapshots.sql`，将完整 M3/M4 业务快照固定到 owner/project/run/execution_version/input_revision/input_hash，保留旧业务行、业务版本和原创建时间。已有 V1 精确回填；现有业务创建入口在同一事务自动桥接，缺失/不符拒绝整笔创建。迁移按 M4 的 topic→input 顺序排空行锁；材料版本的 JSONB `1.0` 沿现有整数契约处理。

共同 reader 和真实 M1/M3/M4 loader 读取准确输入及新表；M3/M4 独立 gate、input_lock 和模型调用前复核同样接入。缺少必需快照不得借用旧表，传入快照不能绕过持久执行身份。普通 M1 不凭空要求业务快照。此基础仍保留 V1 限制，尚未提供采用、新报告/成果身份、后继调用或追加计价；G03 继续开放。

### 成果执行来源基础

`0125_artifact_execution_bindings.sql` 已为全部 artifact 状态及业务版本保存完整执行/输入身份和原创建时间，真实 Word、PDF、M4 文本 INSERT 同事务桥接。绑定与文件核心身份不可变，交付状态/证据仍可推进或撤销；缺失或不符不能通过旧 artifact/run 行推断来源。严格 V1 view 及共享读取已接入历史、下载、项目文件/募集书、复核、助手、M4 与 Worker 原成果 pin。结算保留原行锁，不经 view 锁住输入表。用户上传和离线回存的独立 runless 文件版本不受此来源桥接影响。

验证范围与失败/复验记录见[成果来源验收](../acceptance/desktop-ux-coverage-20261026/artifact-execution-bindings/README.md)。该基础没有开放 V2 或后继调用；stage/pair 检查点、按 run 唯一的报告/业务成果登记和输出 ID 仍须追加版本关系。也没有采用新材料、追加报价确认或新 Word 全旅程证据，G03 保持开放。

### 实际交付记录基础

追加 `0126` 冻结每个 V1 实际交付的准确成员、文件版本/hash、命名、配对、终态及时间；候选已保存不等于交付。真实终态与结算在同一事务捕获，失败一并回滚。公开通用读取、历史、助手准确成果选择、最新成果和 Worker previous_output 使用该证明；历史在完整 final phase 校验后直接读取准确成员，避免重复展开来源 view。当前 job 配对、run 主文件或更新时间不改写旧交付；实时撤销、归属、测试授权过期仍须核验。

旧非动态 M4 的已登记耐久文件/文本保留单独 `m4_durable` 阶段，没有终态或终态事件，也不开放动态未付结果。任一成员/来源不完整会使对应阶段拒读；历史无法准确还原时保留 gap，无旧 run 成功兜底。该轮发现两成员首稿被旧历史契约的 baseline 必需条件漏列；独立验证、失败原文和冻结范围见[执行交付记录验收](../acceptance/desktop-ux-coverage-20261026/execution-deliveries/README.md)，不改写为当时已修复。

后续[双稿历史修复](../acceptance/desktop-ux-coverage-20261026/history-pairs/README.md)仅将 history baseline 改为实际交付时可选：修订版/清洁版仍逐份验证，已声明的基线缺失或失效不得降格，旧三成员、single/null、分页与权限保留。没有新增基线文件、迁移、模型调用或费用。本基础与该修复仍不支持后继采用、增量重做、B 追加费用或完整 G03。

### 准确执行版本的复核编辑正文（2026-10-27，本地专项已封存）

新增迁移 `0127_review_execution_editors.sql` 追加 canonical 表 `bb_review_execution_editors`，主键为 `(run_id, execution_version)`，不另设 `UNIQUE(run_id)`；owner/project/run/version/input revision/hash 六字段同时外键关联不可变执行身份和准确复核快照。正文按严格 `review-editor-v1` schema 校验，并核对 canonical JSON hash、冻结原稿 pin、DOCX/PDF 格式及创建时间。身份、正文、hash 和时间禁止 UPDATE/DELETE。旧 `bb_review_editors` 及其 run 主键保持，严格回填和 AFTER INSERT bridge 保留 V1 兼容；canonical-first 镜像也须逐项相等，包含 PostgreSQL 原始精度的创建时间。缺失或不符使整笔回填/写入回滚。迁移按 project→run→execution→snapshot→editor 取得所需表锁，全部 NOWAIT，冲突须整体重试，不在持有父锁时等待旧 writer。

真实 trusted writer 使用共同 registration：按 project→run→job 行锁检查可见项目、running 状态、准确 token、未过期 lease 及 execution/input/source pin，写 canonical 后精确镜像 V1。仅数据库死锁 `40P01` 最多重试三次完整幂等登记，每次重新核验 lease，不重跑模型或 Word。editor reader 从持久执行身份解析来源，只读取 canonical 正文及准确输入/复核快照，并要求完整有效的 final delivery receipt、正确终态与 channel、实时有效测试授权和全部可用交付成员；无旧表或当前 run 成功状态兜底。

公共 GET 可选 `execution_version`，省略仍选 V1；响应增加可选执行三字段。免费人工导出可选 `source_execution`，必须精确匹配来源 run 的持久身份，新 export pin 和 export-only 复核快照都保存该身份，Worker 不借目标任务 lease 推断来源。旧请求省略字段仍按 V1 处理，沿原 request/body 幂等规则；导出继续创建既有确定性 export 新 run，不构成同一任务补料采用。内部 correction-file pin 同时核对两处来源身份，不新增材料或下载权限。

浏览器恢复 wrapper 与待确认导出保存执行三字段，沿原 owner/project/run、正文 hash 和完整 issue set 隔离；即使正文 hash 相同，也不能跨执行版本复用。旧无执行身份的 wrapper/raw cache 仅按原 V1 兼容。待确认请求完整保留来源身份、深拷贝并冻结，刷新后仍须明确重试，不自动提交。

**全局 V1 gate 与 current-input integrity 共享 view 均未修改。** `bb_execution_artifact_versions` 仍要求绑定输入等于当前 run input，receipt 的共享校验也沿此来源边界。仅 state/primary 等投影变化不改写冻结交付身份；不能据此宣称 current input 切换后旧版仍可读。M3/M4 报告和其他按 run 唯一的成果登记仍有后继版本化缺口。新表没有 raw-material FK，原材料只在插入时核验，source 材料 retention 及数据库 editor 正文的旧 cleanup 均未解决。

本切片的[本地专项验收](../acceptance/desktop-ux-coverage-20261026/execution-editors/README.md)已封存：API editor/迁移/并发 17 pass，相关 API 92 pass，真实 PG/Python Worker 8 pass，Worker 回归 42 pass/1 Windows skip，缓存 20 pass，桌面 Edge 19 pass，契约/构建通过。各集合分轮采用且不相加，两轮各 2,217 文件前后冻结一致，Python 源码/外部运行时不在冻结范围。原始失败及专用 PG 按准确 PID 停止记录均保留。不计入既有 15/15 或 662 pass。没有新输入采用、后继处理、追加账务或补料新版 Word 证据，**G03 / UX-A03 与整体 goal 保持 active**。费用已选 B，B1/B2 均未确定；本轮未推送、创建 PR 或部署。

### 后续独立增量：准确执行版本的结构化复核报告

`0128_review_execution_reports.sql` 追加 canonical `bb_review_execution_reports`，以 `(run_id, execution_version)` 为主键、报告 ID 全局唯一，完整六字段分别 FK 到不可变执行和复核快照。旧 run 唯一表保留，严格回填与 V1 bridge/mirror 原子保留原正文、摘要和 PostgreSQL 微秒时间。迁移采用父表顺序的 NOWAIT 锁，源材料不新增永久 retention FK。

SQL 验证基础 envelope、身份、冻结来源和摘要格式，精确复制旧摘要；报告 evidence locator 允许任意 JSON 数字及 Unicode key，不能套用 editor 的 SQL canonicalizer。正文 writer 与所有 reader 使用唯一 contracts `isReviewReport` 和 `inputManifestHash`，独立核对冻结 manifest 的输入、源稿、scope、业务版本和 follow-up 来源 ID/hash。格式正确的错误历史摘要仍在应用边界拒绝，不将 SQL copy 当作 JavaScript hash 的重新验证。

真实 writer 按 project→run→job 锁核验准确 live lease 和输入，登记 canonical 后精确镜像 V1；40P01 只重试完整幂等登记，插入后复验失败整笔回滚。API 工作区、目录、项目集合、恢复存在检查，以及 Worker 复核、文件处理、准确修订和助手上下文均从 canonical 来源读取，不借消费任务 lease、不回退 legacy。显式读取已登记报告保留既有 Word final 交付前可读行为。专项及原始失败见[报告执行身份验收](../acceptance/desktop-ux-coverage-20261026/execution-reports/README.md)。

专项独立采用 API 报告/迁移 13 pass、相关 API 94 pass、Worker 报告/租约 12 pass、相关 Worker 81 pass/1 Windows skip；构建与类型检查通过。三轮各 2,290 文件前后冻结一致，含 Python 源码；155 个归档文件保留 28 次调用和全部原始失败。首轮差异任务夹具被既有项目互斥拒绝，以及旧助手计数未包含新增来源执行的断言，均仅修正夹具后完整复验；生产边界未因此放宽。专用 PG 按准确 PID 停止。档案保存迁移日志与最终 SQL 的路径/字节数/hash 冻结记录，SQL 正文在本仓库迁移文件中；未单独记录迁移当时 SQL 字节 hash 的限制明确列明，不把它冒称独立字节证明。

本切片没有开放 V2、采用补料或追加账务。M3/M4 文件成果登记、检查点与逻辑调用、旧工作复用和增量处理、source retention/正文 cleanup，以及同 run 补料后新 Word 桌面旅程仍待完成。G03 / UX-A03 与整体 goal 保持 active；B 已选，B1/B2 公式未定。没有 push、PR 或部署。

## 需要确定的一项产品规则：补料重做费用

普通暂停、原输入恢复、重复下载和系统内部恢复已有规则，不重新索取这些决定。补料导致的必要重做已确定另行报价，剩余待定的是追加价格的计算基准与适用范围。

**历史备选 A（用户未选择）：同一任务仍按原总价封顶。** 已消耗积分保留，后续必要工作继续累计到原总价；补料保存和暂停不扣费，不另起一笔完整任务收费，超出原价的补料处理成本由平台承担。成功仍补足原任务尾款；结束/失败/退款分别沿原任务的锁定政策执行。旧 `on_delivery`、`authoring_progress_v1`、免费任务和 v2 不被暗中互换。此建议不是“全部免费”，也不是已批准的现行规则。

例如原任务总价 4,500，暂停时已扣 1,200：补料和采用本身不扣款，继续处理按原方式累计，本任务最终总扣款仍最多 4,500；不得再次收取完整 4,500。无新材料的恢复不增加新费用。旧全额预留策略继续使用原预留，动态策略继续增量扣款；总价为零的原任务不因此变为付费。

**用户已选择 B：必要重做另行报价并明确确认。** 原消耗保留，新工作开始前显示追加金额及新上限，用户确认后才采用/继续；必须另外明确追加价格计算规则和适用范围。不能直接使用任意模型成本、重收一整单或把新输入报价当作已经批准的追加价。原异步问题的用户答复为“B：重做部分另行报价，确认追加金额后继续（需补充定价规则）”。

可供确定的具体计价基准如下，均尚未获选：

- B1：按明确需要重做的文件，沿用该类文件当前价格表逐份报价；未受影响的文件不计追加价。例：一包三份文件仅一份 4,500 积分文书需要重做，则追加报价为 4,500，其余两份不重收。此基准便于直接复用现有价格版本，但单份文件的局部重做也按整份定价，需明确接受这一点。
- B2：按单份原价 × 受影响正文字符数 / 原稿正文总字符数折算，向上取整到 1 积分；全篇受影响时最多为该文件原价。例：原价 4,500，准确受影响正文占 20%，追加报价 900。此基准需要新增、可核对的范围计算与报价规则；不能由模型随意声明百分比，也不能将补料页数比例冒充重做正文比例。

两者都应在执行前列出本次重做文件/范围、追加金额、原已扣金额及新总价上限；报价输入版本、原工作引用或范围改变时重新报价并再次确认。真正的系统恢复、未受影响工作复用、上传/保存和重复下载不因此追加收费。实施时还需将选定规则落到每个执行版本的报价、账务幂等和失败/取消处理，保持原已发生流水可追溯。

在 B 的具体报价规则被确定之前，不在生产契约、migration 或账本中实现推定价格。目标中“需要补料续做”和“另行报价确认”不再待选择；只有尚未定义的计价基准及相应协议待确定。仓库 `AGENTS.md` 的依据与优先级要求“确定公共契约，再开发依赖该契约的代码”，同时要求“不要自行改变业务规则或接口格式”；临时自行合并授权同样保留“不改变业务规则”的条件。本文与现有只读审计/覆盖纠正可先完成。

## 完成证据与实施顺序

| 关口 | 必须提供的证据 |
| --- | --- |
| 费用与契约 | 产品规则确定记录；contracts 唯一 schema、样例和兼容性检查；说明旧任务和各计费策略行为 |
| 不可变输入/归属 | 真实隔离 PG 测试证明同一 run 多版本、旧 snapshot 不变、准确材料 pin、跨用户/项目拒绝、CAS 和请求幂等 |
| 执行与安全边界 | 在途调用保存后暂停；未知调用不重发；原结果复用且必要增量调用有新身份；租约过期、取消/交付/双页采用/到账竞争不产生两个活动执行 |
| 真实账本 | 暂停前、暂停后、补料后、继续前、成功/结束/平台失败后的 available/reserved/consumed 与追加流水；旧策略、v2、零余额/尾款不足及多项目竞争 |
| 各业务处理 | 编制/更新、完整及差异复核、单份 M4 实际从新输入读取补料；产出内容确实包含合成补料事实；不能只 mock 新 input API 或直接注入成功成果 |
| 下载与历史 | 新成果绑定最新采用输入、同一 run，实际 Word 字节/hash正确；旧输入/旧结果/模型记录仍可追溯；准确成果续改不借用旧结果 |
| 桌面连续旅程 | 从运行→明确暂停→真实上传→保存/采用分开→明确继续→同一任务→最终文件；刷新、未知回执、失败重试及两个页签；同尺寸原型/实现截图 |
| goal 复核 | G03 不再有功能/设计缺口，上述证据真实采用；重新逐项核对原目标，再评定 90%/主要 100%，不能靠现有 662 pass 抵消缺项 |

建议顺序：确定费用与版本化契约 → 追加迁移/API/队列与账务 → 三类执行器及准确成果关联 → 原任务页材料/继续动作 → 隔离集成与桌面连续验收 → 全目标复核。任何中间阶段均不能标记 UX-A03 或完整 goal 已完成。

本轮未推送、未创建 PR、未部署。此前外部发布授权尚未收到；本提案和覆盖纠正不构成外部发布授权。

### 2026-10-27：复核文件登记的准确执行来源

本地 `0129` 已将 M3 文件成果位置追加到 `(run_id,execution_version,kind)` canonical 登记，绑定完整执行/输入及准确 artifact；实际 writer、公开成果/来源读取、结算 readiness 和交付冻结成员/命名均消费该登记。保留交付前重试换选文件，交付回执或成功态后只允许完全相同的重放；旧历史 gap/未就绪候选仅保留来源。新旧 writer 原子镜像，两方向登记/交付竞争用真实 PG 验证，详见[登记专项](../acceptance/desktop-ux-coverage-20261026/execution-review-artifacts/README.md)。

这只移除 M3 文件登记按 run 唯一的存储前提；V1 gate、current-input integrity、M4 登记与实际后继采用尚未开放，不能称已完成同任务补料续做。费用已确定 B，B1/B2 公式仍待决定，未自行计价或新增扣款。G03 / UX-A03 与完整 goal 仍 active。

### 2026-10-27：M4 文件登记的准确执行来源

后续本地 `0130` 为 M4 正文和编制说明增加完整执行/输入及 artifact 来源登记，保留旧字段、NULL 稿次和微秒时间，新旧 V1 INSERT 精确镜像。实际列表、下载、底稿、交付冻结和结算 readiness 使用准确登记，Word 缺登记不能回退旧表；问答仅保留严格 QA snapshot/subtype/全文证据分支，通用已交付文件引用继续沿原授权。Worker 先锁 topic/project，再锁 run/job 并重验租约；详情与原始失败/重跑见 [M4 登记专项](../acceptance/desktop-ux-coverage-20261026/execution-m4-artifacts/README.md)。

本切片只处理来源与读取基础。V1/current-input gate、后继采用/执行、阶段和调用版本、真正增量处理、B 追加报价/账务及完整桌面同任务新输入旅程仍待完成。B1/B2 公式尚待用户确定，未推定计价，也不据此关闭 G03 / UX-A03 或整体 goal。

### 2026-10-27：阶段与模型恢复边界

任务 checkpoint 保留现有 `stages` 结构，首次可信写入增加 `stage_execution`，固定完整 execution/input tuple。旧无 stamp 记录仅按持久 V1 身份兼容；冲突 stamp 不得覆盖修复。真实 claim、阶段写入/升级、完成与恢复、补料捕获/文件读取及 pipeline 均校验来源，保存的 prompt 另查 kind/revision/hash。通用进度保存保留已完成阶段、provider results、operator 决定及恢复审计。材料解析属于独立 job，不改其 checkpoint。

模型逻辑 ID 保持稳定，物理 attempt 编号仍在整个 job 内递增；Codex schema reask 预算单独按本执行调用次数计算。历史 prompted 调用先逐项核对完整绑定再筛选，缺失/损坏来源不能变成“没有旧调用”；合法旧未决调用仍阻断新发送。复核公开来源和旧分批阅读恢复同时核对实际 call/prompt/result。旧 unprompted V1 记录保持可见，不据此伪造可复用结果绑定。

该重构没有活动版本切换、补料采用、重做计划或新 Word。SQL readiness/delivery 仍读取原 stage 路径并依赖现有 V1/准确成果约束，尚未独立校验 stamp；真正采用时必须一起接活动执行身份。自动 terminated-timeout 恢复的安全次数上限仍按整个 job 历史累计，不能声称所有重试限制都已按执行重置。历史工作留在既有不可变 saved-work receipts，未来采用须先冻结旧工作，再按明确依赖与复用计划切换活动阶段及输入，不能复制同名 prompt 或清空后整单重跑。本地验证见[执行恢复边界专项](../acceptance/desktop-ux-coverage-20261026/execution-work-boundaries/README.md)。G03 / UX-A03 与整体 goal 仍 active；B 已选，具体定价公式未定。

### 2026-10-27：M1 准确续做请求准备

新增内部 `loadRunSupplementAuthoringPreparation()`，按指定保存回执重新使用 HTTP 草稿响应的同一冻结输入 reader 和候选 compiler。核对原执行/输入、回执请求 hash、准确暂停 checkpoint、两处 stage 的同一 prompt、唯一已捕获完整 M1 结果，以及全部旧文件和完整候选材料字节。完整 delta 保留新增、明确替换、未变材料及原稿声明前后值；稍后同一暂停位置保存的新回执不替代明确请求的旧回执。未定义新 HTTP、采用、队列或报价协议。

当前 M1 stage 和内部 preparer 共用真实 prompt/workspace builder。内部准备将准确旧文件写入 `previous_work/`，把材料变化、候选输入及来源写入 `continuation.json` 和实际 `input.json`；原始要求沿准确 submission/version/hash 读取私有正文，后续项目消息不进入。该读取保留既有访问审计，不能称完全没有数据库写入。工作区 I/O 前后重新核对暂停边界、plan hash、来源和要求，文件副本全部列入原件 hash 核验。

默认以已保存 clean 工作稿作为本轮编辑基线，拟定的新 tracked 只表示相对该工作稿的变化，原 tracked/baseline 留作回查，不重建最初上传稿以来的完整修订历史。明确 discard 时不选择旧 clean 作为基线。只支持同一准确完整 M1 结果中的双稿；选填 baseline 不成为新门槛。scratch 工作记录没有保留，不能声称恢复任意中途章节；当前无章节依赖图，请求明确保守复核全文，不宣称已完成局部增量复用。

详见[请求准备专项](../acceptance/desktop-ux-coverage-20261026/supplement-authoring-request/README.md)。它证明真实保存回执向实际 M1 请求构建器的传递，没有执行候选输入的模型调用、V2、采用、报价确认或补料后的新 Word；M3/M4 的续做输入也尚未接入。B1/B2 定价规则仍待确定，G03 / UX-A03 和完整 goal 保持 active，不增加用户旅程通过数。

### 2026-10-27：复核与文书续做请求准备

在前述 M1 切片之后，内部 `loadRunSupplementFilePreparation()` 将同一回执、准确暂停检查点、唯一完整 captured result 和候选材料核对扩展到 M3 复核及 M4 文书。M3 的实际 stage 与内部 preparer 共用 prompt/workspace writer；候选源稿和选定问题范围保持固定，旧报告及批注独立标为待重新核实的参考，不自动成为新问题或已核事实。准确修订、接受提案和纯导出不因此取得补料执行权限。

M4 共用真实文书 writer，准备时按原执行核对来源项目、主文档、模板、正式 edit_base、知识及要求，再检查原结果的 skill/method 与当前固定配置一致。旧正文和编制说明仅作工作参考，不替换正式底稿或成果。工作区 I/O 前后重核 plan、暂停边界和完整来源，旧文件、候选材料及 continuation 元数据副本均参与原件 hash 校验；返回的数据副本不能改变实际请求。

本切片只准备真实执行器使用的请求，没有调用模型、采用新输入、分配 V2、生成新 Word 或追加扣费。没有保存 scratch 或建立可靠章节/问题依赖图；请求要求结合完整候选材料重新核对，不据此声称已实现精确局部复用。验证与限制见[复核和文书请求准备专项](../acceptance/desktop-ux-coverage-20261026/supplement-multifile-request/README.md)。B 已选，B1/B2 仍待确定；G03 / UX-A03 与完整 goal 继续 active，不增加桌面用户旅程通过数。

### 2026-10-27：持久处理计划与原 V1 活动依据

`0131` 追加不可变的内部处理计划，只保存指定回执、准确来源/候选、材料与旧文件引用及固定全文重核规则。实际 M1/M3/M4 preparer 通过显式 plan ID 消费，I/O 前后重核暂停边界和字节；支持完整旧工作及真实零 attempt 的早期暂停。已存 prompt 可以保留，部分或失效旧工作不能伪装为空，M4 已存 method 即使没有 attempt 也继续受约束。计划不是采用、保留 pin、执行或收费授权。

`0132` 单独持久化严格原 V1 活动 head，并使真实执行 resolver/claim/resume/阶段写入要求其完整来源一致。回填不跳过缺失原执行的 run，保留原 PostgreSQL 时间精度；无 head 改写或后继激活操作。旧 run 原输入和原执行仍不可变，没有开放 V2。后续采用仍须一起接通版本化输入、阶段/模型、材料保留、正文清理、交付及 B 账务协议，不能仅修改 head 或删除 V1 检查。

验证和限制见[处理计划专项](../acceptance/desktop-ux-coverage-20261026/supplement-processing-plan/README.md)。没有候选模型调用、新 Word 或新增桌面旅程；B1/B2 仍未确定，G03 / UX-A03 与整体 goal 保持 active。

采用前仍须完成的耦合边界已再次只读核对：

- 当前 plan/basis reader 及 captured-file reader 要求原执行仍 active 且原 checkpoint 仍 paused。采用后不能直接调用这些准备器；须按不可变采用回执区分 current lease 和 historical source，实际三类 stage、model journal、collector、promoter 与 finish 一起消费新身份。
- 有效采用必须与 storage tombstone 删除资格使用同一锁协议，按所有已接受 execution 及 M4 snapshot 保留材料；candidate/plan 继续不产生 pin。`processTombstone` 最后核对与 Blob 删除之间的窗口尚需处理。V1 正文清理还缺 canonical/legacy editor/report、input/business snapshot 和 delivery naming 等副本，须防止 bridge/reader 复活已清理正文，并补清已有 purge receipt 的项目。
- 项目→run→job 内须原子重核并登记采用回执、候选 input、successor execution、业务 snapshot、head 和新 stage 身份；旧结果保留为历史，新阶段不继承已完成 model_generation。0125/0129/0130 实际成果消费者、`0130` 最新 delivery-plan 与 M4 finalizer 的 V1 来源条件须一并接通，不能仅删除 V1 检查。
- B 追加授权、resume/claim/recordPotentialCall、独立追加段 reservation/扣款/结算和失败取消处理须成套启用。当前单 run reservation 与原 authoring 上限不能被覆盖为追加账。定价未定期间可完成独立前提及关闭 gate 的实现，不能声称付费续做已可用。
