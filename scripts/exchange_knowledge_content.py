"""Curated authoring content. References are original DOCX paragraph/PDF page anchors.

This is research input to build_exchange_knowledge.py, not a checker implementation.
Do not turn these candidates into enabled rules without the #19 release workflow.
"""

RULES = []


def rule(key, title, location, logic, refs, inputs, *, markets=('sse', 'szse'),
         offerings=('private', 'public', 'public_all'), trigger='适用章节或项目事实触发',
         exception='普通公司债基础包；特殊主体、专项品种及过渡项目另行判断。',
         examples=None):
    RULES.append(dict(key=key, title=title, location=location, logic=logic,
                      refs=refs, inputs=inputs, markets=markets, offerings=offerings,
                      trigger=trigger, exception=exception,
                      examples=examples or [
                          '同主体、同口径证据完整且披露与来源一致。',
                          '已有相反的原始证据，但披露仍沿用历史内容。',
                          '来源缺失、冲突或适用性不明，只能列待补证/待判断。']))


rule('source-authority', '逐字段来源与冲突处理', '全文',
     '年度财务依据对应审计原件，中期依据对应报表与附注；工商依据官方登记/章程，发行条款依据本期决议和协议，评级依据评级报告。保留相互冲突的值、版本、时点和来源，不用“最新文件优先”或统一文件排名覆盖所有事实。',
     [('EX038', 'P00082'), ('EX017', 'P00151')], ['field_type', 'source_versions', 'evidence_anchors'])
rule('period-window', '目标报告期及滚动窗口', '释义、业务、财务、重大事项',
     '识别历史与目标期间集合并由项目输入确认；公募通常最近三年及一期，私募通常最近两年及一期。年末项目、成立不足年限、豁免或简明披露单独判断。滚动替换全套业务/财务/风险引用，不无限追加年份。历史事件日、报表日和签署日分别处理。深交所私募两年口径目前依据参考文本和专家稿，须在正式规则复核时确认。',
     [('EX017', 'P00209'), ('EX017', 'P00210'), ('EX001', 'P00443'), ('EX038', 'P00617')],
     ['historical_periods', 'target_periods', 'statement_dates', 'document_stage'],
     examples=['同私募目标滚动一年，仍保留两年及所需中期窗口。', '仅改年份却保留旧数，或公募只提交两年资料。', '新设主体或特殊报表豁免需依据确认，不机械报缺三年。'])
rule('evidence-state', '空值、用户陈述与待确认信息', '全文、右侧项目对话',
     '自然语言中的授信、资金用途等可形成用户陈述，保留消息版本及确认状态；不因用户输入就变成已核验事实。空白、零、破折号、未披露不同义；缺数不填零、未知原因不编造，不把历史“无重大事项”当作当期证据。',
     [('EX017', 'P00845'), ('EX038', 'P00622'), ('EX038', 'P00647')], ['user_assertions', 'fact_status', 'source_evidence'])
rule('identity', '发行主体、口径与单位一致', '全文、合并/母公司报表',
     '每个事实绑定发行主体、合并或母公司、期间、币种、单位和原件版本；子公司、担保人及参考发行人不得混入本企业。换算金额后计算比例，保留负号和舍入误差；引用其他发行人仅作结构参考。',
     [('EX038', 'P00617'), ('EX038', 'P00621'), ('EX038', 'P00595')], ['entity', 'consolidation_scope', 'currency', 'unit', 'period'])
rule('private-investors', '私募发行对象与人数限制', '封面、重大事项、发行概况、认购承诺',
     '按所供《管理办法》第34/38条，非公开发行面向专业投资者，不得广告、公开劝诱或变相公开，每次发行对象不超过200人；转让后持有同次债券的投资者合计不超过200人。核对适当性安排和本期发行文件，不以模板声明替代发行对象事实。',
     [('EX035', 'PAGE011'), ('EX035', 'PAGE012')], ['investor_scope', 'investor_count', 'distribution_arrangement'], offerings=('private',))
