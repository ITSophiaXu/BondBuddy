# PPN 规则与章节草案

版本：`2026.09.27-draft.1`。范围及证据可用于开发；业务checker未完成，正式能力未发布。

| 条目 | 输入 | 判断与例外 | 正例 / 反例 / 边界 |
|---|---|---|---|
| 定向投资者、披露渠道及转让范围（[NA044:PAGE001](../../sources/NA044.md#page001)） | investor_scope, investor_selection_evidence, disclosure_channel, transfer_scope | 区分专项、特定及非法人投资人；全部合格机构与约定部分名单的披露范围不同。公开上传不能替代定向披露。 投资人名单随版本更新，不硬编码2018年180家。 | 有名单及协议依据，渠道/转让范围一致 / 将定向披露写成面向社会公众 / 仅简称PPN，无投资人范围依据 |
| 定向募集说明书与定向协议分支（[NA042:P00088](../../sources/NA042.md#p00088)） | document_stage, disclosure_route, first_issue_in_registration, prior_document_reference | DM用于注册及首期定向募集说明书；后续可用BDM。DX/F1/F2是协议路径，不能静默互换。 成熟层DFI下定向发行可选择公开或定向表格，需明确实际选择。 | 首期募集说明书采用DM，后续引用有版本 / 首期误用BDM删掉核心内容 / 用户未确定募集说明书或协议路径 |
| 财务期间、口径及定向例外（[NA041:PAGE002](../../sources/NA041.md#page002)） | disclosure_route, issuer_tier, listed_status, financial_periods, consolidated_and_parent_sources | 定向募集说明书通常两年审计及半年度；定向协议近一年审计。成熟层和上市公司定向募集说明书不强制半年报，缺少资格依据不自动豁免。 成立不足所需年限按自成立日起；选择公开表格时按该路径，不能无条件套两年。 | 两年审计和合并/母公司披露有证据 / PPN协议无条件要求三年一期或将半年省略泛化 / 成熟层资格与半年报要求不确定 |
| 财务分析、业务及科目变动证据（[NA042:P00610](../../sources/NA042.md#p00610)） | financial_periods, accounting_scope, business_revenue, account_balances, change_reasons | 逐表保留期间、主体、合并/母公司和来源；金额/比例/变化分析不能凭模型补数，重大科目和业务披露依DM条款。 科目30%变动与资产/负债10%等原文条件分开，分母零或负数待判断。 | 同期间口径算数一致且原因有依据 / 母公司数据混进合并表且无提示 / 零分母或重分类导致不可比 |
| 发行前刷报及重要事项（[NA042:P00307](../../sources/NA042.md#p00307)） | registration_date, first_issuance_date, annual_audit_available, interim_available, material_events, legal_opinion_date | 注册后首期前出具新年审且4月30日后首期发行按DM/F1更新；仅新半年报的特殊安排保留。全文更新仍按用户最新材料执行。 监管最低刷报要求不缩减用户全文更新；D.13及后续规则另叠加。 | 满足新年度刷报条件并更新跨章内容 / 将仅半年报例外泛化为所有项目无需更新 / 首次/后续及签署时间不明 |
| 募集资金用途、项目材料与账户（[NA042:P00548](../../sources/NA042.md#p00548)） | funds_use_items, issue_amount, project_approvals, account_arrangements | 核对实需用途、金额、项目资本金及批复，动态金额按上限；股权/基金等用途核政策，不以用户选择直接判合规。 后续2022用途规程及专项要求叠加；注册可简化不等于发行免披露。 | 用途及项目文件可追溯且金额相符 / 用途合计超过发行规模或缺批复仍声称合规 / 项目批复缺失标待人工确认 |
| 受托管理、评级和保护安排（[NA044:PAGE002](../../sources/NA044.md#page002)） | trustee, trust_agreement, rating_choice, investor_protection_terms | PPN按相关自律规则聘请受托人、披露协议主要内容；评级安排由企业确定并披露，不编造评级。 投资人保护示范条款如有才按实际写入，不能强制全部勾选；受托制度另核现行配套。 | 实际受托协议和已选择评级有来源 / 将公开通用“受托如有”直接删PPN受托章节 / 受托协议尚未提供 |
| 发行前、结果及存续披露（[NA044:PAGE009](../../sources/NA044.md#page009)） | issuance_date, disclosure_date, registration_completion_date, business_calendar, ongoing_arrangements | 定向发行前至少1工作日披露；完成债权债务登记次一工作日定向披露结果，转让限约定投资人。 不能将公开首次发行2工作日或交易流通首日直接替代定向特别安排；工作日历未锁定不自动算。 | 披露日期与受众依据齐全 / 以自然日直接代替工作日判通过 / 节假日历缺失 |
| 版本变化、定向事项与授权边界（[NA044:PAGE006](../../sources/NA044.md#page006)） | material_events, registration_notice, latest_rule_version, special_features | 接受注册前后重大/重要事项按相应程序披露与评议；专项产品另有规定从其规定。 本批NA044为2020年12月修订文本，配套发布公告仍需补核；不能以文件名6月日期套效力。 | 变更记录与本期文件对应 / 未审核重大事项就继续声明没有事项 / 再评议结果或规则施行时点不明 |

## 章节字段

- **dm-0 声明与承诺、目录**：issuer, registration_status, responsibility, risk_prompts
- **dm-1 第一章 释义**：defined_terms
- **dm-2 第二章 风险提示及说明**：risks, risk_evidence
- **dm-3 第三章 发行条款**：issue_amount, tenor, pricing, investor_scope
- **dm-4 第四章 募集资金运用**：funds_use_items, project_approvals
- **dm-5 第五章 企业基本情况**：business_segments, ownership, consolidation_basis
- **dm-6 第六章 企业主要财务状况**：financial_periods, consolidated_and_parent_sources, financial_analysis
- **dm-7 第七章 企业资信状况**：credit_history, bank_facilities
- **dm-8 第八章 债务融资工具信用增进（如有）**：credit_enhancement
- **dm-9 第九章 主动债务管理（如有）**：debt_management
- **dm-10 第十章 定向信息披露安排**：directional_disclosure_arrangements
- **dm-11 第十一章 持有人会议机制**：holder_meeting
- **dm-12 第十二章 受托管理人机制**：trustee, trust_agreement
- **dm-13 第十三章 投资人保护条款（如有）**：investor_protection_terms
- **dm-14 第十四章 违约、风险情形及处置**：default_and_resolution
- **dm-15 第十五章 发行有关机构**：institutions
- **dm-16 第十六章 备查文件**：references
