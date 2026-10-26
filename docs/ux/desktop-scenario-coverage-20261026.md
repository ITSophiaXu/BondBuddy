# 桌面用户场景覆盖与未完成验收项

日期：2026-10-26。工作基准：`develop@50bd3dfb`，工作分支：`codex/desktop-ux-coverage-20261026`。`4cd1c39` 留存的本地合成桌面 UX 基线证据为 **15/15 业务旅程通过**，其中主要旅程 **11/11**、辅助旅程 **4/4**，**G01/G02 均通过**。已确认的 `UX-A03`“暂停→保存补料→继续同一任务”仍有功能和设计缺口，列为必过门 **G03**。因此这些基线结果不能证明整体至少 90% 或主要场景/功能全部覆盖，当前目标继续推进，尚未完成，也不发布。保留已发布优化，未新增手机优化。

[总验收与检查记录](../acceptance/desktop-ux-coverage-20261026/README.md)；[逐套采用的浏览器原始汇总](../acceptance/desktop-ux-coverage-20261026/browser-results.json)。本文的 `pass` 限于真实前端、受控 HTTP 与受控交付字节的桌面 UX；真实模型/worker、PG/Blob、支付账务、Word/WPS 客户端及专业验收仍按文末边界独立跟踪。

后续独立修复了人工暂停与积分耗尽同时存在时的提示和继续入口，沿用已批准的“人工暂停优先”规则：定向桌面 **11/11**、进度单元 **7/7**、web 构建通过，见[人工暂停验收](../acceptance/desktop-ux-coverage-20261026/manual-pause/README.md)。这次未重跑历史 662 项，也未改变后台协议或补料费用规则。另有[独立 HTML 操作提案](prototypes/pause-supplement-resume.html)的 **3/3** 合成演示 QA，不能计作 G03 产品验收。

本地又增加[按原任务保存补料准备](../acceptance/desktop-ux-coverage-20261026/supplement-preparation/README.md)：三类暂停页接入真实上传恢复与草稿保存/读取、CAS、准确回执恢复和原材料继续确认。准备来自固定 run 输入及 M3/M4 执行快照；保存不采用、不执行、不扣追加费用，草稿独有资料不成为永久 pin。专项 PostgreSQL/HTTP 与桌面组件证据分别记录。该切片没有实现采用新输入后的执行/报价/成果，不能关闭 G03，也不计入历史 662 项或据此声称主要功能全部覆盖。

随后完成[真实主页面与后端联通验收](../acceptance/desktop-ux-coverage-20261026/supplement-preparation-real/README.md)：真实 main、HTTP/session/CSRF、隔离 PG 和私有本地字节连续运行 **6/6**，后端完整准备专项 **44/44**。同时修复复核成果续改使用 `authoring.review_result` 时被补料读取误判 503、阻断原材料恢复的回归；保留普通复核与错误快照的严格拒绝。此轮证明准备保存、准确回执/CAS 及同原 job 的原输入恢复，不含 Azure、模型、采用/追加账务或新 Word；G03 仍开放。已检查的最新范围中未确认其他新的主要功能缺口，不能据此推导完整目标比例。

后续[初始执行身份专项](../acceptance/desktop-ux-coverage-20261026/initial-execution-identity/README.md)已保护不可变 V1，并验证受控本地 adapter 在途结果保存、手动暂停和原结果复用。当前[候选输入专项](../acceptance/desktop-ux-coverage-20261026/supplement-input/README.md)进一步接通 M1/M3/M4 实际 loader 的准确输入读取，以及补料保存后的完整候选和材料核对。本地[来源与私有文件读取增量](../acceptance/desktop-ux-coverage-20261026/supplement-source-files/README.md)补充新原稿声明、明确放弃候选的旧成果关联，以及准确回执下旧工作文件的内部字节校验；该轮仍记录原始工作文件的清理索引缺口。候选没有被采用或执行，V2、追加报价/确认、后继模型调用和新成果验收仍未完成；这些独立回归不能累计为新的用户旅程覆盖率，G03 继续为主要功能缺口。

[保存工作引用专项](../acceptance/desktop-ux-coverage-20261026/supplement-saved-work/README.md)再将草稿与安全暂停的准确已保存结果关联，页面区分已有记录、尚未捕获及进度变化。模型工作绑定、私有结果读取和清理竞争形成独立验证；它们没有完成后继业务执行、追加收费或新版成果交付，整体覆盖率仍不据测试数量上调。

随后基于 `a35034b3` 的[工作文件生命周期增量](../acceptance/desktop-ux-coverage-20261026/working-file-lifecycle/README.md)追加迁移 `0122`、`0123`，九个 writer 模块的原十处 put 改为写字节前登记物理对象和多个准确来源，覆盖被替换的 report hash、共享 correction 和文件已写但结果未保存的窗口。单调清理开始标记先于删除提交，完成回执可重试；父 prompt/JSON 清理前登记可核验旧来源并完成到期附件清理。沿现有默认 180 天终态日志窗口、活跃/暂停保留、账号关闭及项目删除窗口，组合内容锁保持 prompt/result→run 工作→文件顺序。内服读取、公开可读报告与 `owners/` 清单遵守登记/清理状态；未知 legacy 只诊断，不按目录前缀删除，也不伪造历史写入意图。

后续复核修正同 run 较新 legacy 共享引用被旧父清理遗漏、同 attempt 多个不可变结果被来源唯一键合并的生产缺陷：年龄清理先发现全部已知结果，在 run 行锁内重验准确 ID 集合，再取得内容锁重新判断；`0123` 将 `discovered_result_id` 纳入唯一性，各真实候选保留自己的来源时间。legacy raw 只有 bounded 长度/hash 核验正确才记录当下存储观察，缺损仍保留地址并拒读，不让新登记破坏有效旧文件读取，也不恢复已清理文件。两条迁移及最终构建/类型/契约检查通过。工作文件专项 31 pass、worker 108 pass/12 skip；API 完整集合保留 264 pass/1 fail/30 skip，缺 raw Word 的测试 fixture 修正后仅该组复验 9/9，未完整重跑或合算为一轮全通过。五个 Windows sink 标题按名排除，不计入 30 skip。两次冻结只该测试 src/编译 JS 变化，未改生产，最终 before/after 2052 项一致；空模板/无 clones 与本轮专用 PG 准确 PID 停止已列专项 summary，未借用旧轮结论。此前验收和失败历史保持原样；父来源已丢失的未登记历史 raw、不可变 editor 数据库正文和 provider JSON 一般写入意图仍有独立边界。本轮未采用新材料、未新增报价或新版 Word，不改变 G03 及完整 goal 未完成的结论。