rule('public-eligibility', '公募共同发行条件及禁发情形', '发行概况、财务、信用、重大事项',
     '依所供《管理办法》第14/15条核对健全且运行良好的组织机构、近三年平均可分配利润足以支付一年利息、合理资产负债结构和正常现金流量；存续违约/延迟偿付或违规改变公募资金用途等须核查。不得仅凭债券名称和公募选项认定条件已满足。',
     [('EX035', 'PAGE004'), ('EX035', 'PAGE005')], ['distributable_profit_3y', 'annual_bond_interest', 'organization', 'cash_flow', 'default_records'], offerings=('public', 'public_all'))
rule('professional-public', '小公募的专业投资者适用性', '封面、条款、发行对象',
     '小公募为公开发行中面向专业投资者的路径，适用公开发行共同条件和三年财务要求；不将大公募第16条附加门槛套成所有小公募的条件，也不误套私募200人规则。发行及交易适当性安排需一致。',
     [('EX035', 'PAGE005'), ('EX035', 'PAGE011')], ['offering', 'investor_scope', 'trading_arrangement'], offerings=('public',))
rule('retail-public', '大公募普通投资者附加条件', '重大事项、发行概况、财务、信用',
     '所供2023年《管理办法》第16条：近三年无债务违约/迟延本息，近三年平均可分配利润不低于债券一年利息1.5倍，最近一期末净资产不低于250亿元，最近36个月内累计公开发行债券不少于3期且规模不少于100亿元，以及证监会其他条件。逐项取证并核验当期有效版本；不得把这些门槛沿用成未经时点核验的自动结论。',
     [('EX035', 'PAGE005')], ['default_records_3y', 'distributable_profit_3y', 'annual_bond_interest', 'latest_net_assets', 'public_issues_36m'], offerings=('public_all',),
     examples=['所供规则条件逐项有证据且现行效力已确认后方可判断。', '小公募数据未经附加资格核对就生成面向普通投资者声明。', '36个月边界、利润/利息口径或250亿元门槛不明时人工复核。'])
rule('retail-metrics-sse', '上交所大公募补充指标表', '财务会计信息',
     '按3.7.2，另列近两年扣非净利润、EBITDA全部债务比、利息保障倍数、现金利息保障倍数、EBITDA利息保障倍数、贷款偿还率、利息偿付率等。近两年附加表不替代三年财务披露；资本化利息等缺失列待补，不以财务费用净额替代利息。',
     [('EX001', 'P00201')], ['retail_indicator_table', 'interest_components', 'cash_interest', 'debt_service'], markets=('sse',), offerings=('public_all',))
rule('retail-metrics-szse', '深交所大公募补充指标表', '第五节财务会计信息',
     '按所供申请文件指引面向普通投资者的附加披露要求，列示近两年扣非净利润、EBITDA全部债务比、利息保障倍数、现金利息保障倍数、EBITDA利息保障倍数、贷款偿还率和利息偿付率；使用深交所口径和当期来源，缺失输入待补证。不能用“同小公募”替代本检查。',
     [('EX026', 'P00178'), ('EX038', 'P00636')], ['retail_indicator_table', 'interest_components', 'cash_interest', 'debt_service'], markets=('szse',), offerings=('public_all',))
rule('financial-validity-sse', '上交所财务有效期', '财务、申报材料',
     '区分财务报表最近一期截止日起六个月的有效期与特定延期申请。私募按第8章的申请材料及在审项目延期规定另判，不能把最多一个月的申请空间当自动延期。',
     [('EX001', 'P00195'), ('EX001', 'P00446')], ['latest_cutoff', 'submission_date', 'extension_approval'], markets=('sse',))
rule('financial-validity-szse', '深交所财务有效期', '第五节财务会计信息、申报材料',
     '按所供指引，财务报表年度末/半年度末/季度末截止，最近一期截止后六个月有效；特别情况申请延长不超过一个月，另有规定及境外上市协调豁免须按实际适用依据判断，不能自动延长。',
     [('EX026', 'P00059'), ('EX026', 'P00072')], ['latest_cutoff', 'submission_date', 'extension_approval'], markets=('szse',))
