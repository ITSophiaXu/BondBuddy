# #20 可执行检查交接

版本：`2026.09.27-draft.5`，替代 `2026.09.26-draft.4`。实现为
`@bondbuddy/domain/sse-private-checks::evaluateSsePrivateDraftChecks(pack, input)`。
本文件记录工程实现，不代替业务签认。来源仍未专业签认，31条规则仍全部关闭、无发布记录。

## 已实现的十一组受限检查

| 原规则ID后缀 | 检查范围 | 边界与保留项 |
| --- | --- | --- |
| private-investors | 专业投资者、禁止公开劝诱、发行及转让后各自不超过200人 | 不将两个时点人数相加；适当性穿透、分类和例外仍需人工判断 |
| financial-validity-sse | 截止日后6个月，既有申请获准延期至多1个月 | 不按固定180天计算；已申请不等于获准；新申报超过通常期限另行核对最新报表，不自动沿用延期 |
| private-use-change | 限定偿债不得改非限定用途；未约定程序或重大影响时持有人决议；已约定程序执行 | 不把公募跨用途类别一律开会的要求直接套私募；决议不能豁免限定偿债限制 |
| idle-proceeds-2026 | 明确条款、回收机制、决策程序、内部审批；12个月与原用途付款节点孰早 | 原则性禁止情形保留判断；付款节点未知不能当没有节点；恰在边界日须核对“日前”与合同安排 |
| continuing-disclosure | 年后4个月内经审计财报、半年后2个月内中报的约定 | 只核对披露安排，不证明实际已披露；完整会计期末按月末处理，年度4月30日、中期8月31日 |
| period-window | 已确认自然年度普通路径下，目标截止日对应的两年及最近一期 | 年末不机械增加重复一期；成立不足两年/豁免/非自然年度转判断；不缩短业务与重组独立回溯，也不证明当期可申报 |
| audit-opinion | 单份报告年度审计、意见类型，以及强调事项/保留意见的说明与补充意见 | 未审计中期不生成审计意见；保留事项需会计师核查是否消除，不能强写已消除；否定/无法表示意见另审 |
| financial-statements | 单期合并/母公司三表清单、重述来源保留、重大合并范围变化说明 | 不编合并报表时不凭空要求合并三表；重述保留是内部证据方法；不覆盖附注、备考、金额勾稽及其他期间 |
| mdna-thresholds | 单项目占资产/负债总额≥10%，或增减幅度≥30%，或有重大风险时要求变动及有依据的原因分析 | 精确十进制比较；零/负基数、项目大于总额、口径不可比保留判断；低比例不自动豁免重大风险；评估价值说明另审 |
| funds-use-evidence | 各用途分类、分项规模精确加总、逐项配套材料核对状态 | 仅在清单完整且币种单位/募集总额净额口径一致时比较；生产性支出简化安排另审，不由材料存在推定合法获批 |
| disclosure-officer-2026 | 负责人/联络人姓名职务联系方式、任职审核状态与真实承诺 | 2026-05-01生效；禁止任职情形要完整核验，未变更且有有效既有承诺不重复签署；履职与变更公告另验 |

其余20条仍无对应自动检查；完整覆盖清单继续标为 `uncovered`。十一组的 `checker_id=sse-private-structured-evidence`、`checker_version=3`，参数版本与规则包版本严格匹配。v3同时保留v2九项研究回放，拒绝v1、混合checker版本或错配参数；不把v3新增规则套在旧v2包上。

31条（含未实现项）的具体审核决定、原文定位、反例和下一份交付见[逐条审核清单](RULE-REVIEW-CHECKLIST.md)。本轮没有以自动检查取代专业判断，也没有修改其他五个市场/方式的规则范围。

## 输入、结果与调用边界

- 复用 #19 的 `RulePack`、现有市场/发行方式值和 `FactStatus`。输入为内部结构化证据类型，**不是新增公开API，也不是浏览器可提交的审批对象**。
- 每个值必须有 `status=verified` 和精确来源锚点才进入确定性计算；null、缺字段、无定位、冲突、用户陈述保留 `needs_evidence`。本函数不核验身份/权限或批准事实；可信 #15/#19 适配器负责绑定账号、项目、输入及材料版本，并验证实际审核记录。
- 输入 `asOf` 与财务截止日分离。本次实现只回放2026-09-26研究基准；历史或未来适用日返回 `needs_judgement`，不得据此选择当前规则。日期边界仍在[审核工作表](REVIEW-WORKSHEET.md)等待专业审核。
- 每条 finding 保留原规则ID、来源ID、证据锚点、具体结果。返回包ID/版本、checker版本和当前20条未覆盖规则，顶层始终为 `mode=research_only`、`productionEligible=false`，不提供“全稿合规通过”结论。`pass`只针对该条局部检查，必须连同其他issue/needs_evidence/needs_judgement显示。
- 财务新增输入位于 `FinancialCheckInput`：reportingWindow、auditOpinion、financialStatements、mdnaItem。后三者分别按一份报告、一期报表、一个比较项目调用；可信适配器必须按已锁定材料清单遍历所有应有年度/表种/近一年及近一期项目并保留未成功检查项。只抽出一项通过不得汇总成全部覆盖。金额是最多20位整数、12位小数的规范十进制字符串；比较使用整数缩放，不用浮点近似。证据中的comparable须包含主体、币种单位、期间以及重述口径。
- 研究检查本身不调用模型、不扣积分，也不充当正式规则发布。本次另接入历史稿模型阶段的精确正式规则正文消费者，见下文；不改变 #19 的审核加载、正式发布和撤回门槛。
- 缺失材料仍按 UPD-GAP-01 标待人工确认；这些研究检查不是新增的全文更新硬阻断条件。