## 来源与范围

- 既有十五类业务目录来自本机历史档案 `ux-implementation-20261025/ux-evidence/all-scenarios-coverage-matrix.md:208–224`。原档案 R1–R44 的分段合成证据用于定位已有能力，不能把其中“尚未远程集成”继续套在已经合并的当前版本上。
- [v6.1 用户任务卡](../testing/bondbuddy-test-plan-v6/user-scenarios.md)提供六个正常、七个异常、十个中断/并发任务。下文映射它们与既有十五条旅程的关系；映射不代表每项任务要求已通过。`UX-A03` 是已确认的必要目标，其新材料同任务续做要求由 G03 单独显式跟踪。
- 十一条主要旅程、四条辅助旅程按“直接完成业务产出、处理项目文件和取得准确成果”划分，保留为既有证据基线；该分类与通过数不能把未覆盖的已确认主要功能排除出用户目标。
- 桌面验收以现有页面、真实前端和受控合成 HTTP/文件字节验证用户操作及状态转换。手机适配及手机专项验收为 `N/A`，已有手机改动保留。
- 真实供应商/worker、PG/Blob、生产账务、Word/WPS 内容排版、专业正确性和目标用户独立完成率另列统一验收；不把这些旧 U 准入门扩大成本轮桌面 UX 的前置条件，也不把合成证据描述为这些事项已经通过。

## 基线计数、通过和完成条件

**15/15 是下表既有业务旅程的基线通过数，不是完整目标的整体覆盖率。** 原先仅据此宣称达到整体 90% 和主要全部覆盖，遗漏了 `UX-A03` 的已确认要求，现予纠正。保留十五条基线及其历史证据，不另造分母或通过收窄范围排除该要求。G03 缺口关闭并取得对应验收证据之前，不给出完整目标的整体覆盖比例，也不宣称主要场景/功能全部完成。

一条旅程记为 `pass` 需要：从该行指定的用户入口操作到最终成果/保存事实/回看位置；准确项目、文种、版本和原任务保持；必要的明确执行、保存失败/未知回执、刷新恢复分支有证据；同尺寸桌面操作可达，无新增阻断。可以由同一固定场景的连续主链加定向恢复用例共同证明；只测一个按钮、只有预置结果截图或只有单元测试不够。

验收记录必须写运行版本/源码范围、命令、被采用的报告及对应行 ID。若采纳已有证据，需核对它所覆盖的产品源码与当前版本的关系；仅“此前通过”不自动记本轮通过。`not_run` 表示本轮尚未执行或尚未采用充分运行证据；`partial` 表示已有通过的主链但整行必要分支尚待汇总；`fail` 为已复现的运行失败；`functional_gap` 为源码/协议审计确认缺少所需能力；`design_gap` 为必要行为或费用政策未定义；`pass` 只用于完整满足该行验收。功能/设计审计状态与运行测试状态分别记录，不能把未执行的 G03 测试写成已复现失败。真实用户效果独立记录。

完成条件仍是用户要求的整体业务场景覆盖至少 90%、所有主要场景和功能 100%，同时相关定向回归及类型/构建通过、实际缺陷修复并复测、桌面截图和证据可审阅。当前 G03 未通过，不能仅凭十五条基线收口；应先明确并落实同任务版本化补料、重做边界与费用设计，再验证其用户完整链。

必须通过的跨场景门如下，其他旅程的通过数不能抵消未通过门：

- G01 首次进入与账号恢复：注册/登录进入工作区、会话失效及退出清理。采用 `register.spec.ts`、`account.spec.ts` 的桌面功能分支。
- G02 积分与充值反馈：订单状态、到账余额、消费/预留/释放记录、读取失败恢复及返回原工作。到账不创建未开始的新任务；已受理且仅因积分耗尽暂停的动态积分任务可按既有规则自动续跑原任务，人工暂停始终需手动继续。采用 `account.spec.ts`、`billing-navigation.spec.ts`、各业务积分不足分支及[本次定向验收](../acceptance/desktop-ux-coverage-20261026/manual-pause/README.md)。真实支付及账本结算另验。
- G03 已确认的 UX-A03 同任务补料续做：暂停生效后保存新材料，继续同一 `run_id`，以可追溯的新输入版本采用材料，保留旧输入与已完成记录，不重复已完成工作或产生并发越界，且重做与费用可理解。用户已选 B“必要重做另行报价并确认”，追加价格公式仍待确定；版本化协议仍为 proposed。当前为 `functional_gap` / `design_gap`；新输入续做的运行测试为 `not_run`。详见[审计与设计草案](pause-supplement-resume-20261026.md)。

D06 的功能范围包含公共 `M4_DOCUMENT_TYPES` 当前十二种文书的选择、市场/品种保持和必要模板/字段边界。完整产出链使用代表文种；十二文种的已有 `pr745-market-acceptance.spec.ts` 与表单/报告期单元检查补齐入口和枚举边界，不扩大为所有文种、市场与外部模型的笛卡尔积。

## 十五条业务旅程基线

下表基线状态采用首轮及纠正 A/B/C 报告，按整套文件采用最后一轮，详见后面的来源说明。D01/D02 新增连续编制链、D03 新 V3 下载、D13 准确原成果续改均有实际字节证据；D07/D13 已确认产品缺陷已修复并复验。没有用未执行的测试文件或仅注入结果截图认定基线旅程通过；G03 的新输入同任务续做不在这些已通过证据中。