rule('public-document-validity', '注册决定与募集书签署有效期分开', '封面、发行概况',
     '所供《管理办法》第25条的公募注册决定两年有效、募集说明书最后签署日起六个月有效，分别核验；这两个时钟均不能替代财务报表截止日的有效期检查。',
     [('EX035', 'PAGE007')], ['registration_date', 'registration_expiry', 'last_signature_date', 'issue_date'], offerings=('public', 'public_all'))
rule('current-terms', '本期条款、多品种及机构联动', '封面、重大事项、发行概况、机构、声明',
     '从本期决议/批文或无异议函、方案和协议取规模、分品种额度、期限/选择权、利率、回拨、担保、评级、日期及机构。条款未知保留待补；单承销商不强制联席，多承销商按实际分工。更换受托人同步全文联系方式/地址/协议和签章主体，不能只替换名称。',
     [('EX038', 'P00471'), ('EX038', 'P00475'), ('EX017', 'P00173')], ['issue_plan', 'approvals', 'tranches', 'institutions'])
rule('funds-use-evidence', '组合资金用途与配套材料', '募集资金运用',
     '逐用途拆金额和依据：借新还旧/偿债需债务明细及到期安排；补流需经营需求；项目建设需可研、立项/备案、土地、环评、规划等及取得情况；股权投资/收购需标的、协议/估值；基金出资需设立/运营/退出与合规文件。合计口径与扣费后可用募集资金一致。缺许可披露原因影响，不虚构已取得。',
     [('EX026', 'P00125'), ('EX026', 'P00133'), ('EX026', 'P00129'), ('EX038', 'P00512')], ['funds_use_items', 'net_proceeds', 'project_files', 'debt_schedule', 'investment_documents'])
rule('public-use-change', '公募资金用途限制与变更程序', '募集资金、持有人会议、受托管理',
     '所供《管理办法》第13条：公募资金按披露用途使用，不得弥补亏损和非生产性支出，改变用途须债券持有人会议决议；同时核对内部程序、披露、项目限制及本期协议。',
     [('EX035', 'PAGE004'), ('EX026', 'P00145')], ['funds_use', 'change_procedure', 'holder_meeting_rules'], offerings=('public', 'public_all'))
rule('private-use-change', '私募资金用途与约定变更程序', '募集资金、持有人会议、受托管理',
     '私募改变用途按募集说明书约定程序，须符合法律及市场业务规则；核对内部权限、决策程序、风控及披露，与持有人会议规则/受托协议一致。不能写成“私募可随意改变用途”，也不能把公募程序无差别强加。',
     [('EX035', 'PAGE004'), ('EX001', 'P00458'), ('EX038', 'P00539')], ['funds_use', 'internal_authorities', 'change_procedure', 'trust_agreement'], offerings=('private',))
rule('funds-simulation', '发行后模拟及前次资金使用', '募集资金、财务',
     '发行后模拟使用最新财务基准、本期净额和真实用途，记录公式假设，偿债与补流不能同样加资产负债。前次债券逐只更新实际使用、余额、专户及变更程序，历史文字不能证明最新使用进度。',
     [('EX038', 'P00546'), ('EX038', 'P00554')], ['baseline_balance_sheet', 'net_proceeds', 'funds_use', 'previous_use_ledger'])
rule('issuer-governance', '主体、控制链、董监高与重组', '发行人基本情况、声明、重大事项',
     '核对工商/章程、实缴与注册资本、股权穿透、主要子公司、任职和签章名单。由报表附注识别重组线索并索取必要材料，不要求用户先回答重大资产重组问卷；没有线索不等于确认未发生。历史沿革日期不滚动，期后变动单列。',
     [('EX038', 'P00559'), ('EX038', 'P00565'), ('EX038', 'P00566'), ('EX026', 'P00174')], ['registry', 'articles', 'appointments', 'consolidation_notes', 'restructuring_documents'])
rule('business-revenue', '业务板块与收入成本毛利', '发行人主要业务、财务、风险',
     '按审计附注和最近一期明细更新全部可比板块收入、成本、毛利润及毛利率；分类变化建映射并解释，不能混合年度/母公司/分层合计。上交所3.6.7、深交所相关规定要求对收入或毛利润占比10%以上板块等披露运营信息；后台匹配前三营收业务不是法定披露范围的上限。',
     [('EX001', 'P00181'), ('EX026', 'P00162'), ('EX038', 'P00596')], ['segment_revenue', 'segment_cost', 'business_taxonomy', 'reporting_periods'])
