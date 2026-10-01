# #20 逐条规则审核清单

版本：`2026.09.27-draft.6`。31条已完成有边界的文献核对；25条有受限检查，6条有明确人工审核处理。专业签认/真实结果另验。

已填好的[逐条依据、适用性、例外、处理和正反例记录](RULE-REVIEW-20260927.md)是本轮交付，不再将工程处理列为20条空白；不代填真人审核或发布审批。

由 `scripts/sse_private_review_items.py` 与来源映射生成，不在本文件直接签认。正式审核记录须绑定此版本/commit、实际审核人及权限、时间、决定、理由和证据；本表不写入发布审批。

每条可选择同意、修改或待补证；同意文本方法不等于批准来源现行效力、真实财务事实或最终Word。工程检查的合成用例见 [交接](EXECUTABLE-CHECKS.md)，真实成果另填 [验收表](ACCEPTANCE.md)。

## 逐字段来源与冲突处理

规则：`sse-private-source-authority`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：逐字段处理冲突，不建立所有文件通用的权威排名；同名公司/不同口径反例不能自动选值。

依据：[sse-application-2023/P00093](../../verification/2026-09-26/sources/sse-application-2023.md#p00093) · [sse-disclosure-2023/P00024](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00024)

范围与保留项：逐字段证据优先级为内部方法；官方来源没有规定一个适用于全部事实的文件排名。

下一份交付：已实现 sourceSelection 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#source-authority)；真人专业签认及发布记录仍另行填写。

## 目标报告期及滚动窗口

规则：`sse-private-period-window`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：自然年度普通私募两年及一期；章丘2022/2023年末、任丘2023/2024及2025中期分别检查，不删独立三年回溯。

依据：[sse-application-2023/P00440](../../verification/2026-09-26/sources/sse-application-2023.md#p00440) · [sse-application-2023/P00443](../../verification/2026-09-26/sources/sse-application-2023.md#p00443) · [sse-application-2023/P00453](../../verification/2026-09-26/sources/sse-application-2023.md#p00453) · [sse-application-2023/P00183](../../verification/2026-09-26/sources/sse-application-2023.md#p00183) · [sse-application-2023/P00186](../../verification/2026-09-26/sources/sse-application-2023.md#p00186)

范围与保留项：8.1.4是财务材料两年及一期要求，不自动缩短业务、评级、重组等独立回溯期间；年末、成立不足两年及豁免按证据判断。

下一份交付：已有受限检查；特殊窗口、年末与最新一期/财务有效期仍逐案审核。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#period-window)；真人专业签认及发布记录仍另行填写。

## 空值、用户陈述与待确认信息

规则：`sse-private-evidence-state`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：用户陈述和OCR存疑不能等于verified；明确局部缺口标记而非一律阻断全文。

依据：[sse-disclosure-2023/P00024](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00024)

范围与保留项：用户陈述、OCR置信度与待确认标记是产品事实状态；不能因有用户输入就声明审计或公开核验通过。

下一份交付：已实现 evidenceUse 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#evidence-state)；真人专业签认及发布记录仍另行填写。

## 发行主体、口径与单位一致

规则：`sse-private-identity`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：确认发行主体与合并/母公司、币种和单位分别绑定；同名不等于同一主体。

依据：[sse-application-2023/P00093](../../verification/2026-09-26/sources/sse-application-2023.md#p00093) · [sse-application-2023/P00094](../../verification/2026-09-26/sources/sse-application-2023.md#p00094) · [sse-application-2023/P00200](../../verification/2026-09-26/sources/sse-application-2023.md#p00200)

范围与保留项：实体、合并/母公司、币种、单位、期间逐项绑定；地方国有企业不能据名称自动认定城建类。

下一份交付：已实现 identityComparison 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#identity)；真人专业签认及发布记录仍另行填写。

## 私募发行对象与人数限制

规则：`sse-private-private-investors`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：发行200/201人和转让后200/201人分别核；补充穿透、分类和例外依据。

依据：[csrc-measures-2023/PAGE011](../../verification/2026-09-26/sources/csrc-measures-2023.md#page011) · [csrc-measures-2023/PAGE012](../../verification/2026-09-26/sources/csrc-measures-2023.md#page012) · [sse-private-listing-2023/P00011](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00011) · [sse-private-listing-2023/P00025](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00025)

范围与保留项：200人分别检查发行及同次债券转让后持有人；机构适当性分类、穿透或例外仍需投资者适当性完整规则。

下一份交付：已有受限检查；仍缺证券业协会/适当性配套全文和真实投资者适用性审核。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#private-investors)；真人专业签认及发布记录仍另行填写。

## 上交所财务有效期

规则：`sse-private-financial-validity-sse`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：6个月、获准至多1个月延期与到期新申报分别处理；已申请不等于同意。

依据：[sse-application-2023/P00445](../../verification/2026-09-26/sources/sse-application-2023.md#p00445) · [sse-application-2023/P00446](../../verification/2026-09-26/sources/sse-application-2023.md#p00446) · [sse-application-2023/P00447](../../verification/2026-09-26/sources/sse-application-2023.md#p00447) · [sse-application-2023/P00452](../../verification/2026-09-26/sources/sse-application-2023.md#p00452)

范围与保留项：有效期截止日后新申报应更新材料；在审封卷延期不是自动宽限，须申请和交易所同意。缺申报日/批准证据不能判通过。

下一份交付：已有受限检查；封卷20日条件、批准凭证和实际申报日期另核。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#financial-validity-sse)；真人专业签认及发布记录仍另行填写。

## 本期条款、多品种及机构联动

规则：`sse-private-current-terms`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：未知条款标待确认；私募挂牌条件确认不写成公募注册，多品种/机构变化需本期依据。

依据：[sse-private-listing-2023/P00022](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00022) · [sse-private-listing-2023/P00038](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00038) · [sse-private-listing-2023/P00018](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00018)

范围与保留项：挂牌条件确认不能写成证监会公募注册。发行批文、规模、期限、机构变化均需本期依据；不推定全部条款不变。

下一份交付：已实现 currentTerm 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#current-terms)；真人专业签认及发布记录仍另行填写。

## 组合资金用途与配套材料

规则：`sse-private-funds-use-evidence`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：偿债、补流、项目、股权、基金等组合用途逐项取证；缺许可证不编造取得事实。

依据：[sse-proceeds-2026/P00009](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00009) · [sse-proceeds-2026/P00010](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00010) · [sse-proceeds-2026/P00011](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00011) · [sse-proceeds-2026/P00014](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00014) · [sse-proceeds-2026/P00018](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00018)

范围与保留项：用途可组合；生产性支出概括约定是有条件安排，不向所有项目自动套用。基金/股权/工程资料缺失逐项标记。

下一份交付：已有同口径用途分项精确加总、逐项材料证据检查；仍须接本期条款/材料适配，条件性简化披露单独审核。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#funds-use-evidence)；真人专业签认及发布记录仍另行填写。

## 私募资金用途与约定变更程序

规则：`sse-private-private-use-change`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：限定偿债不能由持有人决议豁免；私募不机械套公募跨类别会议要求。

依据：[sse-application-2023/P00458](../../verification/2026-09-26/sources/sse-application-2023.md#p00458) · [sse-application-2023/P00459](../../verification/2026-09-26/sources/sse-application-2023.md#p00459) · [sse-proceeds-2026/P00028](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00028) · [sse-proceeds-2026/P00029](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00029) · [sse-proceeds-2026/P00030](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00030) · [sse-proceeds-2026/P00031](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00031) · [sse-proceeds-2026/P00032](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00032) · [sse-proceeds-2026/P00033](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00033)

范围与保留项：3.2中公募跨用途类别的会议要求不直接变成所有私募要求；私募仍受8.4.1的未约定/重大影响和3.1限定偿债限制。

下一份交付：已有受限检查；实际约定、重大影响与会议程序逐项审核。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#private-use-change)；真人专业签认及发布记录仍另行填写。

## 发行后模拟及前次资金使用

规则：`sse-private-funds-simulation`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：模拟发行后资产负债表需写清假设；前次募集资金整改仅能依据实际记录。

依据：[sse-proceeds-2026/P00035](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00035) · [sse-proceeds-2026/P00036](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00036) · [sse-proceeds-2026/P00037](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00037) · [sse-proceeds-2026/P00038](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00038) · [sse-proceeds-2026/P00039](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00039) · [sse-proceeds-2026/P00040](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00040) · [sse-proceeds-2026/P00041](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00041)

范围与保留项：发行后模拟公式是待验收内部方法。前次资金用途整改记录、台账和专户凭证缺失，不伪造已整改/合规意见。

下一份交付：已实现 fundsSimulation / previousProceeds 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#funds-simulation)；真人专业签认及发布记录仍另行填写。

## 主体、控制链、董监高与重组

规则：`sse-private-issuer-governance`；工程：manual-evidence-handler-v4；业务审核：待填写。

具体审核决定/反例：重组由材料判断且核现行定义；不凭企业名断定城建，不以单个50%阈值定重大重组。

依据：[sse-application-2023/P00171](../../verification/2026-09-26/sources/sse-application-2023.md#p00171) · [sse-application-2023/P00175](../../verification/2026-09-26/sources/sse-application-2023.md#p00175) · [sse-application-2023/P00177](../../verification/2026-09-26/sources/sse-application-2023.md#p00177) · [sse-application-2023/P00178](../../verification/2026-09-26/sources/sse-application-2023.md#p00178) · [sse-application-2023/P00179](../../verification/2026-09-26/sources/sse-application-2023.md#p00179) · [sse-application-2023/P00186](../../verification/2026-09-26/sources/sse-application-2023.md#p00186) · [sse-application-2023/P00187](../../verification/2026-09-26/sources/sse-application-2023.md#p00187)

范围与保留项：重大重组按引用的现行重组规则判断，单一50%启发式不作为已确认事实；公司法任职/监事安排仍须当期核验。

下一份交付：已实现 governanceReview 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#issuer-governance)；真人专业签认及发布记录仍另行填写。

## 业务板块与收入成本毛利

规则：`sse-private-business-revenue`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：一般10%以上板块披露与后台前三主营业务匹配是两个用途；并列/板块改名需保留。

依据：[sse-application-2023/P00181](../../verification/2026-09-26/sources/sse-application-2023.md#p00181) · [sse-application-2023/P00182](../../verification/2026-09-26/sources/sse-application-2023.md#p00182) · [sse-application-2023/P00183](../../verification/2026-09-26/sources/sse-application-2023.md#p00183) · [sse-application-2023/P00184](../../verification/2026-09-26/sources/sse-application-2023.md#p00184)

范围与保留项：一般10%以上主要板块是披露要求；后台前三合并主营业务收入匹配不替代全文披露。并列、分类变动和非可比期间须保留。

下一份交付：已实现 businessSegment 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#business-revenue)；真人专业签认及发布记录仍另行填写。

## 审计意见及非标补充说明

规则：`sse-private-audit-opinion`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：强调事项及保留意见需有权机构说明/会计师补充/偿债影响；保留事项是否消除需会计师核查。

依据：[sse-application-2023/P00198](../../verification/2026-09-26/sources/sse-application-2023.md#p00198) · [sse-application-2023/P00443](../../verification/2026-09-26/sources/sse-application-2023.md#p00443)

范围与保留项：非标事项说明应来自有权机构/会计师。中期未经审计不可写成审计通过；缺意见页仍可生成标记缺口的工作稿。

下一份交付：已有单报告检查；遍历所有年度，否定/无法表示意见单独审核。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#audit-opinion)；真人专业签认及发布记录仍另行填写。

## 合并及母公司六张表与重述

规则：`sse-private-financial-statements`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：编合并报表时同时披露母公司三表；重述保留原数；新设子公司例外不免全部披露。

依据：[sse-application-2023/P00195](../../verification/2026-09-26/sources/sse-application-2023.md#p00195) · [sse-application-2023/P00196](../../verification/2026-09-26/sources/sse-application-2023.md#p00196) · [sse-application-2023/P00199](../../verification/2026-09-26/sources/sse-application-2023.md#p00199) · [sse-application-2023/P00200](../../verification/2026-09-26/sources/sse-application-2023.md#p00200) · [sse-application-2023/P00202](../../verification/2026-09-26/sources/sse-application-2023.md#p00202) · [sse-application-2023/P00443](../../verification/2026-09-26/sources/sse-application-2023.md#p00443)

范围与保留项：私募财务窗口适用8.1.4；重述、备考和合并范围变化分别保留。不能为勾平报表改写源数。

下一份交付：已有单期表种及指定说明检查；重组备考/会计政策变更/金额勾稽另验。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#financial-statements)；真人专业签认及发布记录仍另行填写。

## 财务指标定义、重算与缺项

规则：`sse-private-indicators`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：不将大公募附加指标清单强塞私募；偿债等适用指标的分母、定义和期间须确认。

依据：[sse-application-2023/P00200](../../verification/2026-09-26/sources/sse-application-2023.md#p00200) · [sse-application-2023/P00201](../../verification/2026-09-26/sources/sse-application-2023.md#p00201)

范围与保留项：3.7.2第二段为面向普通投资者公募附加表，不作为私募强制清单。私募仍披露适用指标，定义取本期条款/专业口径。

下一份交付：已实现 indicator 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#indicators)；真人专业签认及发布记录仍另行填写。

## 资产负债项目构成和变动分析

规则：`sse-private-mdna-thresholds`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：10%和30%均含边界、增减均算；零/负基数不机械比较，低占比重大风险仍需说明。

依据：[sse-application-2023/P00203](../../verification/2026-09-26/sources/sse-application-2023.md#p00203) · [sse-application-2023/P00204](../../verification/2026-09-26/sources/sse-application-2023.md#p00204)

范围与保留项：10%以上/30%以上保留原文字义；低于阈值不豁免重大事项，零/负基数不机械使用百分比。

下一份交付：已有单项目精确小数检查；穷尽近一年/近一期项目及评估价值说明另验。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#mdna-thresholds)；真人专业签认及发布记录仍另行填写。

## 变动原因不能仅凭勾稽推断

规则：`sse-private-cause-evidence`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：同比算对不证明变动原因；模型推测只能变成待确认问题。

依据：[sse-application-2023/P00203](../../verification/2026-09-26/sources/sse-application-2023.md#p00203) · [sse-disclosure-2023/P00024](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00024)

范围与保留项：计算差额不证明业务原因；原专家稿的推测仅作为待确认问题。

下一份交付：已实现 causeStatement 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#cause-evidence)；真人专业签认及发布记录仍另行填写。

## 全口径有息债务与集中偿付

规则：`sse-private-debt-liquidity`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：全口径债务与报表差异需解释，授信总/已用/剩余要有同一时点凭证。

依据：[sse-application-2023/P00205](../../verification/2026-09-26/sources/sse-application-2023.md#p00205) · [sse-application-2023/P00217](../../verification/2026-09-26/sources/sse-application-2023.md#p00217) · [sse-application-2023/P00218](../../verification/2026-09-26/sources/sse-application-2023.md#p00218) · [sse-application-2023/P00219](../../verification/2026-09-26/sources/sse-application-2023.md#p00219)

范围与保留项：全口径债务与报表差异要解释；授信总/已用/剩余额度按实际证据时点，不从余额差自动推断银行承诺。

下一份交付：已实现 debtReconciliation / creditFacility 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#debt-liquidity)；真人专业签认及发布记录仍另行填写。

## 关联交易、担保、诉讼与受限资产

规则：`sse-private-related-contingent`；工程：manual-evidence-handler-v4；业务审核：待填写。

具体审核决定/反例：未搜索到不等于无关联交易、担保、诉讼；后续事项需核至适用时点。

依据：[sse-application-2023/P00206](../../verification/2026-09-26/sources/sse-application-2023.md#p00206) · [sse-application-2023/P00207](../../verification/2026-09-26/sources/sse-application-2023.md#p00207) · [sse-application-2023/P00208](../../verification/2026-09-26/sources/sse-application-2023.md#p00208)

范围与保留项：关联方、或有事项和受限资产需材料及签署日后续事项核验；未检索到不能写为不存在。

下一份交付：已实现 contingentReview 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#related-contingent)；真人专业签认及发布记录仍另行填写。

## 评级与增信分支

规则：`sse-private-rating-enhancement`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：无评级不自动违规；有评级/增信用本期报告及合同，不能新增担保承诺。

依据：[sse-application-2023/P00210](../../verification/2026-09-26/sources/sse-application-2023.md#p00210) · [sse-application-2023/P00212](../../verification/2026-09-26/sources/sse-application-2023.md#p00212) · [sse-application-2023/P00222](../../verification/2026-09-26/sources/sse-application-2023.md#p00222) · [sse-application-2023/P00225](../../verification/2026-09-26/sources/sse-application-2023.md#p00225) · [sse-application-2023/P00231](../../verification/2026-09-26/sources/sse-application-2023.md#p00231)

范围与保留项：无评级不是自动缺合规条件；有评级/增信以本期报告及合同为准，不添加担保人承诺。

下一份交付：已实现 ratingEnhancement 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#rating-enhancement)；真人专业签认及发布记录仍另行填写。

## 投资者保护与协议一致性

规则：`sse-private-protection`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：参考文本可以参照，不等于所有示例承诺强制；协议/募集书/会议规则逐项一致。

依据：[sse-protection-2021/NOTICE](../../verification/2026-09-26/sources/sse-protection-2021.md#notice) · [sse-private-listing-2023/P00127](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00127) · [sse-private-listing-2023/P00128](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00128) · [sse-private-listing-2023/P00143](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00143) · [sse-private-listing-2023/P00144](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00144) · [sse-private-listing-2023/P00145](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00145) · [sse-private-listing-2023/P00146](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00146) · [sse-private-listing-2023/P00147](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00147) · [sse-private-listing-2023/P00148](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00148) · [sse-application-2023/P00462](../../verification/2026-09-26/sources/sse-application-2023.md#p00462)

范围与保留项：参考文本可以参照，不等于每个示例条款均为强制或已约定。增信、会议、违约和受托协议逐项一致；证券业协会配套规则仍待核验。

下一份交付：已实现 protectionTerms 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#protection)；真人专业签认及发布记录仍另行填写。

## 风险、重大事项与全文回写

规则：`sse-private-risk-disclosure`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：更新财务/已发生事项后回写风险；无充分证据不能删除仍有效风险。

依据：[sse-application-2023/P00089](../../verification/2026-09-26/sources/sse-application-2023.md#p00089) · [sse-application-2023/P00090](../../verification/2026-09-26/sources/sse-application-2023.md#p00090) · [sse-application-2023/P00109](../../verification/2026-09-26/sources/sse-application-2023.md#p00109) · [sse-disclosure-2023/P00028](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00028)

范围与保留项：财务和已发生事项更新后回写；金额正确仍不能证明风险措辞充分，不自动删除历史有效风险。

下一份交付：已实现 riskUpdate 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#risk-disclosure)；真人专业签认及发布记录仍另行填写。

## 上交所2025审核重点增量

规则：`sse-private-sse-focus-2025`；工程：manual-evidence-handler-v4；业务审核：待填写。

具体审核决定/反例：城建/地产/集团可同时触发；审慎论证不等于一律禁发。

依据：[sse-focus-2025/P00030](../../verification/2026-09-26/sources/sse-focus-2025.md#p00030) · [sse-focus-2025/P00052](../../verification/2026-09-26/sources/sse-focus-2025.md#p00052) · [sse-focus-2025/P00095](../../verification/2026-09-26/sources/sse-focus-2025.md#p00095) · [sse-focus-2025/P00096](../../verification/2026-09-26/sources/sse-focus-2025.md#p00096) · [sse-focus-2025/P00097](../../verification/2026-09-26/sources/sse-focus-2025.md#p00097) · [sse-focus-2025/P00098](../../verification/2026-09-26/sources/sse-focus-2025.md#p00098) · [sse-focus-2025/P00099](../../verification/2026-09-26/sources/sse-focus-2025.md#p00099) · [sse-focus-2025/P00100](../../verification/2026-09-26/sources/sse-focus-2025.md#p00100) · [sse-focus-2025/P00101](../../verification/2026-09-26/sources/sse-focus-2025.md#p00101)

范围与保留项：城建/房地产/集团等触发后需专门审核。2025重点关注规则仍不能替代2026优化审核包或把审慎论证一律变为禁发。

下一份交付：已实现 focusReview 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#sse-focus-2025)；真人专业签认及发布记录仍另行填写。

## 上交所2026专项品种需增量包

规则：`sse-private-special-overlays-sse`；工程：manual-evidence-handler-v4；业务审核：待填写。

具体审核决定/反例：普通私募包不兜底专项债，专项特征未知不得当无。

依据：本切片尚无经登记的官方依据，待补齐。

范围与保留项：专项品种2026原件已有，但本切片不完成其官方效力及专业验收；不得按普通私募包自动放行专项债。

下一份交付：已实现 specialReview 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#special-overlays-sse)；真人专业签认及发布记录仍另行填写。

## 全文更新、定位和Word交付

规则：`sse-private-document-delivery`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：专家16节骨架不是唯一法定目录；保留历史结构并真实输出修订/批注。

依据：[sse-application-2023/P00089](../../verification/2026-09-26/sources/sse-application-2023.md#p00089) · [sse-application-2023/P00096](../../verification/2026-09-26/sources/sse-application-2023.md#p00096) · [sse-application-2023/P00440](../../verification/2026-09-26/sources/sse-application-2023.md#p00440) · [sse-application-2023/P00441](../../verification/2026-09-26/sources/sse-application-2023.md#p00441) · [sse-application-2023/P00442](../../verification/2026-09-26/sources/sse-application-2023.md#p00442)

范围与保留项：16节是专家工作骨架，不是唯一法定目录/字体标准。税务依据、签章要求、真实Word修订/批注及WPS均另验。

下一份交付：已实现 delivery 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#document-delivery)；真人专业签认及发布记录仍另行填写。

## 私募准入与公募财务门槛隔离

规则：`sse-private-private-negative-list`；工程：manual-evidence-handler-v4；业务审核：待填写。

具体审核决定/反例：私募不设公募利润财务门槛不等于无条件可发行；并行申请/前次未募足要核。

依据：[sse-application-2023/P00455](../../verification/2026-09-26/sources/sse-application-2023.md#p00455) · [sse-application-2023/P00456](../../verification/2026-09-26/sources/sse-application-2023.md#p00456)

范围与保留项：没有财务指标限制不等于没有准入/负面清单/偿债风险要求；证券业协会负面清单现行全文尚未核验。

下一份交付：已实现 negativeListReview 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#private-negative-list)；真人专业签认及发布记录仍另行填写。

## 闲置募集资金临时补流边界

规则：`sse-private-idle-proceeds-2026`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：临时补流与最终补流区分；12个月和付款节点孰早，边界日前语义及原则禁止保留判断。

依据：[sse-proceeds-2026/P00023](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00023) · [sse-proceeds-2026/P00024](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00024) · [sse-proceeds-2026/P00025](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00025) · [sse-proceeds-2026/P00026](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00026)

范围与保留项：受限定偿债等情形原则上不得约定临时补流；不得把2026条款倒写为过去已签订的合同事实。

下一份交付：已有受限检查；真实条款、回收机制、内部决策及例外逐项审核。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#idle-proceeds-2026)；真人专业签认及发布记录仍另行填写。

## 私募定期披露安排

规则：`sse-private-continuing-disclosure`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：年后4个月内经审计财报、半年后2个月内中报；约定完整不证明实际已披露。

依据：[sse-application-2023/P00461](../../verification/2026-09-26/sources/sse-application-2023.md#p00461) · [sse-disclosure-2023/P00009](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00009) · [sse-disclosure-2023/P00023](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00023)

范围与保留项：此处为募集说明书中的披露安排；不宣称已完成存续期所有披露事项的自动监管。

下一份交付：已有受限检查；豁免及存续期其他事项单独审核。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#continuing-disclosure)；真人专业签认及发布记录仍另行填写。

## 信息披露负责人及联络人

规则：`sse-private-disclosure-officer-2026`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：2025-12-26发布但2026-05-01生效；未变更可不重签，但要既有有效承诺。

依据：[sse-officer-2025/P00007](../../verification/2026-09-26/sources/sse-officer-2025.md#p00007) · [sse-officer-2025/P00008](../../verification/2026-09-26/sources/sse-officer-2025.md#p00008) · [sse-officer-2025/P00009](../../verification/2026-09-26/sources/sse-officer-2025.md#p00009) · [sse-officer-2025/P00010](../../verification/2026-09-26/sources/sse-officer-2025.md#p00010) · [sse-officer-2025/P00011](../../verification/2026-09-26/sources/sse-officer-2025.md#p00011) · [sse-officer-2025/P00012](../../verification/2026-09-26/sources/sse-officer-2025.md#p00012) · [sse-officer-2025/P00013](../../verification/2026-09-26/sources/sse-officer-2025.md#p00013) · [sse-officer-2025/P00014](../../verification/2026-09-26/sources/sse-officer-2025.md#p00014) · [sse-officer-2025/P00015](../../verification/2026-09-26/sources/sse-officer-2025.md#p00015) · [sse-officer-2025/P00016](../../verification/2026-09-26/sources/sse-officer-2025.md#p00016) · [sse-officer-2025/P00017](../../verification/2026-09-26/sources/sse-officer-2025.md#p00017) · [sse-officer-2025/P00018](../../verification/2026-09-26/sources/sse-officer-2025.md#p00018)

范围与保留项：2025-12-26发布，2026-05-01生效。任职资格及履职承诺必须实际取得；不适用于上市公司可转债。

下一份交付：已有负责人/联络人、任职审核完整性及真实签署证据检查；仍须接本期任职、禁止情形核验和有效承诺适配，不由模型代签。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#disclosure-officer-2026)；真人专业签认及发布记录仍另行填写。

## 优化审核新旧版本边界

规则：`sse-private-optimized-review-version`；工程：manual-evidence-handler-v4；业务审核：待填写。

具体审核决定/反例：2026-09-04后不沿用2023资格或豁免；普通身份未知不能默认未优化。

依据：[sse-mature-2026/P00010](../../verification/2026-09-26/sources/sse-mature-2026.md#p00010) · [sse-mature-2026/P00054](../../verification/2026-09-26/sources/sse-mature-2026.md#p00054)

范围与保留项：2026-09-04起旧2023版废止；本包不实现知名成熟资格认定、简明披露或豁免，需独立审核新版本。

下一份交付：已实现 optimizedReview 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#optimized-review-version)；真人专业签认及发布记录仍另行填写。

## 受托协议与持续履职衔接

规则：`sse-private-trustee-continuing-duties`；工程：bounded-research-check-v4；业务审核：待填写。

具体审核决定/反例：鼓励措施/示范案例/协议义务和已履职事实分别写，不以示例声称做过。

依据：[sse-trustee-2025/P00005](../../verification/2026-09-26/sources/sse-trustee-2025.md#p00005) · [sse-trustee-2025/P00007](../../verification/2026-09-26/sources/sse-trustee-2025.md#p00007) · [sse-trustee-2025/P00012](../../verification/2026-09-26/sources/sse-trustee-2025.md#p00012) · [sse-trustee-2025/P00013](../../verification/2026-09-26/sources/sse-trustee-2025.md#p00013) · [sse-private-listing-2023/P00128](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00128)

范围与保留项：2025指南包括鼓励措施和示范案例，不把示范案例写为发行人已履行事项；全量履职核验另作存续期覆盖。

下一份交付：已实现 trusteeStatement 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。

文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#trustee-continuing-duties)；真人专业签认及发布记录仍另行填写。