| ID / 级别 | 用户完整目标及验收终点 | 当前实现 | 本轮主要证据入口 | 采用结果及完整链 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| D01 主要 | 首次建立项目，保存财务/原稿材料及独立源信息，明确开始，查看进度并下载本轮双稿；无历史稿路径可用 | `main.ts`、`project-execution.ts` | `authoring-onboarding.spec.ts`、`authoring-source-guide.spec.ts`、`project-execution.spec.ts` | 首轮采用创建/财务上传/明确执行/准确双稿字节主链及源信息；B 整套 execution 复验输入、上传与未知受理恢复 | pass |
| D02 主要 | 从准确历史清洁稿/明确当前稿准备定期更新，保留本期材料/要求，明确开始新轮，下载新双稿并回看旧轮 | `authoring-continuation.ts`、`project-execution.ts` | `authoring-onboarding.spec.ts`、`authoring-continuation.spec.ts`、`project-execution.spec.ts`、`prospectus-saved-reentry.spec.ts` | 同一连续旅程固定第一轮 clean pin→第二轮双稿→原生历史原双稿；首轮 continuation 24 条及 B execution 补齐明确底稿/固定输入恢复与暂停/取消/充值返回，不覆盖 G03 新输入续做 | pass |
| D03 主要 | 打开准确复核结果，阅读/人工试改或补料，显式免费导出或开始下一轮，下载对应成果并保留原结果 | `review-workspace.ts`、`review-editor.ts`、`review-followup.ts`、`review-readable.ts` | `review-followup.spec.ts`、`review-flow-editor.spec.ts`、`review-result-continuity.spec.ts`、`review-editor-recovery.spec.ts`、`review-completion-download.spec.ts` | 首轮历史/人工选择/导出恢复、B 复核工作区；C 新增两条完整链分别经免费人工导出、补料明确复核，实际下载新 V3 双稿及不变旧 V1 | pass |
| D04 主要 | 保存并明确采用新版募集书，检查关联文件，阅读自动差异和人工事项，选择范围/核对费用，确认更新并下载准确双稿 | `project-files.ts`、`file-consistency.ts`、`consistency-confirmation.ts` | `project-document-journey.spec.ts`、`consistency-confirmation.spec.ts`、`consistency-manual-reading.spec.ts`、`consistency-history.spec.ts`、`consistency-update-history.spec.ts` | 首轮完整 V2 保存/采用→检查→两份 9,000 确认→部分成功/失败→准确双稿字节→返回文件；人工事项、长确认框和原历史读取/失败恢复共同通过 | pass |
| D05 主要 | 找到项目文件，选择准确文种上传/保存，查看新旧版本，再进入历史任务并返回原筛选及阅读位置 | `project-files.ts`、`project-browser.ts`、`project-task-refresh.ts`、`project-file-status.ts` | `desktop-file-workflow.spec.ts`、`project-file-return.spec.ts`、`consistency-history.spec.ts`、`consistency-update-history.spec.ts` | 首轮准确 family/CAS 保存、未知上传、旧任务打开与返回、中文筛选/折叠/阅读位置、越过最近 30 轮的原任务身份均通过 | pass |
| D06 主要 | 选择一份业务文书或多文种文件包，核对来源/模板/要求/材料及费用，明确生成，查看部分进度/停止后续并下载已完成成果 | `material-workspace.ts`、`project-files.ts`、`file-generation-cache.ts` | `m4-workspace.spec.ts`、`word-roundtrip.spec.ts`、`file-generation-workbench.spec.ts`、`batch-delivery-workbench.spec.ts`、`generation-entry-intent.spec.ts`、`pr745-market-acceptance.spec.ts` | 单份表单与原生单份 Word 生成/下载、文件包停止后续及准确双稿、十二文种边界均有采用证据；C 重验受材料渲染修复影响的全部生成/入口套件 | pass |
| D07 次要 | 两页编辑发生草稿冲突后，核对完整业务输入，明确保留本地/采用服务器/暂缓，继续原文种草稿且不误执行 | `material-draft-comparison.ts`、`material-workspace.ts` | `material-draft-comparison.spec.ts`、`material-task-draft.spec.ts` | 修复 `fields.market='constructor'` 读取继承属性导致页面崩溃；C 对照套件 19/19，包括原失败用例，不改断言；首轮任务/文种草稿保持 17/17 | pass |
| D08 次要 | 在业务文书准备中查找其他项目已有材料，以明确用途选用准确版本并保存到原文种草稿 | `material-reference-picker.ts`、`material-workspace.ts` | `material-reference-picker.spec.ts` | C 在干净服务完整 20/20；用途/准确 pin、项目登记与草稿 CAS 各自断言；两个 HMR ApiError 身份冲突用例保留原断言通过，未将登记视作草稿保存 | pass |
| D09 次要 | 从历史材料任务查看它的原输入与此前成果，再回到同文种当前草稿继续，保留其他文种内容 | `material-prior-result.ts`、`material-workspace.ts` | `material-task-draft.spec.ts`、`word-roundtrip.spec.ts` | 首轮历史完整输入对照、深链/刷新、返回同文种当前稿及十二文种隔离；旧/新成果身份与实际字节由准确文件往返链补齐 | pass |
| D10 主要 | 查看项目问答旧轮，明确采用原问题/参考材料，补充资料并选题，按题确认费用，取得新回答 Word 并回看旧 Word | `project-qa-workspace.ts`、`qa-continuation.ts`、`qa-reference-materials.ts` | `qa-result-next.spec.ts`、`project-qa-recovery.spec.ts` | 首轮两题→补充 DOCX→120 确认→同 run queued/running/succeeded→新旧 Word 实际字节；完整原请求/失落回执/草稿冲突及 owner 隔离通过 | pass |
| D11 主要 | 使用诚信名单/网站完成核查，定位原主体待补项并补证，明确免费重导出，下载新旧企业/人员底稿 | `integrity-workspace.ts`、`integrity-continuation.ts`、`integrity-recovery.ts` | `integrity-continuation.spec.ts`、`integrity-delivery.spec.ts` | 首轮原主体/原轮补证→免费 queued/running/succeeded→新双底稿→旧双底稿字节不变；受理后新增证据不进入已冻结 Word，未知回执及 owner 隔离通过 | pass |
| D12 次要 | 两个项目同时处理时查看新进度，断网/部分读取失败后恢复，进入准确任务/成果再返回原项目历史范围 | `project-browser.ts`、`project-collection-model.ts`、`project-task-refresh.ts` | `parallel-projects.spec.ts`、`all-projects.spec.ts` | 首轮 B 完成保留 A 旧范围/焦点/位置、离线/重连、全分页失败恢复、准确 artifact/run 导航及 Back、迟到账号响应均通过 | pass |
| D13 主要 | 在 BondBuddy 中问产品帮助、附材料并讨论业务；核对任务卡后明确执行，从原卡打开准确任务/成果，导航/刷新后会话保留 | `project-assistant.ts`、`assistant-view-cache.ts`、`assistant-upload-recovery.ts` | `project-assistant.spec.ts`、`result-handoff-assistant.spec.ts`、`assistant-continuation.spec.ts` | C 准确原成果/同项目保存/跨项目/异步意图及实际 Word 21/21；B 既有助手 14/14，首轮历史成果交接 6/6；底稿误用和同项目原稿信息覆盖均修复验证 | pass |
| D14 主要 | 从具体业务文件进入准确正文，提出修改并明确生成，下载本次新稿及旧稿，再返回原项目文件 | `project-files.ts`、`material-workspace.ts` | `word-roundtrip.spec.ts`、`material-task-draft.spec.ts` | 首轮原生文件行→固定 run/底稿→新增要求→明确单次执行→新 Word→返回 family→V1/V2 实际字节与原输入保持；错误身份不猜稿 | pass |
| D15 主要 | 下载检查时原 Word，在本轮用受控修改稿回存到准确文件族，保留新旧版本，显式免费重查后回看原事项 | `project-files.ts`、`file-consistency.ts`、`upload-recovery.ts` | `word-roundtrip.spec.ts`、`desktop-file-workflow.spec.ts`、`project-file-return.spec.ts` | 首轮原 OOXML 下载→受控修改稿行目标上传/CAS→新旧版本下载→明确免费检查全部当前文件；冲突、未知导入、列表失败和 owner 恢复通过，真实 Word/WPS 编辑另验 | pass |