rule('audit-opinion', '审计意见及非标补充说明', '财务基础、重大事项、风险',
     '逐年度核对机构、报告号、意见、审计范围和基准；带强调事项段无保留意见不等于保留意见。不推定中期已经审计。存在相关非标事项时保留有权机构说明、会计师补充意见及偿债影响判断，不能由语言模型代签专业意见。',
     [('EX026', 'P00172'), ('EX038', 'P00608'), ('EX038', 'P00611')], ['audit_reports', 'audit_opinions', 'supplementary_opinions'])
rule('financial-statements', '合并及母公司六张表与重述', '财务会计信息',
     '更新资产负债表、利润表、现金流量表的全部适用期间和科目，合并/母公司分开，原始定位保留。期初与上年期末差异查重述或重分类，不自动勾平；重大重组备考报表及合并范围变化单列。OCR低置信数字需确认，不能成为已证实数值。',
     [('EX026', 'P00177'), ('EX038', 'P00618'), ('EX038', 'P00619'), ('EX038', 'P00623')], ['statements', 'notes', 'restatements', 'pro_forma', 'ocr_confidence'])
rule('indicators', '财务指标定义、重算与缺项', '财务指标、摘要、重大事项',
     '记录公式、期间、单位和每个输入来源；流动比率/速动比率/资产负债率与报表勾稽。EBITDA、全部债务和利息按适用模板定义，财务费用净额不是利息支出，缺资本化利息/折旧摊销不能填零。分母为零和负基数变动交给明确口径判断。',
     [('EX017', 'P00775'), ('EX017', 'P00779'), ('EX038', 'P00632'), ('EX038', 'P00634')], ['formulas', 'statement_facts', 'interest', 'depreciation_amortization'])
rule('mdna-thresholds', '资产负债项目构成和变动分析', '管理层讨论与分析',
     '按所供沪深申请文件指引，对最近一年及最近一期末占总资产10%以上的资产项目、占总负债10%以上的负债项目及变化幅度30%以上的项目核对分析。上交所3.7.3要求分析变动及原因，深交所分别要求构成和变动分析。原文“以上/超过”逐条保留，边界及零/负基数复核；它们是有具体来源的披露触发，不能笼统降为专家建议，也不是低于阈值即可免披露。',
     [('EX001', 'P00203'), ('EX026', 'P00179'), ('EX026', 'P00180')], ['balance_sheet', 'changes', 'materiality_context'],
     examples=['占比和变动阈值命中后，披露构成及有来源的原因。', '命中30%变动却沿用旧原因且来源已相反。', '恰在10%或30%边界时回到该市场原文字义判断。'])
rule('cause-evidence', '变动原因不能仅凭勾稽推断', '业务、财务、风险',
     '区分计算结果与业务原因。勾稽可以说明金额变化，但不能证明交易或管理决策原因；采用审计附注、管理层说明等，推测仅作为待确认问题。上交所专家稿允许先填原因再提示复核的文字，不提升为自动证实。',
     [('EX017', 'P00782'), ('EX038', 'P00647')], ['computed_changes', 'notes', 'management_explanation'])
rule('debt-liquidity', '全口径有息债务与集中偿付', '财务、资信、风险',
     '债務类型、期限、信用/担保结构逐项与台账和报表勾稽，差异解释；应付债券不能代替存续债券清单，短期借款也不是全部短债。授信区分总额、已用和可用，注明时点及用户陈述/核验状态；非标成本、回售和集中到期关联偿债来源。',
     [('EX026', 'P00181'), ('EX026', 'P00194'), ('EX038', 'P00649')], ['interest_bearing_debt', 'bond_register', 'credit_facilities', 'maturities'])