## 可复现验证

`npm run build -w @bondbuddy/contracts`、`npm run test:domain`。
测试位于 `packages/domain/src/sse-private-checks.test.ts`、`sse-private-financial-checks.test.ts` 和 `sse-private-proceeds-officer-checks.test.ts`。前两批20组，覆盖缺年度/一期、年末/特殊窗口、中期未审计/年度缺审计、意见分支、有无合并、重述、合并变化、10%/30%精确边界及下降、超安全整数的小数、零负基数/不同口径、低占比重大风险、缺失冲突和版本错配。

全部样例均为合成工程数据；真实样本目标仅用于窗口边界设计，没有将真实数值伪装为已审核。新增用途/负责人11组工程测试覆盖精确加总、部分清单、口径不一致、未知用途/材料、任职禁止核验、承诺新旧分支、v2回放与版本混用。没有真实生产事实适配、模型生成或Word/WPS行业验收，不能用此记录关闭 #20。最终运行结果记录在本轮PR。

## 剩余责任与下一份交付

1. Maxy：按[审核工作表](REVIEW-WORKSHEET.md)和[31条审核清单](RULE-REVIEW-CHECKLIST.md)审阅业务方案、逐条来源和上述日期/例外边界；源码新增测试不自动构成签认。
2. #19 / loooo139：审核通过后的上下文加载分支、真实审核身份、正式发布；调用本函数前须完成来源和事实授权校验。现有只返回待审核的路径不得绕过。
3. #15 / loooo139、#17 / muhualing：可用财务事实及生产接入；单报告/单期/单行检查需完整枚举适配。#265主体审核API及#267预检修复已合并，但不等于财务事实/行业验收完成；API的主体绑定与pin持久化已接入；当前原生财务提取仍仅特定布局/年度/指标，不能视为完整财务事实。
4. #31 / #35：真实输入、生成成果与日志齐备后，由业务方填写成果验收；WPS另行实测。

<a id="v3-input"></a>

## v3 精确输入交接（#15 / Xuefeng）

可直接运行的[合成输入样例](../../../../packages/domain/examples/sse-private-check-input-v3.json)由新增测试实际读取。形状见内部 `ProceedsOfficerCheckInput`；金额沿用十进制字符串，purpose复用contracts的既有六种资金用途code。`supportingEvidence`须代表已核对该项用途/对象所需材料，不是“上传过一个文件”。`completeAllocationInventory`代表全部分项，`sameCurrencyUnitAndGrossNetBasis`同时绑定币种、单位、发行费用扣除前后口径。两者未确认时不得用部分加总判通过。

`disclosureOfficer`绑定本任负责人/联络人与本期资料。`disqualificationReviewComplete`须覆盖第4条逐项禁止情形及其适用观察期间，`disqualificationPresent=false`不能由空搜索结果生成。`changed=false`仍需有效既有或本任新签承诺。`currentSignedCommitment`不接受模型生成的签名；`previousValidCommitment`仅指本任负责人有效的既有承诺。

所有 `{value,status,anchors}` 均须由可信适配器从同一 owner/project/input/material/parse pin 和实际审核记录构造。样例的synthetic锚点与verified仅是测试条件，不可入生产或变成批量确认。无来源值使用null并保留真实状态；本模块不自行增加前台必填问题。其他九组输入见 `SsePrivateCheckInput`/`FinancialCheckInput`；仍须遍历全部应有期间、报告、表种和项目。

## 历史稿的正式规则内容接入（#19 / #31）

`apps/worker/src/historical-rule-context.ts::loadHistoricalRuleGuidance`读取API实际保存的camelCase `ProductionRulePackPin`，复用 `revalidateProductionRulePackPin`复核原release、规则/模板/coverage hash及来源/样本/授权撤回状态，再用既有适用性判断筛选本次规则。将规则正文、例外、要求的输入/证据和对应官方原文/版本/定位提供给模型，放在不可信项目数据区；不授予指令权限，也不产生合规通过结论。

未批准/撤回/版本不一致不会回退研究包或latest；规则正文超过180,000 UTF-8字节暂停，完整prompt仍受240,000字节上限约束，不截断规则。prompt模板升为 `historical-sse-private-v2`；已有v1模型绑定不能在新模板下自动回放或再次计费，输入不匹配会在调用供应商前失败，需保留旧journal并按既有流程处理新run。

以上是正式规则内容消费者，不是把十一项research checker在生产自动启用。#19整体批准loader/正式发布与#15可信事实适配未完成时，真实任务仍需保留明确阻塞原因。工程与真实联调状态见[本轮记录](../../../../docs/acceptance/issue-20-rule-integration-2026-09-27.md)。