以上测试路径均在 `apps/web/tests/`，实现路径均在 `apps/web/src/`。表中证据按下方具体断言和实际报告采用；仅手机标题、旧原型/可选采集不参与业务分母。既有少量跨尺寸用例不表示本轮新增手机优化。

| 跨场景必过门 | 最终采用 | 状态 |
| --- | --- | --- |
| G01 首次进入与账号恢复 | 首轮注册 4/4；C 整套账号 10/10。注销完整两页流程保留所有断言，只将整体预算改为 60 秒，在 C 耗时约 29.8 秒通过，包括注销后旧凭证拒绝登录与存储清空。 | pass |
| G02 积分与充值反馈 | 历史 C 账号记录/订单/余额/退出清理、首轮 billing-navigation 4/4，以及 B execution/C M4 的不足与原请求证据保留；本次定向验收补充“未开始任务不自动创建、仅积分耗尽的原任务自动恢复、人工暂停优先”的提示与继续入口。 | 历史基线 pass；本次定向通过，见人工暂停验收 |
| G03 UX-A03 暂停后补料，继续同一任务 | 已实现固定输入下的暂停、补料准备保存/读取和准确回执恢复；尚未提供将新材料对应的新输入版本采用到同一 run 的续做能力。B“必要重做另行报价并确认”已选，追加价格公式与采用版本化协议仍待确定；见[审计与设计草案](pause-supplement-resume-20261026.md)。 | functional_gap / design_gap；新输入续做测试 not_run |

### D01/D02 新增连续主链执行记录

- 命令：`node node_modules/@playwright/test/cli.js test --config apps/web/playwright.desktop-coverage.config.ts authoring-onboarding.spec.ts --grep 'desktop authoring journey' --workers 1 --reporter=list --output .local/authoring-correction-3`。本机 Edge，`http://127.0.0.1:5187`，1440×960。
- 最终 **1/1 通过**（15.6 秒，无 retry/skip），同一测试内依次完成 D01 和 D02 的主链；不把这一个测试重复累计成两个测试通过数。六次实际浏览器下载均核对准确文件名、完整字节和 SHA-256，且只有两次明确执行、两个 run、一个原财务上传。
- 采用日志：`ux-coverage-authoring-correction-3-20261026.log`。测试文件冻结 SHA-256：`fa3609a674e64666bc848a2cced5f41269d87d1daafacdb7016a4f15e35478f4`，命令前后相同。产品源码未作改动；根执行者另保存当前产品冻结范围。
- 首次及 correction-1/2 的原日志保留。分别修正了新 fixture 的 writer_version 不属于公共 enum、新测试误用页面全局同名下载按钮定位、以及误认为成功历史任务应返回项目 run 路由。实际历史链接直达该轮 `#/artifacts/<原 revision ID>`，页面继续核对原 run，修正仅影响测试，不将这些失败记为产品缺陷。
- 三张实际 PNG 已逐张核看：`desktop-authoring-first-pair.png`、`desktop-authoring-next-pair.png`、`desktop-authoring-original-history-pair.png`。首轮/第二轮对应第 1/2 版与项目当前 V1/V2；历史仍第 1 版，两种下载可达、无遮挡。前两张为 1440×2168/2162 的完整长页截图，历史页为 1440×995。
- HTTP 状态、后台完成及 OOXML 内容均为受控合成数据；截图里的已扣费文字不证明真实账务，下载正确也不证明专业内容或 Word/WPS 客户端验收。

归档：[首轮双稿](../acceptance/desktop-ux-coverage-20261026/authoring/desktop-authoring-first-pair.png)、[第二轮双稿](../acceptance/desktop-ux-coverage-20261026/authoring/desktop-authoring-next-pair.png)、[原历史双稿](../acceptance/desktop-ux-coverage-20261026/authoring/desktop-authoring-original-history-pair.png)、[主链日志](../acceptance/desktop-ux-coverage-20261026/authoring/playwright.log)。同一条新主链也在首轮广泛报告再次通过，未重复累计。

## 历史基线报告与源码来源（4cd1c39）

历史基线按**每个测试文件采用最后一次完整运行**，不是将多次执行相加。[browser-results.json](../acceptance/desktop-ux-coverage-20261026/browser-results.json)逐套记录采用阶段和测试标题，包含原始失败历史及报告 SHA-256。当时 `--list` 为 **39 文件、668 条**，与采用结果 **662 passed / 0 failed / 6 skipped / 0 flaky** 一致。新增助手 21 条、复核下载 2 条已经包含在 662 内；它们不再另加。这些历史运行支持十五条基线和 G01/G02，不包含本次人工暂停修复或 G03 新输入同任务续做的运行验收。本次修复单独记录 11 条桌面与 7 条单元结果，不与 662 相加。

| 阶段 | 原始结果 | 采用方式 |
| --- | --- | --- |
| first | 623 条：549 pass、67 fail、7 skip | 保留原失败；采用未受后继改动影响、未整套重跑的文件。首轮从仓库根目录运行，错误工作目录、过期 fixture、旧 UI 断言及负载预算分别诊断。 |
| correction A | 121 条：117 pass、4 fail | 从 `apps/web` 复跑六套材料/生成入口；四项失败继续保留，由 C 的完整文件结果替代。 |
| correction B | 143 条：138 pass、1 fail、4 skip | 采用既有 assistant、project-execution、review-workspace 整套；账号整体 30 秒预算再次耗尽，账号由 C 整套替代。 |
| correction C | **154 pass、0 fail、0 skip**，约 3.5 分钟 | 最终构建后启动干净 5187 服务；整套复验六套材料/生成、account、assistant-continuation、review-completion-download，共九套。最终两个产品文件运行前后哈希一致。 |

