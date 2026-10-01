# DFI 规则与章节草案

版本：`2026.09.27-draft.1`。范围及证据可用于开发；业务checker未完成，正式能力未发布。

| 条目 | 输入 | 判断与例外 | 正例 / 反例 / 边界 |
|---|---|---|---|
| 统一注册与本期实际工具分开（[NA015:PAGE003](../../sources/NA015.md#page003)） | issuer_tier, registration_arrangement, document_stage, covered_instruments, issuance_instrument | DFI是协会项下注册安排，不是另一市场或MTN别名。注册覆盖列表不代表本期工具；本期明确后叠加对应工具包。 境外、ABN、永续、科创等专项即使注册覆盖，也不代表M1已具备生成能力。 | 注册覆盖多工具，本期明确MTN / 把覆盖SCP/CP/MTN列表直接定成本期MTN / 本期工具未明确 |
| 成熟层资格与第一/二类区分（[NA015:PAGE002](../../sources/NA015.md#page002)） | tier_evidence, industry_evidence, audited_financials, issuance_history, credit_and_compliance_events | 按2023母规程条件及2025修订逐项审核；成熟层并不都属于第一类。统计主体、36个月和严格比较符保留。 2025的2.5%、2500亿、3期或100亿叠加；行业/国家战略豁免不可自动推定。 | 有完整资格/计算/认定依据 / 凭国企身份或单一资产规模自动认定第一类 / 行业、ROA分母或豁免证据缺失 |
| 成熟层2025优化与有效期（[NA039:PAGE001](../../sources/NA039.md#page001)） | issuer_tier, registration_mode, registration_notice, notice_effective_date, transition_evidence | 2025优化分层标准；统一注册成熟层挂网1工作日，统一注册第一类通知书有效期3年。 三年不扩至第二类、非统一注册或自动改写存量通知；2025落款9/12和网页9/15分开。 | 新第一类统一注册通知明确期限 / 第二类或旧通知无依据被自动加一年 / 在途/存量通知衔接尚无明确证据 |
| 基础层PDFI及总额度（[NA023:PAGE001](../../sources/NA023.md#page001)） | issuer_tier, registration_mode, registered_amount, covered_instruments, resolution_amounts, remaining_registrations | PDFI是基础层有额度统一注册，通知书两年；总额度明确而无需细分工具额度，本期工具/规模/期限自主确定。 不是成熟层可不设额度机制；2027年前多份决议过渡仍受总额和工具权限约束。 | PDFI总额度和决议支持一致 / PDFI省略总额度或套三年有效期 / 目标仅DFI但层级/通知类型不明 |
| 分产品注册触发及历史衔接（[NA022:PAGE001](../../sources/NA022.md#page001)） | default_events_36m, controller_events, shareholder_subsidiary_defaults, disciplinary_events, registration_history | 原第四类并第三类，取消注册12月后事前备案；债务违约、违法/处分等触发第五项时按分产品注册。 必须有主体范围和36个月查询证据；未查到不是不存在。旧注册通知及专项条款不凭空变化。 | 全范围有证据，注册路径与通知一致 / 控股子公司违约被遗漏仍判统一注册可用 / 公开信息未接入或查询不完整 |
| PDFI在途/决议过渡与60工作日（[NA023:PAGE002](../../sources/NA023.md#page002)） | application_date, registration_progress, resolutions, system_effective_notice, review_clock | 在途原则继续单品种，确需可撤回重报PDFI；2027前允许相应多份决议/说明。60工作日包含预评与反馈、重新累计和挂起条件。 60工作日功能上线时间另行通知，不能用2026-03-23无条件触发系统逾期。 | 在途重报与撤回、决议说明都有记录 / 把60工作日当固定审批承诺或无证据已到期 / 系统上线通知及挂起记录缺失 |
| 注册匡算与发行用途分层（[NA022:PAGE001](../../sources/NA022.md#page001)） | document_stage, funds_use_categories, funds_use_items, policy_sensitive_use, change_procedure | 基础层有额度统一注册原则按大类匡算，发行补合规/使用安排；政策敏感用途仍披露明细；超出匡算范围走条款变更。 SCP仍不得用于长期投资；专项用途不能靠普通统一注册免除。 | 注册大类与发行明细可对应 / 把注册阶段简化变为发行无用途 / 用途超出原范围缺变更依据 |
| 季度更新及发行披露时点（[NA022:PAGE001](../../sources/NA022.md#page001)） | first_interbank_issuance, latest_quarter, issuance_date, publication_date, business_calendar | 新季度报表披露后首次面向机构投资者发行应全面更新；其他按现行。首次发行文件至少提前2工作日，非首次1工作日。 “首次面向市场”不等于某注册项下首期；成熟层挂网与基础层披露时钟不混用。 | 首次发行补新季报并保留日期依据 / 把历史已有发行人每次首期都判首次 / 首次身份或季度报表状态未知 |
| 主承销商团与变更（[NA022:PAGE002](../../sources/NA022.md#page002)） | registration_syndicate, issuance_underwriters, appointment_evidence, current_syndicate_rule | 2026通知明确注册/发行主承销商团按中市协发〔2025〕146号执行，不能硬编码2023/2020旧家数。 本批缺146号完整正文及配套核验；家数/变更自动判断标未覆盖，允许保留实际材料待确认。 | 实际聘任/协议对应且缺口明示 / 用旧2/3/4家阈值直接判违规 / 146号正文未取得或名单变更未证实 |

## 章节字段

- **dfi-arrangement 统一注册与本期实际工具分开**：issuer_tier, registration_arrangement, document_stage, covered_instruments, issuance_instrument
- **dfi-tier 成熟层资格与第一/二类区分**：tier_evidence, industry_evidence, audited_financials, issuance_history, credit_and_compliance_events
- **dfi-mature-2025 成熟层2025优化与有效期**：issuer_tier, registration_mode, registration_notice, notice_effective_date, transition_evidence
- **dfi-basic-2026 基础层PDFI及总额度**：issuer_tier, registration_mode, registered_amount, covered_instruments, resolution_amounts, remaining_registrations
- **dfi-basic-exceptions 分产品注册触发及历史衔接**：default_events_36m, controller_events, shareholder_subsidiary_defaults, disciplinary_events, registration_history
- **dfi-transition PDFI在途/决议过渡与60工作日**：application_date, registration_progress, resolutions, system_effective_notice, review_clock
- **dfi-funds 注册匡算与发行用途分层**：document_stage, funds_use_categories, funds_use_items, policy_sensitive_use, change_procedure
- **dfi-refresh 季度更新及发行披露时点**：first_interbank_issuance, latest_quarter, issuance_date, publication_date, business_calendar
- **dfi-syndicate 主承销商团与变更**：registration_syndicate, issuance_underwriters, appointment_evidence, current_syndicate_rule