rule('related-contingent', '关联交易、担保、诉讼与受限资产', '发行人、财务、重大事项、风险',
     '按附注和专项台账核对关系、金额、期限及口径。担保余额/总资产与担保余额/净资产是不同指标；不混用市场要求的分母。受限资产核对账面值、原因、顺位及影响；报告期后至签署日的重大事项补充披露，未搜索到不表示不存在。',
     [('EX026', 'P00183'), ('EX026', 'P00186'), ('EX026', 'P00190'), ('EX038', 'P00659')], ['related_parties', 'guarantees', 'litigation', 'restricted_assets', 'subsequent_events'])
rule('rating-enhancement', '评级与增信分支', '封面、资信、增信、风险、条款',
     '区分无评级、仅主体评级和主体/债项评级；从本期有效评级报告核对结论、含义、风险和跟踪安排。担保、抵质押、差额补足或流动性支持按实际合同区分，不混称保证担保；担保人、担保范围、期限、履行机制与风险跨章节一致。',
     [('EX026', 'P00191'), ('EX026', 'P00195'), ('EX026', 'P00215'), ('EX038', 'P00669')], ['rating_reports', 'enhancement_contracts', 'guarantor_financials'])
rule('protection', '投资者保护与协议一致性', '投资者保护、违约、持有人会议、受托管理',
     '逐项核对持有人会议、触发事件、救济/豁免、生效和受托职责与本期协议；从条款和资料识别，不向用户增加“是否设置保护条款”问卷。深交所专家稿明确尚需取得第2号投资者权益保护参考文本，不能用上交所文本直接替代。',
     [('EX001', 'P00462'), ('EX038', 'P00960')], ['holder_meeting_rules', 'trust_agreement', 'covenants'],
     exception='深交所投资者权益保护参考文本未在本批材料内，具体保护条款仍为未覆盖。')
rule('risk-disclosure', '风险、重大事项与全文回写', '风险提示、重大事项、全文',
     '先完成财务/资信/主体/募资事实更新，再生成风险与重大事项；能定量应定量，已经发生损失不能写成仅可能发生。历史风险删除需证据，应对措施区分已采取与拟采取；封面、条款、正文及摘要一致。',
     [('EX038', 'P00117'), ('EX038', 'P00465'), ('EX038', 'P00467')], ['updated_facts', 'risk_events', 'mitigation_evidence'])
rule('sse-focus-2025', '上交所2025审核重点增量', '治理、财务、特定发行人、募资',
     '以2025稿逐项核对非经营性占款、对外担保、资金归集、私募余额/净资产40%与偿旧原则、财务及现金流压力、城建/房地产/集团事项。保留每一条的口径、原则性表述及优化审核例外；不能只导入旧2023文本，也不能将信息披露关注点一律改成拒绝发行。',
     [('EX006', 'P00030'), ('EX006', 'P00052'), ('EX006', 'P00095'), ('EX006', 'P00100')], ['nonoperating_receivables', 'guarantees', 'private_debt_balance', 'issuer_type', 'focus_checklist'], markets=('sse',))
rule('szse-focus-2025', '深交所2025审核重点增量', '治理、财务、特定发行人、募资',
     '深交所审核重点2025稿覆盖组织治理、财务、特定发行人与用途及承销核查；按原条文独立建立触发条件，不复制上交所条号/阈值。修订说明用于了解变更，不能替代规则正文。对城建类识别政府性应收、公益性资产、地方债务与偿债约束。',
     [('EX027', 'PAGE003'), ('EX027', 'PAGE015'), ('EX022', 'PAGE001')], ['issuer_type', 'financial_risk_facts', 'funds_use', 'focus_checklist'], markets=('szse',))
rule('special-overlays-sse', '上交所2026专项品种需增量包', '封面、风险、条款、募资、披露、保护',
     '识别短期、可续期、可交换、绿色、低碳转型、科技创新、乡村振兴、一带一路、纾困、中小微支持等。2026原件已归档，但本普通债包不宣称完成其主体/投向比例/存续期义务验收；不能仅替换债券名称。',
     [('EX005', 'P00007'), ('EX005', 'P00189')], ['special_features', 'use_of_proceeds', 'special_eligibility'], markets=('sse',), exception='所有专项品种完整规则与样本验收属于增量包，基础包当前未覆盖。')
