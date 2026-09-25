# #31 历史稿修改计划：开发交接

本文件记录可独立测试的原文修改计划及 worker 读取入口，供 #17 编排、#34 Word 修订消费。后续新增并安装到 runtime 的模型阶段、分片恢复、事实决策锁定和当前生产依赖见 [模型阶段开发交接](HISTORICAL-MODEL-STAGE.md)。这些组件不是上线完成证明，不关闭 #31；合成响应不能代表真实模型、数据库集成或专业验收。

## 入口与信任边界

- `packages/domain/src/historical-update.ts` 的 `planHistoricalUpdate` 为纯函数；内部类型通过 `@bondbuddy/domain/historical-update` 导入。`historical-update-plan-v1` 是内部交接格式，不是新 HTTP 契约。
- `apps/worker/src/historical-update.ts` 的 `prepareHistoricalUpdate` 读取 #13/#15/#76 的持久化记录，再调用 domain。默认使用现有 owner-scoped repository；第三个参数仅为组件测试的 repository 替身。无新 SQL 迁移、公开 API、状态机或枚举。
- 调用方必须来自可信 worker，并先校验 run 的 owner、project、发行人及不可变 input revision/hash。不得将浏览器或模型提供的身份、材料角色、事实、证据、确认状态直接传入。
- 上游语义遍历提供 bindings（指标/公式）、occurrences（全文引用）、columns（新增列）及 coverage（逐块保留/修改/缺证据的原因）。本模块校验并执行该清单，**不自动发现全篇所有财务引用，也不证明所有标为 retain 的章节在业务上都无需修改**。发布前仍须做独立覆盖与专业校验。
- 财务事实目前限本发行人审计/财务报表/最近一期报表/附注材料中已持久化的可靠抽取；`extracted` 不升级为 `verified`。用户说明、参考企业事实、存疑 OCR、未知值、冲突均不能自动入稿。

## 不可变输入

`LockedHistoricalUpdate` 锁定以下内容：

| 输入 | 含义与验证 |
| --- | --- |
| context | owner、project、发行人、inputRevision/inputHash、目标市场/方式及规则版本/hash；复用公共市场枚举 |
| materials | 材料 ID/version/hash/role；逐一查询 owner/project 下未删除记录，禁止历史稿改走 reference |
| baseline | 指定历史材料、parse snapshot ID、profile version；不取 latest 作为回退 |
| factCandidateIds + factsHash | 输入快照建立时，可信预检须锁定所有相关候选，**包括冲突**，并为每个精确事实身份锁定最新决策 ID/version（无决策为 version 0）；hash 使用 `historicalUpdateFactsHash(facts, decisions)`，包含候选身份、值、来源及决策版本 |
| semantic inventory | 每处原文位置、财务身份与全块覆盖原因；必须经过上游证据核对 |

运行中新增的候选属于下一次 input revision，不能改写既有任务的候选清单；清单中候选丢失或内容/hash 改变则停止。此函数不负责创建或持久化输入快照；#17 接入时须在可信输入冻结流程中保证候选清单完整性，不能让客户端挑选候选来隐藏冲突。

同一精确身份有多个候选时，只有决策选择了冻结清单内且身份一致的候选才可用于事实计算；无决策、未解决决策或清单外候选选择均保持待确认。决策只选择原候选，不改变其状态；`user_asserted`、OCR 存疑值仍不能成为可用审计事实。

解析记录以原始 parser response hash 及有序 evidence 再核验；profile 的材料版本、引用记录和原生 extractor/parser 版本必须对应。历史材料归属本发行人的专业确认仍由上游提供，上传分区本身不是发行人身份证据。规则 pack 引用仅用于锁定版本，生产发布资格仍由 #19 的 gate 检查。

## 已支持的修改

1. 同市场、同发行方式下，对确定的原文片段替换财务数值或报告期；日期来自事实的报告期，不自动使用今天或全局替换年份。
2. 同一 binding 的封面/正文/表格引用共用数值与证据；任一引用失效，该 binding 的所有修改停止，避免只改一半。不同 binding 可以保留可审阅的部分计划，但只要存在 finding 就不是完整计划。
3. 简单矩形表追加新一期列，旧列与未受影响文字原样保留。所有行须有同一插入列锚点，期间、口径、币种、会计基础一致；新截止日须晚于原稿最新报告期。合并单元格/空单元格/多段落等物理网格信息不足时拒绝或留给 Word 端严格校验。
4. 同期重述必须显式给出 `replaces` 的旧事实身份和新 dataVersion，保留新旧证据，且原稿显示值须与旧事实一致。本切片要求旧审计事实可获得；缺失时留下待确认，不能猜定旧口径。
5. 定点有理数计算与单位换算：fact、sum、difference、ratio、growth_percent；计算过程中不舍入，显示时按指定精度四舍五入（中点远离零），支持千分位。除数为零、负/零增长基数、混合主体/合并与母公司/币种/会计基础、不可比期间等停止。
6. 不生成无依据变动原因；source_text 只接受证据原文直接包含的文本。保留旧风险、保留意见和历史事件，不将“缺资料”改成“没有”。本切片没有任意自由改写、章节删除/重组或通用新增段落。