六条最终 skip 分别是 consistency confirmation 的可选采集、manual reading 的旧参考基线，以及 review workspace 的四个设计/原型采集或对照；均不承担十五行的必要业务主链。首轮误执行的 `M2 deferred charge prototype screenshots` 是旧可选原型采集，最终配置明确排除；保留其原失败，不记作复测通过，也不参与业务场景验收。

首轮助手文件运行前后均为 `6cc224ce…15d53`；此后修复同项目已保存原稿信息保留，最终为 `52d4b853…31f7f5`。A/B 使用后者，既有助手整套在 B 通过。C 另包含真实 D07 渲染缺陷修复，最终文件为：

| 产品文件 | 历史 C 采用的 SHA-256 |
| --- | --- |
| `apps/web/src/project-assistant.ts` | `52d4b853c592737e4ec4b051a1e2b9010c96a1dd34d2abfebd0a5316b231f7f5` |
| `apps/web/src/material-workspace.ts` | `3e0e14d31966d7353f9c879e6ff0e0c5c7327078b147bff9b259e5c16681f598` |

截至历史 `4cd1c39`，其他产品模块相对本轮基准未修改；当时材料文件的差异仅为市场映射读取加 own-property 判断。C 复跑受影响的材料套件，首轮的正常 Word 往返/当前草稿证据按当时范围采用。[final-file-snapshots.json](../acceptance/desktop-ux-coverage-20261026/checks/final-file-snapshots.json)保留该历史源码/测试绑定，未改写为本次源码。本次人工暂停修复涉及六个前端模块，最新范围与哈希另见[manual-pause/sources.json](../acceptance/desktop-ux-coverage-20261026/manual-pause/sources.json)及其验收记录；旧 662 项未整体复验。

首轮命令在仓库根目录执行，A/B/C 工作目录为 `apps/web`；设置 `BB_E2E_BASE_URL=http://127.0.0.1:5187` 和 `BB_E2E_BROWSER_CHANNEL=msedge`，两 worker、零 retry。报告内 `config.argv` 保存实际参数；C 的完整选择命令为：

```powershell
node ../../node_modules/@playwright/test/cli.js test --config playwright.desktop-coverage.config.ts '(m4-workspace|material-draft-comparison|material-reference-picker|pr745-market-acceptance|batch-delivery-workbench|generation-entry-intent|account|assistant-continuation|review-completion-download)\.spec\.ts$' --output ../../.local/desktop-correction-c
```

[首轮日志](../acceptance/desktop-ux-coverage-20261026/checks/browser-first.log)、[A 日志](../acceptance/desktop-ux-coverage-20261026/checks/browser-correction-a.log)、[B 日志](../acceptance/desktop-ux-coverage-20261026/checks/browser-correction-b.log)、[C 日志](../acceptance/desktop-ux-coverage-20261026/checks/browser-correction-c.log)保留执行过程；提交版仅规范换行/行尾空白，本地原始日志保留。构建、契约和 883 项单元检查的实际记录见[总验收](../acceptance/desktop-ux-coverage-20261026/README.md)。

## 本轮断言索引与报告采用

下面索引已逐项读取测试正文，记录实际断言而非只凭标题认定通过。路径均相对 `apps/web/tests/`，行号定位主链起点。报告采用关系见上节；多套测试可以共同覆盖一条旅程，同一套测试也可以证明两条旅程各自需要的行为，但不因此增加分母或虚构独立运行数。