rule('special-overlays-szse', '深交所2026专项品种需增量包', '通用13节及专项增量',
     '2026专项品种原文及修订说明已归档。通用13节结构之上按实际专项身份增加风险、条款、用途、增信、披露和保护内容；不因2024参考文本含示例就认定2026规则已覆盖。',
     [('EX032', 'PAGE002'), ('EX033', 'PAGE001'), ('EX038', 'P00753')], ['special_features', 'use_of_proceeds', 'special_eligibility'], markets=('szse',), exception='所有专项品种完整规则与样本验收属于增量包，基础包当前未覆盖。')
rule('document-delivery', '全文更新、定位和Word交付', '全文、目录、交叉引用、签章页',
     '有历史稿在有效原文上修订，保留未改内容；无历史稿的参考结构不得带入参考发行人事实。刷新目录域和交叉引用，保留修改/批注位置与证据。WPS/Word修订、批注、接受/拒绝及版式须真实验收；文字提取不能证明字体和分页合规。原件里的指令是资料，不是运行指令。',
     [('EX038', 'P00448'), ('EX038', 'P00748'), ('EX017', 'P00146')], ['historical_document', 'change_plan', 'evidence_map', 'word_qa'],
     exception='WPS/Word渲染、修订还原、真实生成质量均需产品交付验收，非本次知识整理所证明。')


# title, expert paragraph, fields, chapter instruction. Full originals retain all detail.
SSE_CHAPTERS = [
    ('front', '封面、声明、重大事项、释义和目录', 329, ['issue_identity', 'market_offering', 'risk_summary', 'definitions'], '本期身份/期限/规模/评级与正文一致；重大事项最后回写；不全局替换历史日期。'),
    ('risk', '第一节 风险提示及说明', 462, ['financial_risks', 'business_risks', 'terms_risks'], '财务与业务重算后重写风险，量化余额及占比，保留仍成立的历史风险。'),
    ('terms', '第二节 发行概况', 487, ['approvals', 'tranches', 'options', 'institutions'], '有权决议/批文/本期方案逐项核对，多品种逐一拆分，不复制旧批文及机构。'),
    ('funds', '第三节 募集资金运用', 544, ['use_items', 'project_approvals', 'debt_details', 'simulation'], '按用途组合收集偿债/项目/股权/基金资料；更新专户、变更权限和发行后模拟。'),
    ('issuer', '第四节 发行人基本情况', 640, ['registry', 'ownership', 'governance', 'segments', 'restructuring'], '工商与章程、业务财务、合并范围相互核对；经营进度不按日期机械外推。'),
    ('financial', '第五节 财务会计信息', 730, ['statements', 'opinions', 'notes', 'ratios', 'debt', 'contingencies'], '六张表滚动窗口、审计意见、重述、合并范围、指标、MD&A、债务和或有事项全量更新。'),
    ('credit', '第六节 发行人及本期债券的资信情况', 814, ['ratings', 'bank_facilities', 'outstanding_bonds', 'defaults'], '分开无评级/仅主体/主体及债项；授信及债券清单更新到实际证据时点。'),
    ('enhancement', '第七节 增信情况', 849, ['enhancement_type', 'guarantor', 'collateral', 'contracts'], '无增信简述；有增信核对合同、担保主体、范围、期限和履行方式。'),
    ('tax', '第八节 税项', 890, ['tax_basis', 'tax_risk'], '核对当期有效税务依据，不沿用未经核查的税率或个税结论。'),
    ('disclosure', '第九节 信息披露安排', 893, ['disclosure_officer', 'periodic_reports', 'material_events'], '核对现行持续披露规则、本期负责人、定期/临时/兑付安排及专项义务。'),
    ('protection', '第十节 投资者保护机制', 896, ['covenants', 'triggers', 'remedies'], '与本期持有人规则/受托协议共同核对保护条款、触发及救济。'),
    ('default', '第十一节 违约事项及纠纷解决机制', 901, ['default_events', 'liability', 'dispute_resolution'], '违约事件、责任、纠纷解决依本期协议，不凭生成器添加承诺。'),
    ('holders', '第十二节 债券持有人会议规则', 904, ['meeting_rules', 'voting', 'change_process'], '取得当前签署/拟签署文本，核对召开、表决、约束力和用途调整程序。'),
    ('trustee', '第十三节 受托管理人', 907, ['trustee_agreement', 'rights', 'duties', 'contacts'], '更换受托人时连同职责、地址、电话及关联引用全部更新。'),
    ('institutions', '第十四节 本次发行有关机构', 914, ['institutions', 'contacts', 'interests'], '按本期机构名单及利害关系确认更新，只有一家主承销商时不造联席。'),
    ('declarations', '第十五节 发行人及中介机构声明', 926, ['signatories', 'statement_types', 'signature_dates'], '按当期任职和适用声明类型匹配签章，不自动签字或推定同意。'),
    ('reference', '第十六节 备查文件', 929, ['reference_files', 'inspection_location', 'contacts'], '列真实已备文件、查阅地点与联系方式；目录/引用同步。'),
]