## #34 消费约定

输出 `status=planned` 只说明清单内检查通过；所有输出始终 `deliverable=false`。`needs_confirmation` 包含机器原因、受影响的原文/binding ID 和覆盖计数。按 UPD-GAP-01，局部缺口应在工作稿和摘要中保留待人工确认标记，其余有依据的修改继续处理；不能仅凭计划状态宣称成果成功，仍须通过真实 Word 交付检查。

- `source`、`baselineHash`、`planningInputHash`、`planHash` 用于核对源文件、有效基线、输入与修改计划；`context.inputHash` 仍是 run 输入 hash，两者含义不同。
- `replacements` 记录原文 record/locator、before/after、原因、公式、旧重述身份、来源状态、候选 ID 与证据锚点。
- `columns` 记录原表/插入列和逐行原文锚点、新值、原因、公式、来源状态与证据。`requiresPhysicalGridValidation=true` 强制 Word 端检查真实 OOXML 网格及合并单元格，不可只凭文本解析判断版式。
- start/end 为 **JavaScript UTF-16 偏移**，相对于 effective quote；Python 实现必须转换索引单位，不能直接当作 Unicode code point 下标使用。不允许切开代理对。
- `textPreview` 是完整有序的有效正文预览，保存未修改块及格式提示。它不含新增列的版面，也不是清洁版 DOCX；新增列须读取 `columns`。原稿内 run 格式提示只是定位信息，不能覆盖新文字的样式决策。
- Word 端须重读并 hash 校验原件/有效基线，逐处复核 before，落实真实 `w:ins/w:del` 和必要 comments，验证接受全部=清洁版、拒绝全部=有效基线，并通过 #146 WPS 专业验收及 #17 交付 gate。不得把预览全文重写成一个段落然后命名“修订版”。
- 旧 DOCX 原件、既有修订和旧成果从不被本函数修改；修订版/清洁版应独立输出。计划含财务正文与证据，必须存私有对象/检查点，日志仅记录安全引用，不把全文写入公共事件。

## 尚未完成的 #31 验收工作

- #15 的财务事实生产链路、真实三表/附注勾稽与行业覆盖验收；模型逐块遍历已实现，但未证明真实模型映射完整性。
- #76 当前将带旧修订的 DOCX 标记 `needs_confirmation`。本切片验证被删除旧数不进入有效文本，并继续阻止修改；**尚未实现经审定的有效基线生成/确认流程**，不能说已支持这类材料的完整交付。
- PDF/扫描稿带原页位置的可编辑重建基线、存疑数字消解；当前保留 `UPDATE_PDF_RECONSTRUCTION_REQUIRED`，绝不自动改成无历史稿。
- #19/#20–#30 已审定规则下的跨市场/发行方式目录映射、条款增删重组，及完整财务分析编写；当前同市场/方式以外返回 `UPDATE_STRUCTURE_MAPPING_REQUIRED`。
- #17 输入冻结中的可信 issuer binding、#19 生产规则 pin、#16 实际模型调用和 #79 全链路日志验收。代码已有模型检查点衔接，尚未完成真实环境验收；M1 成本仍由平台承担。
- #34/#146 实际 Word 修订、comments、清洁版与 WPS 验收，授权业务样本的全流程验收及质量证据。

历史稿路径完全不读参考库，不因库无匹配而阻断；上面未就绪项是历史稿自身或内部能力缺口。

## 重现与样本

`tests/fixtures/historical-update/input.json` 是明确标注的合成输入：2023 年营业收入 100 万元，新审计值 2024 年 1,200,000 元，目标显示 120.00 万元；保留 2022/2023 两个旧列、历史诉讼及保留意见。预期为 3 处文本替换和 1 个新增年度列。

```sh
npm ci
npm run build
npm run check:contracts
npm test -w @bondbuddy/domain
BONDBUDDY_TEST_PYTHON=python3 npm test -w @bondbuddy/worker
```

Windows 用 PowerShell 设置 `$env:BONDBUDDY_TEST_PYTHON` 为装有 `python/requirements.txt` 所需依赖的 Python 路径，再运行 worker 测试。未设置时两个真实 parser 组件测试显式 skip；其余单元/读取边界测试仍运行。`parse_sample.py` 在临时目录生成真实 DOCX 并调用现有解析器，分别验证无旧修订的规划以及删除旧数后的待确认状态，解析前后原件 hash 相同。没有真实数据库/队列/模型/Word 生成联调证据。

2026-09-25 本次验证环境为 Windows、Node 22.14.0：全仓 build、56 个 contracts 样例检查通过；domain 全部 104 项通过。worker 为 133 项通过、13 项因数据库/Azurite或仓库 venv 未配置跳过、1 项原有测试失败：`material-parser.test.ts` 的 `bridge binds parser request and response ...` 使用 POSIX `0600/0700` 权限断言，Windows 本机返回 `0666`，独立重跑同样失败；该文件和实现未改动。新增 #31 的 30 项 domain、19 项 worker 测试均通过，包含启用 Python 后的两项真实 DOCX 解析组件测试。worker 整体检查不能报告为全绿；部署目标 Linux 仍需运行完整测试和真实服务联调。