| 行 ID | 连续主链或明确入口 | 具体终点与必要恢复证据 |
| --- | --- | --- |
| D01 | `authoring-onboarding.spec.ts:504` | 新建→财务上传→明确执行→同 run 双稿的实际文件名/字节/哈希；`authoring-source-guide.spec.ts:63` 逐项补齐准确源信息；onboarding 的 409/网络失败保留字段、execution 的预检与未知回执分支补齐恢复。 |
| D02 | 同一 authoring 连续测试后半段 | 明确第一轮清洁稿 edit base→第二次执行→新双稿→真实任务历史→原双稿不变；`authoring-continuation.spec.ts:542/569/598/638` 核对完整未知请求、只读回执与输入保存不确定；`project-execution.spec.ts:260/827/1002` 核对积分返回、原 run 动作和明确新输入。 |
| D03 | `review-followup.spec.ts:293`、`review-completion-download.spec.ts:83/110` | 原 finding 保存要求/真实补料/固定完整复核输入；新两条连续链分别从人工免费导出和补料明确复核实际下载 V3 双稿、验证 run/文件名/字节/hash/OOXML，再下载不变 V1。原 followup 单条只打开 V3 的证据不足已由新两条补齐。`review-flow-editor.spec.ts:14/52`、`review-result-continuity.spec.ts:230/329`、`review-editor-recovery.spec.ts:48/90/112` 另覆盖弃改、完整 decisions、历史身份、未知导出和账号切换。 |
| D04 | `project-document-journey.spec.ts:168` | V2 上传只保存→明确采用→免费检查固定源/文件→选择两份核对 9,000→明确确认→部分成功/失败保留→成功文件双稿实际字节→返回项目文件仍为准确 V2；`consistency-confirmation.spec.ts:98/188` 补齐选择/人工事项/长确认框；旧检查/旧更新由 history 两套补齐原任务身份及读取失败恢复。 |
| D05 | `desktop-file-workflow.spec.ts:44/70/121`、`project-file-return.spec.ts:56` | 非 init 目录真实文件保存到所选 family/CAS；未知上传沿原 envelope；旧 child task 原生打开→壳返回；文件筛选/中文查询/折叠/阅读位置和刷新保持；history 两套核对第 31 轮以后原结果、越权/缺失不替换。 |
| D06 | `m4-workspace.spec.ts:155/218/349/359` 与 `word-roundtrip.spec.ts:49` 的单份表单分支；`batch-delivery-workbench.spec.ts:29` 的文件包分支 | 单份缺项定位、明确开始、固定要求/运行中只改下轮、完成后预览失败仍可下载；原生单份续改表单的完整执行和实际 Word 字节由 word-roundtrip 验证。文件包明确三份选择/费用/确认，停止后续保留正在运行者，四份实际双稿核对原 run/源/模板/要求/hash，再进入下一轮准备且不执行；`file-generation-workbench.spec.ts:248/335/399/434` 补齐部分保存、上传、未知受理和过期会话。单份首次生成的 completion 测试只断言下载按钮可用，不把它单独写成已实际下载。 |
| D07 | `material-draft-comparison.spec.ts:22/75/108` | 真实 CAS 冲突展示完整业务字段及双方准确 pin；保留本地用新版本只保存同一完整 body；采用服务器无额外写入；暂缓/Escape 不提交；同套二次服务器变化、未知 PUT、并发本地编辑分支保留未核对输入且不执行。 |
| D08 | `material-reference-picker.spec.ts:18/89/103` | 实际 picker 明确 source/material 用途，PDF/DOCX/XLSX 准确版本注册一次，再对完整当前文种草稿 CAS 保存一次；保持其他文种、原 source/项目文件绑定；同套晚到注册、CAS 冲突、未知注册回执分别保持登记事实与未保存草稿，不把二者混为成功。 |
| D09 | `material-task-draft.spec.ts:40/77/142` | 从 legal 打开历史 init 任务的原完整输入对照→返回当前 init，保留十二文种及当前全部输入；明确 artifact 继续只改目标 edit base/scope，其他文种不变；历史 run manifest 不被当前输入覆盖；深链/重载和原未决请求保持由同套断言。旧 Word 字节的下载不在这一条输入对照测试内，实际旧/新文件另由 D14 的原生文件旅程证明。 |
| D10 | `qa-result-next.spec.ts:81` | 原历史题目明确采用→实际补充 DOCX→知识选择→120 确认→准确完整 draft/answer 请求→queued/running/succeeded→新旧 Word 实际字节与历史不变；`project-qa-recovery.spec.ts:68/79/124/159` 核对失落回执、完整 CAS 双方选择、跨页同 key 及同一受理。 |
| D11 | `integrity-delivery.spec.ts:46/69` | 原企业/人员 Word→原轮准确主体补证→明确免费导出→queued/running/succeeded→新双底稿→旧双底稿字节不变；受理后补证不混入冻结成果；`integrity-continuation.spec.ts:109/138/156/174` 核对免费确认、未知导出/证据/已上传字节和 owner 隔离。 |
| D12 | `parallel-projects.spec.ts:64/218/259` | B 完成不挤走 A 旧任务/焦点/位置；真实离线保留上次全范围，重连在响应后才更新；真实准确结果导航核对 artifact/run GET，再 Back 从新数据恢复原范围/位置；分页失败、可见性轮询及迟到账号响应同套覆盖。 |
| D13 | `assistant-continuation.spec.ts:102/141/157/174`、`project-assistant.spec.ts`、`result-handoff-assistant.spec.ts` | 准确原 clean→跨项目 source 正确替换/同项目已保存 source 保留→原文种表单/任务卡→明确执行一次→同一 completed run→实际 Word 字节/hash；缺失/多义/错误身份/晚到响应保留完整草稿。C 21 条与 B 既有助手、首轮历史交接共同证明产品帮助、讨论、会话/导航及准确成果。 |
| D14 | `word-roundtrip.spec.ts:49` | 真实项目文件行固定 run→明确继续→保留 source/material/template/requirements→新增修改要求→原生单次执行→新 Word 实际下载→返回文件 family→版本历史下载 V1/V2，字节分别不变/对应新稿；错误 run/同名/不可用登记不猜稿。 |
| D15 | `word-roundtrip.spec.ts:102/124/136/153` | 下载原 OOXML→真实行目标上传合成离线修改稿→准确 family/CAS 保存→历史再下载修改字节→明确免费检查全部当前文件；同时核对新版本冲突、未知 import、已确认保存后列表失败及切 owner 恢复。实际 Word/WPS 人工编辑质量仍另验。 |
| G01 | `register.spec.ts:44/71`、`account.spec.ts:186/254` | 注册约定版本并进入已登录页；无效/失败保留输入；会话撤销返回登录；账号注销要求预检/本地与服务端确认，完成后两个页签均无私有数据。 |
| G02 | 历史 `account.spec.ts:349/358/366/375`、`billing-navigation.spec.ts:37/52`；[本次人工暂停定向验收](../acceptance/desktop-ux-coverage-20261026/manual-pause/README.md) | 结算/预留/释放分别呈现、分页及失败保留，充值返回原 review/检查，退出清除迟到记录。到账不创建未开始的新任务；已受理动态积分任务仅因耗尽暂停时可自动续跑，人工暂停需手动继续。本次验证弹窗刷新、充值页说明及余额恢复后继续入口；真实支付/结算未由合成断言证明。 |
| G03 | [UX-A03 要求](../testing/bondbuddy-test-plan-v6/user-scenarios.md#ux-a03-运行中漏材料想暂停补齐后继续原任务)及[当前源码/协议审计](pause-supplement-resume-20261026.md) | 已有固定输入暂停/恢复不能证明新材料进入原任务；缺少同一 run 采用版本化新输入的协议和必要重做/费用设计。运行测试 `not_run`，未声称真实运行失败。 |

### 运行前提诊断，保留首轮失败

- 本轮 broad 首轮从仓库根目录执行。`m4-workspace.spec.ts:128` 直接读取 `process.cwd()/src/style.css`；`material-draft-comparison`、`material-reference-picker` 经 `m4-upload-thirteenth-fixtures.ts:141`，`pr745-market-acceptance` 经 `material-prior-result-fixtures.ts:90` 依赖相同的 `apps/web` 工作目录。部分 review/进度原型也依赖相对目录。这些 `ENOENT` 是测试前提不满足；首轮报告保留，A/B/C 从正确目录复验，不通过削弱原业务断言消除失败。
- `project-execution.spec.ts` 的两个上传 fixture 以固定 2026-09-27 时间作为会话有效期，早于执行日期，被现有过期校验正确拒绝；仅将合成会话到期日改为未来。其余测试修正为当前未知提交文案、刷新后等待已恢复的准备摘要/原生展开材料、点击可见报告期 label 后断言 radio checked。原请求 key/body、上传次数、同一 run、旧输入不变和准确替换材料断言均保留；原文件定向 **8/8** 及 B 整套 **60/60** 通过。
- `account.spec.ts:186` 首轮在最终注销 click 碰整体 30 秒预算，原样隔离 **1/1**（10.5 秒）通过；B 已完成注销和双页退出，仍在最后旧凭证登录 click 碰相同整体预算。仅此完整两页/多次拒绝/截图旅程设为 60 秒，所有步骤断言不变；C 全旅程约 **29.8 秒**通过，账号整套 **10/10**。没有用隔离通过覆盖原两次失败，也没有因此改产品。
- A 中 D07 的 `fields.market='constructor'` 是确实的产品渲染缺陷：普通对象继承的 `constructor` 被当作市场数组调用 `.filter`，使页面无法挂载。`material-workspace.ts` 只增加 `Object.hasOwn` 保护，原失败用例不改；C 对照套件 **19/19** 通过。
- A 的两个选材 CAS 用例在热更新服务中因 fixture 与产品载入不同 URL 的 `ApiError` 构造器而误入通用错误分支。独立审查核对模块 URL 后，在最终构建、干净 Vite 服务下以**相同 fixture 和断言**通过；没有将登记成功替代草稿 CAS。C 选材套件 **20/20**。生成入口另将共享 helper 的旧固定 V3/旧“当前版本”文案定位修正为当前版本格式，保留原 envelope/版本身份断言，C 对应套件 **24/24**。

## 二十三张任务卡的映射

本表列明正常交付及恢复要求与基线的对应关系，同一受控旅程和 run 可以承担多张卡的断言。映射本身不证明通过；UX-A03 新输入同任务续做的证据缺口由 G03 保持开放。

| v6.1 任务卡 | 本轮对应业务旅程 | 需要保留的用户结果 |
| --- | --- | --- |
| UX-N01 更新已有募集书 | D02、D04 | 准确旧稿、新轮与双稿下载 |
| UX-N02 无历史稿新编 | D01 | 无历史稿可明确开始，不虚构原稿或历史修订 |
| UX-N03 补料后复核 | D03 | 保存与执行分开，原轮/新轮成果保持 |
| UX-N04 业务文书表单生成 | D06 | 准确文种、输入、明确执行和下载 |
| UX-N05 准确成果继续修改 | D14、D09 | 固定所选成果，不借当前同名稿 |
| UX-N06 免费帮助与专业问答 | D13、D10 | 帮助不创建业务任务，专业问题有明确费用确认 |
| UX-A01 原稿信息漏填 | D01、D02 | 定位准确缺项，补齐不重复上传或自动开始 |
| UX-A02 选错文件/期间 | D01、D02、D06、D08 | 保留输入，明确改选，不使用旧报价/旧范围执行 |
| UX-A03 运行中暂停补料续做 | D01、D02、D06；必过门 G03 | 已确认要求为暂停→保存并采用新材料→继续同一 run，以新输入版本可追溯且无重复工作、费用可理解。当前固定输入 pause/resume 不能覆盖该要求：functional_gap / design_gap；新输入续做测试 not_run |
| UX-A04 运行中保存下轮补料 | D02、D03、D06、D10 | 本轮冻结输入不变，新材料/要求只供明确开始的后继轮 |
| UX-A05 积分不足并返回 | D02、D04、D06、D10 | 保留范围，未开始任务仍需明确开始；已受理动态积分任务按原规则恢复同一任务，人工暂停需手动继续 |
| UX-A06 主动停止 | D02、D06 | 停止后续与正在运行的文件分开，保留合法最终成果 |
| UX-A07 失败后补正 | D02、D03、D06、D10 | 保留真实失败原因和旧成果，明确准备/开始新输入 |
| UX-C01 上传中断 | D01、D05、D08、D15 | 原会话/文件身份可辨，必要时重选原字节 |
| UX-C02 上传 complete 回执未知 | D05、D08、D15 | 原上传/保存读回，不造第二材料或假报已保存 |
| UX-C03 开始响应丢失/双击 | D02、D04、D06、D10、D13 | 原完整请求可恢复，不误建新轮 |
| UX-C04 运行中离线 | D02、D06、D12 | 保留真实进度与失败反馈，回网读取原任务 |
| UX-C05 离开并重登 | D02、D05、D13 | 服务端原任务/成果保持，账号正确隔离 |
| UX-C06 成功后下载失败 | D02、D03、D04、D10、D11、D14 | 原成果重新下载，无自动重生成 |
| UX-C07 后台暂停/恢复 | D02、D06、D12 | 展示真实原因，沿允许的原任务动作恢复 |
| UX-C08 两页编辑同项目 | D07，并交叉 D02、D03、D08 | 完整冲突可核对，旧页不静默覆盖新输入 |
| UX-C09 过期/切账号 | D05、D10、D12、D13 | 清除旧账号内容，迟到响应不污染新会话 |
| UX-C10 两项目余额竞争 | D02、D06、D10、D12 | 展示可信受理/不足/待核状态，不谎称未执行或重复执行；真实账本竞争另列统一验收 |

`UX-A03` 的 v6.1 调查基准为旧 `55941dc`；其第 237–260 行已确认的是完整同任务补料续做目标。2026-10-11 动态余额/实时进度改动已实现主动 pause、检查点和固定输入 resume，当前 `apps/api/src/server.ts`、`packages/contracts/src/index.ts`、`apps/api/src/queue.ts` 仍保留这些能力。因此旧 **FG001（缺主动暂停）已被该实现取代**，不再当作现存缺口。

**FG002（新材料进入同一 run 的版本化续做）仍为 `functional_gap`，其重做范围与追加价格公式仍有 `design_gap`。** 当前源码/协议审计显示 resume 仍按原 `input_revision` / `input_hash` 恢复，没有把新材料作为版本化新输入采用到同一 run 的公共协议。尚未执行新输入续做产品实测，测试状态为 `not_run`，不能据源码审计伪称已复现运行 `fail`。取消后新建、保存为下轮草稿或当前固定输入恢复均不能替代这项已确认要求。用户已选 B“必要重做另行报价并确认”，没有批准 A 原价封顶，也尚未确定追加价格公式。版本化协议仍为 proposed；具体来源与待决定事项见[暂停补料续做审计与设计草案](pause-supplement-resume-20261026.md)。

## 已交付内容，避免重复实施

- R1–R44 对应的现有文件、复核、生成、QA、诚信、恢复、历史和确认体验保留，先复验当前行为，只修实际失败。
- [检查历史读取验收](../acceptance/desktop-check-history-20261026/README.md)已覆盖明确 `run` 的旧检查读取、原文件往返、404/短暂失败和只读边界。
- [更新任务历史读取验收](../acceptance/desktop-update-history-20261026/README.md)已覆盖仅 `update_run` 的原检查反查、原 V1/交付 V2/当前 V3 区分、原双稿和失败恢复。当前基准已包含 #748，旧“最近 30 轮之外完全不能读”不再登记为待实现缺口。
- 这些已有历史修复的测试/截图属于对应业务行 D04/D05，不能另加两条已完成场景抬高覆盖率。

## 基线补齐、修复及剩余工作

1. **D01/D02 连续编制证据。** 原 onboarding 财务旅程只到 queued/reload，continuation fixture 不允许实际下载。新增连续创建、两轮明确执行和六次准确 Word 下载，配合源信息与恢复回归完成整行证据，没有重做产品页面。
2. **D03 新复核 Word。** 新增免费人工导出、补料完整复核两条连续链，均下载新 V3 双稿及不变 V1；[两条证据与截图](../acceptance/desktop-ux-coverage-20261026/review-completion-download.md)，最终 C 再次 **2/2**。
3. **D13 成功卡续改。** 原成果缺失时误用旧底稿、跨项目上下文不准、同项目已保存来源信息被旧服务器字段覆盖均已处理；[21 条验收、源码快照与截图](../acceptance/desktop-ux-coverage-20261026/assistant-continuation.md)。C 再次 **21/21**，既有帮助/讨论/会话与历史交接共同采用。D14 的项目文件入口独立验收，没有重复增加同一缺陷的分母。
4. **D07 草稿可恢复。** 市场字段命中继承属性时不再导致页面崩溃，原失败用例及整套冲突对照通过。D06 单份表单、文件包与十二文种入口均完成采用；停止后续和部分交付沿既有协议验证。
5. **继续完成 G03。** 十五行基线、G01/G02 和已有回归证据均保留；G03 新输入同任务续做、重做边界和可理解费用尚未完成，用户整体目标保持 active，不宣称达到整体 90% 或主要全部覆盖，不发布。先形成可审阅设计，再落实并验证新材料确实进入同一 run、旧工作保留、无重复调用及费用解释。历史候选“查看已保存材料”披露区的跨重画展开保持尚未作为独立实际阻断复现，不宣称已修复。
6. **人工暂停优先的既有规则修复。** 修正双暂停标志并存时错误承诺到账自动续跑、已开充值弹窗未更新，以及已到账 M4 缺继续入口的问题。定向 11/11、单元 7/7、web 构建通过；[操作提案](prototypes/pause-supplement-resume.html)独立演示 QA 3/3。二者均未实现 G03 新输入协议；补料重做采用 B 另行报价确认，追加价格公式仍待确定。

## 独立跟踪，不冒充本轮结果

后续已补充[原任务输入数据库保护](../acceptance/desktop-ux-coverage-20261026/run-origin/README.md)，作为 G03 版本化续做的前提。隔离 PG 回归 34 pass / 0 fail / 1 skip，未新增用户旅程或活动执行版本，不改变 G03 的未完成结论。

后续新增[准确执行的完整业务快照](../acceptance/desktop-ux-coverage-20261026/execution-business-snapshots/README.md)：M3/M4 快照、实际 loader、独立 gate 和模型调用前复核改为准确执行身份读取，保留 V1、旧内容和账务。此项是必要执行基础，未开放新材料采用或增加 G03 用户旅程通过数；具体追加价格仍待确定。

| 后续事项 | 本轮记录方式 |
| --- | --- |
| 真实服务、worker/模型、PG/Blob 与真实账务 | 未执行或引用独立报告；合成 HTTP/SQL pool 不代表通过 |
| Word/WPS 实际离线编辑、可读可编辑与内容排版 | 真实客户端另验；本轮受控 DOCX 字节只用于页面下载/回存身份 |
| 专业内容、数字/法规与目标用户可理解性 | 专业/目标用户判断独立，尚未测得学习成本、完成率或留存改善 |
| 手机优化 | N/A，本轮不新增手机适配或专项验收 |
| 全历史分页、长期监控、人工事项持久解决状态、逐字段三方合并 | 独立后续需求，只有本轮实际主链被其阻断时才登记具体功能缺口 |

### 后续成果执行来源增量

新增[成果绑定准确执行来源](../acceptance/desktop-ux-coverage-20261026/artifact-execution-bindings/README.md)：0125 对全部 artifact 状态/业务版本绑定不可变执行/输入身份，实际 API/Worker 消费者读取准确 V1 来源，缺失不能回退旧 artifact/run。真实 PG、HTTP 授权下载和 Worker previous_output 门验证有效来源可用、缺失来源拒绝且旧历史保留。最终各独立组为 API 26/26、消费者 89 pass/2 skip、交付 13 pass/1 skip、Worker 62 pass/2 skip、Worker PG 38 pass/4 skip；新 Worker 测试随后仅顺序化单连接证据查询，最终 1/1，不与前组累计。首次失败及修正、1,670 项源码冻结和本轮数据库停机证据独立保留。没有浏览器或新输入续做全旅程，V2/采用、版本化报告/成果、重做增量和 B 追加价格仍未完成，G03 与完整 goal 保持 active。

### 后续实际交付记录增量

[执行交付记录验收](../acceptance/desktop-ux-coverage-20261026/execution-deliveries/README.md)追加准确 V1 交付 receipt 与成员，不再以整个 run 成功或当前配对推断所有候选均已交付。终态与原结算事务共同提交，旧非动态 M4 耐久读取另记阶段；命名、历史分页、助手成果选择、最新成果和 previous_output 使用准确交付。完整成员及来源丢失时对应阶段拒读，实时撤销和测试授权仍有效。各组与各轮结果只在专项 summary 中分别列明，不相加为用户旅程覆盖率。该轮另确认两成员首稿被旧历史 baseline 必需条件漏列的独立边界，不将后续修复倒记为当时已通过。本轮没有采用新材料、追加报价确认、后继执行或完整桌面新输入续做验收，G03 和完整 goal 继续 active。

### 后续双稿历史修复

[双稿历史验收](../acceptance/desktop-ux-coverage-20261026/history-pairs/README.md)修复合法双成员成果被历史漏列：基线仅按冻结交付记录实际存在时返回，旧三成员与 single/null 兼容，混合分页保留；已声明的基线不能因损坏而省略。真实 PostgreSQL/HTTP、成员私有字节及实时权限按专项证据验证，没有新增前端流程、浏览器验收、采用或追加计价。此定向修复不增加用户旅程分母或上调整体比例，G03 和完整 goal 仍未完成。
