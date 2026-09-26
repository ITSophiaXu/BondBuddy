# 上交所 · 普通私募公司债

版本：2026.09.26-draft.3 · 对应 [Issue #20](https://github.com/ITSophiaXu/BondBuddy/issues/20)

状态：知识研究草稿，尚未发布。章节骨架及方法可供开发；当前不构成合规通过或上线验收。

## 逐章节更新与复核

先处理财务/资信，再处理主体/募资/条款与风险，最后回写前置部分及全文一致性。T=按当期适用文本，H=核验后保留历史，U=更新事实，C=本期文件，J=专业判断。

### 封面、声明、重大事项、释义和目录

本期身份/期限/规模/评级与正文一致；重大事项最后回写；不全局替换历史日期。

字段/材料：`issue_identity`, `market_offering`, `risk_summary`, `definitions`。来源：[专家稿 P00329](../../sources/EX017.md#p00329)。

### 第一节 风险提示及说明

财务与业务重算后重写风险，量化余额及占比，保留仍成立的历史风险。

字段/材料：`financial_risks`, `business_risks`, `terms_risks`。来源：[专家稿 P00462](../../sources/EX017.md#p00462)。

### 第二节 发行概况

有权决议/批文/本期方案逐项核对，多品种逐一拆分，不复制旧批文及机构。

字段/材料：`approvals`, `tranches`, `options`, `institutions`。来源：[专家稿 P00487](../../sources/EX017.md#p00487)。

### 第三节 募集资金运用

按用途组合收集偿债/项目/股权/基金资料；更新专户、变更权限和发行后模拟。

字段/材料：`use_items`, `project_approvals`, `debt_details`, `simulation`。来源：[专家稿 P00544](../../sources/EX017.md#p00544)。

### 第四节 发行人基本情况

工商与章程、业务财务、合并范围相互核对；经营进度不按日期机械外推。

字段/材料：`registry`, `ownership`, `governance`, `segments`, `restructuring`。来源：[专家稿 P00640](../../sources/EX017.md#p00640)。

### 第五节 财务会计信息

六张表滚动窗口、审计意见、重述、合并范围、指标、MD&A、债务和或有事项全量更新。

字段/材料：`statements`, `opinions`, `notes`, `ratios`, `debt`, `contingencies`。来源：[专家稿 P00730](../../sources/EX017.md#p00730)。

### 第六节 发行人及本期债券的资信情况

分开无评级/仅主体/主体及债项；授信及债券清单更新到实际证据时点。

字段/材料：`ratings`, `bank_facilities`, `outstanding_bonds`, `defaults`。来源：[专家稿 P00814](../../sources/EX017.md#p00814)。

### 第七节 增信情况

无增信简述；有增信核对合同、担保主体、范围、期限和履行方式。

字段/材料：`enhancement_type`, `guarantor`, `collateral`, `contracts`。来源：[专家稿 P00849](../../sources/EX017.md#p00849)。

### 第八节 税项

核对当期有效税务依据，不沿用未经核查的税率或个税结论。

字段/材料：`tax_basis`, `tax_risk`。来源：[专家稿 P00890](../../sources/EX017.md#p00890)。

### 第九节 信息披露安排

核对现行持续披露规则、本期负责人、定期/临时/兑付安排及专项义务。

字段/材料：`disclosure_officer`, `periodic_reports`, `material_events`。来源：[专家稿 P00893](../../sources/EX017.md#p00893)。

### 第十节 投资者保护机制

与本期持有人规则/受托协议共同核对保护条款、触发及救济。

字段/材料：`covenants`, `triggers`, `remedies`。来源：[专家稿 P00896](../../sources/EX017.md#p00896)。

### 第十一节 违约事项及纠纷解决机制

违约事件、责任、纠纷解决依本期协议，不凭生成器添加承诺。

字段/材料：`default_events`, `liability`, `dispute_resolution`。来源：[专家稿 P00901](../../sources/EX017.md#p00901)。

### 第十二节 债券持有人会议规则

取得当前签署/拟签署文本，核对召开、表决、约束力和用途调整程序。

字段/材料：`meeting_rules`, `voting`, `change_process`。来源：[专家稿 P00904](../../sources/EX017.md#p00904)。

### 第十三节 受托管理人

更换受托人时连同职责、地址、电话及关联引用全部更新。

字段/材料：`trustee_agreement`, `rights`, `duties`, `contacts`。来源：[专家稿 P00907](../../sources/EX017.md#p00907)。

### 第十四节 本次发行有关机构

按本期机构名单及利害关系确认更新，只有一家主承销商时不造联席。

字段/材料：`institutions`, `contacts`, `interests`。来源：[专家稿 P00914](../../sources/EX017.md#p00914)。

### 第十五节 发行人及中介机构声明

按当期任职和适用声明类型匹配签章，不自动签字或推定同意。

字段/材料：`signatories`, `statement_types`, `signature_dates`。来源：[专家稿 P00926](../../sources/EX017.md#p00926)。

### 第十六节 备查文件

列真实已备文件、查阅地点与联系方式；目录/引用同步。

字段/材料：`reference_files`, `inspection_location`, `contacts`。来源：[专家稿 P00929](../../sources/EX017.md#p00929)。

## 本范围规则与边界

## 2026-09-26 官方取证与增量映射

本目录版本已更新为 **2026.09.26-draft.3**；以上通用章节说明保留作为基线。以下规则及机器包为本次私募范围的增量，以此处对旧草稿的明确修正为准。

[官方证据登记与局限](../../verification/2026-09-26/README.md) · [逐规则/章节映射](rule-evidence-map.json) · [适用性与真实样本验收](ACCEPTANCE.md)

### 逐字段来源与冲突处理

年度财务依据对应审计原件，中期依据对应报表与附注；工商依据官方登记/章程，发行条款依据本期决议和协议，评级依据评级报告。保留相互冲突的值、版本、时点和来源，不用“最新文件优先”或统一文件排名覆盖所有事实。

未覆盖/例外：逐字段证据优先级为内部方法；官方来源没有规定一个适用于全部事实的文件排名。

输入：field_type、source_versions、evidence_anchors。

- [sse-application-2023 / P00093](../../verification/2026-09-26/sources/sse-application-2023.md#p00093)；发布 2023-10-20，生效 2023-10-20。
- [sse-disclosure-2023 / P00024](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00024)；发布 2023-10-20，生效 2023-10-20。

### 目标报告期及滚动窗口

上交所申请文件指引8.1.4：非公开发行需最近两年财务报告和审计报告及最近一期财务报告或报表。按用户确认的目标财务期间更新，不自动追加第三年度；财务两年窗口不覆盖3.6.7业务模式、3.6.9重组等独立回溯要求。历史事件日、财务截止日、签署日和法规适用日分别保存。

未覆盖/例外：8.1.4是财务材料两年及一期要求，不自动缩短业务、评级、重组等独立回溯期间；年末、成立不足两年及豁免按证据判断。

输入：historical_periods、target_periods、statement_dates、document_stage。

- [sse-application-2023 / P00440](../../verification/2026-09-26/sources/sse-application-2023.md#p00440)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00443](../../verification/2026-09-26/sources/sse-application-2023.md#p00443)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00453](../../verification/2026-09-26/sources/sse-application-2023.md#p00453)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00183](../../verification/2026-09-26/sources/sse-application-2023.md#p00183)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00186](../../verification/2026-09-26/sources/sse-application-2023.md#p00186)；发布 2023-10-20，生效 2023-10-20。

### 空值、用户陈述与待确认信息

自然语言中的授信、资金用途等可形成用户陈述，保留消息版本及确认状态；不因用户输入就变成已核验事实。空白、零、破折号、未披露不同义；缺数不填零、未知原因不编造，不把历史“无重大事项”当作当期证据。

未覆盖/例外：用户陈述、OCR置信度与待确认标记是产品事实状态；不能因有用户输入就声明审计或公开核验通过。

输入：user_assertions、fact_status、source_evidence。

- [sse-disclosure-2023 / P00024](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00024)；发布 2023-10-20，生效 2023-10-20。

### 发行主体、口径与单位一致

每个事实绑定发行主体、合并或母公司、期间、币种、单位和原件版本；子公司、担保人及参考发行人不得混入本企业。换算金额后计算比例，保留负号和舍入误差；引用其他发行人仅作结构参考。

未覆盖/例外：实体、合并/母公司、币种、单位、期间逐项绑定；地方国有企业不能据名称自动认定城建类。

输入：entity、consolidation_scope、currency、unit、period。

- [sse-application-2023 / P00093](../../verification/2026-09-26/sources/sse-application-2023.md#p00093)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00094](../../verification/2026-09-26/sources/sse-application-2023.md#p00094)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00200](../../verification/2026-09-26/sources/sse-application-2023.md#p00200)；发布 2023-10-20，生效 2023-10-20。

### 私募发行对象与人数限制

按所供《管理办法》第34/38条，非公开发行面向专业投资者，不得广告、公开劝诱或变相公开，每次发行对象不超过200人；转让后持有同次债券的投资者合计不超过200人。核对适当性安排和本期发行文件，不以模板声明替代发行对象事实。

未覆盖/例外：200人分别检查发行及同次债券转让后持有人；机构适当性分类、穿透或例外仍需投资者适当性完整规则。

输入：investor_scope、investor_count、distribution_arrangement。

- [csrc-measures-2023 / PAGE011](../../verification/2026-09-26/sources/csrc-measures-2023.md#page011)；发布 2023-10-20，生效 2023-10-20。
- [csrc-measures-2023 / PAGE012](../../verification/2026-09-26/sources/csrc-measures-2023.md#page012)；发布 2023-10-20，生效 2023-10-20。
- [sse-private-listing-2023 / P00011](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00011)；发布 2023-10-20，生效 2023-10-20。
- [sse-private-listing-2023 / P00025](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00025)；发布 2023-10-20，生效 2023-10-20。

### 上交所财务有效期

上交所8.2.1以最近一期截止日起6个月为财务有效期；到期后新申报须使用最新一期。到期日起20日内可封卷的在审项目可申请至多1个月延期，封卷时提交，交易所未同意须补报并同步更新。未知申报阶段/日期或延期批准时列待确认；不能以缺口策略伪装已满足申报要求。

未覆盖/例外：有效期截止日后新申报应更新材料；在审封卷延期不是自动宽限，须申请和交易所同意。缺申报日/批准证据不能判通过。

输入：latest_cutoff、submission_date、extension_approval。

- [sse-application-2023 / P00445](../../verification/2026-09-26/sources/sse-application-2023.md#p00445)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00446](../../verification/2026-09-26/sources/sse-application-2023.md#p00446)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00447](../../verification/2026-09-26/sources/sse-application-2023.md#p00447)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00452](../../verification/2026-09-26/sources/sse-application-2023.md#p00452)；发布 2023-10-20，生效 2023-10-20。

### 本期条款、多品种及机构联动

核对本期决议、挂牌条件确认意见、发行条款、多品种和机构。私募不复制公募证监会注册措辞；同品种也不默认批文、规模、利率或机构不变。未知处保留历史有效基线并准确标记待人工确认。

未覆盖/例外：挂牌条件确认不能写成证监会公募注册。发行批文、规模、期限、机构变化均需本期依据；不推定全部条款不变。

输入：issue_plan、approvals、tranches、institutions。

- [sse-private-listing-2023 / P00022](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00022)；发布 2023-10-20，生效 2023-10-20。
- [sse-private-listing-2023 / P00038](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00038)；发布 2023-10-20，生效 2023-10-20。
- [sse-private-listing-2023 / P00018](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00018)；发布 2023-10-20，生效 2023-10-20。

### 组合资金用途与配套材料

逐用途拆金额和依据：借新还旧/偿债需债务明细及到期安排；补流需经营需求；项目建设需可研、立项/备案、土地、环评、规划等及取得情况；股权投资/收购需标的、协议/估值；基金出资需设立/运营/退出与合规文件。合计口径与扣费后可用募集资金一致。缺许可披露原因影响，不虚构已取得。

未覆盖/例外：用途可组合；生产性支出概括约定是有条件安排，不向所有项目自动套用。基金/股权/工程资料缺失逐项标记。

输入：funds_use_items、net_proceeds、project_files、debt_schedule、investment_documents。

- [sse-proceeds-2026 / P00009](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00009)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00010](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00010)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00011](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00011)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00014](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00014)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00018](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00018)；发布 2026-02-27，生效 2026-02-27。

### 私募资金用途与约定变更程序

私募用途按约定及上交所8.4.1执行，披露内部决策权限、程序、风控并与会议规则/受托协议一致。无事先约定或调整可能重大影响持有人权益须履行相应会议程序。2026募集资金指南3.1限定偿债不得转为非限定偿债；3.2公募跨用途类别的额外会议情形不直接推广到所有私募。

未覆盖/例外：3.2中公募跨用途类别的会议要求不直接变成所有私募要求；私募仍受8.4.1的未约定/重大影响和3.1限定偿债限制。

输入：funds_use、internal_authorities、change_procedure、trust_agreement。

- [sse-application-2023 / P00458](../../verification/2026-09-26/sources/sse-application-2023.md#p00458)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00459](../../verification/2026-09-26/sources/sse-application-2023.md#p00459)；发布 2023-10-20，生效 2023-10-20。
- [sse-proceeds-2026 / P00028](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00028)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00029](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00029)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00030](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00030)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00031](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00031)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00032](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00032)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00033](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00033)；发布 2026-02-27，生效 2026-02-27。

### 发行后模拟及前次资金使用

发行后模拟使用最新财务基准、本期净额和真实用途，记录公式假设，偿债与补流不能同样加资产负债。前次债券逐只更新实际使用、余额、专户及变更程序，历史文字不能证明最新使用进度。

未覆盖/例外：发行后模拟公式是待验收内部方法。前次资金用途整改记录、台账和专户凭证缺失，不伪造已整改/合规意见。

输入：baseline_balance_sheet、net_proceeds、funds_use、previous_use_ledger。

- [sse-proceeds-2026 / P00035](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00035)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00036](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00036)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00037](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00037)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00038](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00038)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00039](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00039)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00040](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00040)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00041](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00041)；发布 2026-02-27，生效 2026-02-27。

### 主体、控制链、董监高与重组

核对工商/章程、实缴与注册资本、股权穿透、主要子公司、任职和签章名单。由报表附注识别重组线索并索取必要材料，不要求用户先回答重大资产重组问卷；没有线索不等于确认未发生。历史沿革日期不滚动，期后变动单列。

未覆盖/例外：重大重组按引用的现行重组规则判断，单一50%启发式不作为已确认事实；公司法任职/监事安排仍须当期核验。

输入：registry、articles、appointments、consolidation_notes、restructuring_documents。

- [sse-application-2023 / P00186](../../verification/2026-09-26/sources/sse-application-2023.md#p00186)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00171](../../verification/2026-09-26/sources/sse-application-2023.md#p00171)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00175](../../verification/2026-09-26/sources/sse-application-2023.md#p00175)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00177](../../verification/2026-09-26/sources/sse-application-2023.md#p00177)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00178](../../verification/2026-09-26/sources/sse-application-2023.md#p00178)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00179](../../verification/2026-09-26/sources/sse-application-2023.md#p00179)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00187](../../verification/2026-09-26/sources/sse-application-2023.md#p00187)；发布 2023-10-20，生效 2023-10-20。

### 业务板块与收入成本毛利

按审计附注和最近一期明细更新全部可比板块收入、成本、毛利润及毛利率；分类变化建映射并解释，不能混合年度/母公司/分层合计。上交所3.6.7、深交所相关规定要求对收入或毛利润占比10%以上板块等披露运营信息；后台匹配前三营收业务不是法定披露范围的上限。

未覆盖/例外：一般10%以上主要板块是披露要求；后台前三合并主营业务收入匹配不替代全文披露。并列、分类变动和非可比期间须保留。

输入：segment_revenue、segment_cost、business_taxonomy、reporting_periods。

- [sse-application-2023 / P00183](../../verification/2026-09-26/sources/sse-application-2023.md#p00183)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00181](../../verification/2026-09-26/sources/sse-application-2023.md#p00181)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00182](../../verification/2026-09-26/sources/sse-application-2023.md#p00182)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00184](../../verification/2026-09-26/sources/sse-application-2023.md#p00184)；发布 2023-10-20，生效 2023-10-20。

### 审计意见及非标补充说明

逐年度核对机构、报告号、意见、审计范围和基准；带强调事项段无保留意见不等于保留意见。不推定中期已经审计。存在相关非标事项时保留有权机构说明、会计师补充意见及偿债影响判断，不能由语言模型代签专业意见。

未覆盖/例外：非标事项说明应来自有权机构/会计师。中期未经审计不可写成审计通过；缺意见页仍可生成标记缺口的工作稿。

输入：audit_reports、audit_opinions、supplementary_opinions。

- [sse-application-2023 / P00443](../../verification/2026-09-26/sources/sse-application-2023.md#p00443)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00198](../../verification/2026-09-26/sources/sse-application-2023.md#p00198)；发布 2023-10-20，生效 2023-10-20。

### 合并及母公司六张表与重述

更新资产负债表、利润表、现金流量表的全部适用期间和科目，合并/母公司分开，原始定位保留。期初与上年期末差异查重述或重分类，不自动勾平；重大重组备考报表及合并范围变化单列。OCR低置信数字需确认，不能成为已证实数值。

未覆盖/例外：私募财务窗口适用8.1.4；重述、备考和合并范围变化分别保留。不能为勾平报表改写源数。

输入：statements、notes、restatements、pro_forma、ocr_confidence。

- [sse-application-2023 / P00443](../../verification/2026-09-26/sources/sse-application-2023.md#p00443)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00200](../../verification/2026-09-26/sources/sse-application-2023.md#p00200)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00196](../../verification/2026-09-26/sources/sse-application-2023.md#p00196)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00199](../../verification/2026-09-26/sources/sse-application-2023.md#p00199)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00202](../../verification/2026-09-26/sources/sse-application-2023.md#p00202)；发布 2023-10-20，生效 2023-10-20。

### 财务指标定义、重算与缺项

记录公式、期间、单位和每个输入来源；流动比率/速动比率/资产负债率与报表勾稽。EBITDA、全部债务和利息按适用模板定义，财务费用净额不是利息支出，缺资本化利息/折旧摊销不能填零。分母为零和负基数变动交给明确口径判断。

未覆盖/例外：3.7.2第二段为面向普通投资者公募附加表，不作为私募强制清单。私募仍披露适用指标，定义取本期条款/专业口径。

输入：formulas、statement_facts、interest、depreciation_amortization。

- [sse-application-2023 / P00200](../../verification/2026-09-26/sources/sse-application-2023.md#p00200)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00201](../../verification/2026-09-26/sources/sse-application-2023.md#p00201)；发布 2023-10-20，生效 2023-10-20。

### 资产负债项目构成和变动分析

按所供沪深申请文件指引，对最近一年及最近一期末占总资产10%以上的资产项目、占总负债10%以上的负债项目及变化幅度30%以上的项目核对分析。上交所3.7.3要求分析变动及原因，深交所分别要求构成和变动分析。原文“以上/超过”逐条保留，边界及零/负基数复核；它们是有具体来源的披露触发，不能笼统降为专家建议，也不是低于阈值即可免披露。

未覆盖/例外：10%以上/30%以上保留原文字义；低于阈值不豁免重大事项，零/负基数不机械使用百分比。

输入：balance_sheet、changes、materiality_context。

- [sse-application-2023 / P00203](../../verification/2026-09-26/sources/sse-application-2023.md#p00203)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00204](../../verification/2026-09-26/sources/sse-application-2023.md#p00204)；发布 2023-10-20，生效 2023-10-20。

### 变动原因不能仅凭勾稽推断

区分计算结果与业务原因。勾稽可以说明金额变化，但不能证明交易或管理决策原因；采用审计附注、管理层说明等，推测仅作为待确认问题。上交所专家稿允许先填原因再提示复核的文字，不提升为自动证实。

未覆盖/例外：计算差额不证明业务原因；原专家稿的推测仅作为待确认问题。

输入：computed_changes、notes、management_explanation。

- [sse-disclosure-2023 / P00024](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00024)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00203](../../verification/2026-09-26/sources/sse-application-2023.md#p00203)；发布 2023-10-20，生效 2023-10-20。

### 全口径有息债务与集中偿付

债務类型、期限、信用/担保结构逐项与台账和报表勾稽，差异解释；应付债券不能代替存续债券清单，短期借款也不是全部短债。授信区分总额、已用和可用，注明时点及用户陈述/核验状态；非标成本、回售和集中到期关联偿债来源。

未覆盖/例外：全口径债务与报表差异要解释；授信总/已用/剩余额度按实际证据时点，不从余额差自动推断银行承诺。

输入：interest_bearing_debt、bond_register、credit_facilities、maturities。

- [sse-application-2023 / P00205](../../verification/2026-09-26/sources/sse-application-2023.md#p00205)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00217](../../verification/2026-09-26/sources/sse-application-2023.md#p00217)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00218](../../verification/2026-09-26/sources/sse-application-2023.md#p00218)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00219](../../verification/2026-09-26/sources/sse-application-2023.md#p00219)；发布 2023-10-20，生效 2023-10-20。

### 关联交易、担保、诉讼与受限资产

按附注和专项台账核对关系、金额、期限及口径。担保余额/总资产与担保余额/净资产是不同指标；不混用市场要求的分母。受限资产核对账面值、原因、顺位及影响；报告期后至签署日的重大事项补充披露，未搜索到不表示不存在。

未覆盖/例外：关联方、或有事项和受限资产需材料及签署日后续事项核验；未检索到不能写为不存在。

输入：related_parties、guarantees、litigation、restricted_assets、subsequent_events。

- [sse-application-2023 / P00206](../../verification/2026-09-26/sources/sse-application-2023.md#p00206)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00207](../../verification/2026-09-26/sources/sse-application-2023.md#p00207)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00208](../../verification/2026-09-26/sources/sse-application-2023.md#p00208)；发布 2023-10-20，生效 2023-10-20。

### 评级与增信分支

区分无评级、仅主体评级和主体/债项评级；从本期有效评级报告核对结论、含义、风险和跟踪安排。担保、抵质押、差额补足或流动性支持按实际合同区分，不混称保证担保；担保人、担保范围、期限、履行机制与风险跨章节一致。

未覆盖/例外：无评级不是自动缺合规条件；有评级/增信以本期报告及合同为准，不添加担保人承诺。

输入：rating_reports、enhancement_contracts、guarantor_financials。

- [sse-application-2023 / P00210](../../verification/2026-09-26/sources/sse-application-2023.md#p00210)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00212](../../verification/2026-09-26/sources/sse-application-2023.md#p00212)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00222](../../verification/2026-09-26/sources/sse-application-2023.md#p00222)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00225](../../verification/2026-09-26/sources/sse-application-2023.md#p00225)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00231](../../verification/2026-09-26/sources/sse-application-2023.md#p00231)；发布 2023-10-20，生效 2023-10-20。

### 投资者保护与协议一致性

按私募挂牌规则4.2/4.3核对受托职责、会议权利/召集/表决/决议落实；投资者权益保护参考文本仅供结合实际参照，不能强塞所有示例承诺。募集书、受托协议、会议规则及增信协议不得冲突；未知本期条款标记待确认，不新增是否设置保护条款的用户问卷。

未覆盖/例外：参考文本可以参照，不等于每个示例条款均为强制或已约定。增信、会议、违约和受托协议逐项一致；证券业协会配套规则仍待核验。

输入：holder_meeting_rules、trust_agreement、covenants。

- [sse-protection-2021 / NOTICE](../../verification/2026-09-26/sources/sse-protection-2021.md#notice)；发布 2021-08-13，生效 未单列。
- [sse-private-listing-2023 / P00127](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00127)；发布 2023-10-20，生效 2023-10-20。
- [sse-private-listing-2023 / P00128](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00128)；发布 2023-10-20，生效 2023-10-20。
- [sse-private-listing-2023 / P00143](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00143)；发布 2023-10-20，生效 2023-10-20。
- [sse-private-listing-2023 / P00144](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00144)；发布 2023-10-20，生效 2023-10-20。
- [sse-private-listing-2023 / P00145](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00145)；发布 2023-10-20，生效 2023-10-20。
- [sse-private-listing-2023 / P00146](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00146)；发布 2023-10-20，生效 2023-10-20。
- [sse-private-listing-2023 / P00147](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00147)；发布 2023-10-20，生效 2023-10-20。
- [sse-private-listing-2023 / P00148](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00148)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00462](../../verification/2026-09-26/sources/sse-application-2023.md#p00462)；发布 2023-10-20，生效 2023-10-20。

### 风险、重大事项与全文回写

先完成财务/资信/主体/募资事实更新，再生成风险与重大事项；能定量应定量，已经发生损失不能写成仅可能发生。历史风险删除需证据，应对措施区分已采取与拟采取；封面、条款、正文及摘要一致。

未覆盖/例外：财务和已发生事项更新后回写；金额正确仍不能证明风险措辞充分，不自动删除历史有效风险。

输入：updated_facts、risk_events、mitigation_evidence。

- [sse-application-2023 / P00089](../../verification/2026-09-26/sources/sse-application-2023.md#p00089)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00090](../../verification/2026-09-26/sources/sse-application-2023.md#p00090)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00109](../../verification/2026-09-26/sources/sse-application-2023.md#p00109)；发布 2023-10-20，生效 2023-10-20。
- [sse-disclosure-2023 / P00028](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00028)；发布 2023-10-20，生效 2023-10-20。

### 上交所2025审核重点增量

以2025稿逐项核对非经营性占款、对外担保、资金归集、私募余额/净资产40%与偿旧原则、财务及现金流压力、城建/房地产/集团事项。保留每一条的口径、原则性表述及优化审核例外；不能只导入旧2023文本，也不能将信息披露关注点一律改成拒绝发行。

未覆盖/例外：城建/房地产/集团等触发后需专门审核。2025重点关注规则仍不能替代2026优化审核包或把审慎论证一律变为禁发。

输入：nonoperating_receivables、guarantees、private_debt_balance、issuer_type、focus_checklist。

- [sse-focus-2025 / P00030](../../verification/2026-09-26/sources/sse-focus-2025.md#p00030)；发布 2025-03-28，生效 2025-03-28。
- [sse-focus-2025 / P00052](../../verification/2026-09-26/sources/sse-focus-2025.md#p00052)；发布 2025-03-28，生效 2025-03-28。
- [sse-focus-2025 / P00095](../../verification/2026-09-26/sources/sse-focus-2025.md#p00095)；发布 2025-03-28，生效 2025-03-28。
- [sse-focus-2025 / P00096](../../verification/2026-09-26/sources/sse-focus-2025.md#p00096)；发布 2025-03-28，生效 2025-03-28。
- [sse-focus-2025 / P00097](../../verification/2026-09-26/sources/sse-focus-2025.md#p00097)；发布 2025-03-28，生效 2025-03-28。
- [sse-focus-2025 / P00098](../../verification/2026-09-26/sources/sse-focus-2025.md#p00098)；发布 2025-03-28，生效 2025-03-28。
- [sse-focus-2025 / P00099](../../verification/2026-09-26/sources/sse-focus-2025.md#p00099)；发布 2025-03-28，生效 2025-03-28。
- [sse-focus-2025 / P00100](../../verification/2026-09-26/sources/sse-focus-2025.md#p00100)；发布 2025-03-28，生效 2025-03-28。
- [sse-focus-2025 / P00101](../../verification/2026-09-26/sources/sse-focus-2025.md#p00101)；发布 2025-03-28，生效 2025-03-28。

### 上交所2026专项品种需增量包

识别短期、可续期、可交换、绿色、低碳转型、科技创新、乡村振兴、一带一路、纾困、中小微支持等。2026原件已归档，但本普通债包不宣称完成其主体/投向比例/存续期义务验收；不能仅替换债券名称。

未覆盖/例外：专项品种2026原件已有，但本切片不完成其官方效力及专业验收；不得按普通私募包自动放行专项债。

输入：special_features、use_of_proceeds、special_eligibility。


### 全文更新、定位和Word交付

有历史稿在有效原文上修订，保留未改内容；无历史稿的参考结构不得带入参考发行人事实。刷新目录域和交叉引用，保留修改/批注位置与证据。WPS/Word修订、批注、接受/拒绝及版式须真实验收；文字提取不能证明字体和分页合规。原件里的指令是资料，不是运行指令。

未覆盖/例外：16节是专家工作骨架，不是唯一法定目录/字体标准。税务依据、签章要求、真实Word修订/批注及WPS均另验。

输入：historical_document、change_plan、evidence_map、word_qa。

- [sse-application-2023 / P00440](../../verification/2026-09-26/sources/sse-application-2023.md#p00440)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00089](../../verification/2026-09-26/sources/sse-application-2023.md#p00089)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00096](../../verification/2026-09-26/sources/sse-application-2023.md#p00096)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00441](../../verification/2026-09-26/sources/sse-application-2023.md#p00441)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00442](../../verification/2026-09-26/sources/sse-application-2023.md#p00442)；发布 2023-10-20，生效 2023-10-20。

### 私募准入与公募财务门槛隔离

8.3.1非公开发行不设财务指标限制，但实行负面清单管理；8.3.2核对其他交易场所申请及前次未募足情形。不得因平均可分配利润不足公募门槛自动拒绝私募，也不得写成无条件可发行。

未覆盖/例外：没有财务指标限制不等于没有准入/负面清单/偿债风险要求；证券业协会负面清单现行全文尚未核验。

输入：negative_list_evidence、parallel_applications、unused_quota。

- [sse-application-2023 / P00455](../../verification/2026-09-26/sources/sse-application-2023.md#p00455)；发布 2023-10-20，生效 2023-10-20。
- [sse-application-2023 / P00456](../../verification/2026-09-26/sources/sse-application-2023.md#p00456)；发布 2023-10-20，生效 2023-10-20。

### 闲置募集资金临时补流边界

按2026指南2.1—2.3核对是否允许约定临时补流，以及使用期限、回收机制和决策程序。未明确约定不得临时补流；回收不晚于12个月与原用途付款节点的孰早日。区分补流的最终用途与临时挪用闲置募集资金。

未覆盖/例外：受限定偿债等情形原则上不得约定临时补流；不得把2026条款倒写为过去已签订的合同事实。

输入：funds_use、proceeds_restrictions、temporary_use_terms、payment_schedule。

- [sse-proceeds-2026 / P00023](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00023)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00024](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00024)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00025](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00025)；发布 2026-02-27，生效 2026-02-27。
- [sse-proceeds-2026 / P00026](../../verification/2026-09-26/sources/sse-proceeds-2026.md#p00026)；发布 2026-02-27，生效 2026-02-27。

### 私募定期披露安排

按8.4.3在募集书约定年后4个月内披露上年度经审计财务报告，上半年结束后2个月内披露中期报告；同步核对持续信息披露规则和本期安排。

未覆盖/例外：此处为募集说明书中的披露安排；不宣称已完成存续期所有披露事项的自动监管。

输入：annual_disclosure_schedule、interim_disclosure_schedule。

- [sse-application-2023 / P00461](../../verification/2026-09-26/sources/sse-application-2023.md#p00461)；发布 2023-10-20，生效 2023-10-20。
- [sse-disclosure-2023 / P00009](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00009)；发布 2023-10-20，生效 2023-10-20。
- [sse-disclosure-2023 / P00023](../../verification/2026-09-26/sources/sse-disclosure-2023.md#p00023)；发布 2023-10-20，生效 2023-10-20。

### 信息披露负责人及联络人

自2026-05-01起按负责人履职指引第2—6条核对适用性、负责人及联络人姓名职务联系方式、任职资格和签署承诺。负责人未变更无需重复签署但需既有有效承诺证据，不由模型代签。

未覆盖/例外：2025-12-26发布，2026-05-01生效。任职资格及履职承诺必须实际取得；不适用于上市公司可转债。

输入：as_of、disclosure_officer、disclosure_contact、appointment_evidence、signed_commitment。

- [sse-officer-2025 / P00007](../../verification/2026-09-26/sources/sse-officer-2025.md#p00007)；发布 2025-12-26，生效 2026-05-01。
- [sse-officer-2025 / P00008](../../verification/2026-09-26/sources/sse-officer-2025.md#p00008)；发布 2025-12-26，生效 2026-05-01。
- [sse-officer-2025 / P00009](../../verification/2026-09-26/sources/sse-officer-2025.md#p00009)；发布 2025-12-26，生效 2026-05-01。
- [sse-officer-2025 / P00010](../../verification/2026-09-26/sources/sse-officer-2025.md#p00010)；发布 2025-12-26，生效 2026-05-01。
- [sse-officer-2025 / P00011](../../verification/2026-09-26/sources/sse-officer-2025.md#p00011)；发布 2025-12-26，生效 2026-05-01。
- [sse-officer-2025 / P00016](../../verification/2026-09-26/sources/sse-officer-2025.md#p00016)；发布 2025-12-26，生效 2026-05-01。
- [sse-officer-2025 / P00017](../../verification/2026-09-26/sources/sse-officer-2025.md#p00017)；发布 2025-12-26，生效 2026-05-01。
- [sse-officer-2025 / P00018](../../verification/2026-09-26/sources/sse-officer-2025.md#p00018)；发布 2025-12-26，生效 2026-05-01。

### 优化审核新旧版本边界

上证发〔2026〕96号自2026-09-04施行并废止2023版。当前普通私募包不确认知名成熟资格，不因旧资料EX009存在就套用简化、额度或豁免；触发后补充独立规则与审核。

未覆盖/例外：2026-09-04起旧2023版废止；本包不实现知名成熟资格认定、简明披露或豁免，需独立审核新版本。

输入：as_of、optimized_review_request、eligibility_evidence。

- [sse-mature-2026 / P00010](../../verification/2026-09-26/sources/sse-mature-2026.md#p00010)；发布 2026-09-04，生效 2026-09-04。
- [sse-mature-2026 / P00054](../../verification/2026-09-26/sources/sse-mature-2026.md#p00054)；发布 2026-09-04，生效 2026-09-04。

### 受托协议与持续履职衔接

参照2025受托管理指南与私募挂牌规则，核对协议职责、信用监测及信息收集安排。示范案例、鼓励措施和实际已实施程序分开，不把生成的安排冒充已经履职。

未覆盖/例外：2025指南包括鼓励措施和示范案例，不把示范案例写为发行人已履行事项；全量履职核验另作存续期覆盖。

输入：trust_agreement、trustee_duties、monitoring_evidence。

- [sse-private-listing-2023 / P00128](../../verification/2026-09-26/sources/sse-private-listing-2023.md#p00128)；发布 2023-10-20，生效 2023-10-20。
- [sse-trustee-2025 / P00005](../../verification/2026-09-26/sources/sse-trustee-2025.md#p00005)；发布 2025-12-24，生效 2025-12-24。
- [sse-trustee-2025 / P00007](../../verification/2026-09-26/sources/sse-trustee-2025.md#p00007)；发布 2025-12-24，生效 2025-12-24。
- [sse-trustee-2025 / P00012](../../verification/2026-09-26/sources/sse-trustee-2025.md#p00012)；发布 2025-12-24，生效 2025-12-24。
- [sse-trustee-2025 / P00013](../../verification/2026-09-26/sources/sse-trustee-2025.md#p00013)；发布 2025-12-24，生效 2025-12-24。
## 未完成项

- 10份官方证据已登记；证监会发布机关现行核验、协会负面清单/适当性/受托与会议规则、税务及特殊主体等尚待补齐并专业签认。 所需证据：verification/2026-09-26目录逐条核验、现行配套规则及适用性签认；不得把抓取或hash一致当行业审核。
- 尚无本scope基础/复杂/边界真实结果的行业验收；本sample_suite只验证工程门禁。 所需证据：授权样本、真实更新/反例结果、逐条财务和行业审核记录。
- 依赖#19的真实授权发布/选择链路及双角色签认，草稿文件不是生产发布。 所需证据：#19发布记录、锁定版本/hash、权限/撤回/回滚及任务选择证据。
- #19适用性上下文的字段分类、证据和人工审核门槛尚需接入；无默认批准分支。 所需证据：instrument/documentStage/issuerScope/investorScope/industry/specialFeatures/asOf均有本期证据及真实审核。