SZSE_CHAPTERS = [
    ('front', '封面、声明、重大事项、释义和目录', 117, ['issue_identity', 'risk_summary', 'definitions'], '按深交所参考文本前置部分处理；重大事项与13节对应，区分上市/挂牌。'),
    ('risk', '第一节 风险提示及说明', 451, ['financial_risks', 'business_risks', 'terms_risks'], '以本期事实重写风险，量化影响，不无依据删除旧风险；已发生损失明确披露。'),
    ('terms', '第二节 发行概况', 468, ['approvals', 'tranches', 'options', 'institutions'], '公募注册文件/私募无异议函按实际区分，更新各品种和认购承诺。'),
    ('funds', '第三节 募集资金运用', 491, ['use_items', 'project_approvals', 'debt_details', 'simulation'], '用途逐项落实金额与资料；临时补流、现金管理需适用性核验，不能任意套用。'),
    ('issuer', '第四节 发行人基本情况', 557, ['registry', 'ownership', 'investments', 'governance', 'segments'], '控制链、权益投资、董监高、业务板块、重大重组及处罚事实按本期来源更新。'),
    ('financial', '第五节 财务会计信息', 605, ['statements', 'opinions', 'ratios', 'debt', 'related_parties', 'contingencies'], '按实际报表建立科目映射，分别处理财务基础、合并范围、六张表、指标、分析及专项事项。'),
    ('credit', '第六节 发行人及本次债券的资信状况', 665, ['ratings', 'bank_facilities', 'outstanding_bonds', 'defaults'], '授信、评级差异、存量和未发行额度分别更新，公开查询无命中不证明无风险。'),
    ('enhancement', '第七节 增信机制', 682, ['enhancement_type', 'guarantor', 'collateral', 'contracts'], '按第2号投资者权益保护参考文本及合同补齐具体安排；本批缺该参考文本，列未覆盖。'),
    ('tax', '第八节 税项', 692, ['tax_basis', 'tax_risk'], '更新适用税收依据及风险提示，禁止未经核验承诺税负。'),
    ('disclosure', '第九节 信息披露安排', 694, ['disclosure_officer', 'periodic_reports', 'material_events'], '按公开/非公开、本期主体及专项品种安排定期、临时和存续期披露。'),
    ('protection', '第十节 投资者保护机制', 708, ['covenants', 'default_events', 'meetings', 'trust_agreement'], '深交所把保护、违约、会议及受托相关安排集中衔接，不能强拆成上交所第11至13节。'),
    ('institutions', '第十一节 本次债券发行的有关机构及利害关系', 718, ['institutions', 'contacts', 'interests'], '按本期机构和人员更新联系方式，并取得利害关系确认依据。'),
    ('declarations', '第十二节 发行人、主承销商、证券服务机构及相关人员声明', 736, ['signatories', 'statement_types', 'signature_dates'], '名单与第四节及任职文件一致；异议/无法保证等声明按实际适用，不自动签章。'),
    ('reference', '第十三节 备查文件', 744, ['reference_files', 'inspection_location', 'contacts'], '目录、文件真实性、查阅地址和电话与第11节一致。'),
]
