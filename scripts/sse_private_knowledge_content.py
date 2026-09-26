"""#20 authoring decisions; documentary research, not professional approval.

References use archived official attachment paragraph indices / physical PDF pages.
The common authoring source and the other five scope drafts stay unchanged.
"""

VERSION = '2026.09.26-draft.2'
PREVIOUS_VERSION = '2026.09.25-draft.1'
EVIDENCE_VERSION = '2026.09.26-evidence.1'
AUTHORED_AT = '2026-09-26T04:46:22Z'

# key -> chapters, official reference pairs, limitation specific to this rule.
A = 'sse-application-2023'
L = 'sse-private-listing-2023'
F = 'sse-focus-2025'
P = 'sse-proceeds-2026'
D = 'sse-disclosure-2023'
T = 'sse-trustee-2025'
O = 'sse-officer-2025'
M = 'csrc-measures-2023'
R = 'sse-protection-2021'
V = 'sse-mature-2026'

MAPPINGS = {
 'source-authority': (['front','issuer','financial'], [(A,'P00093'),(D,'P00024')], '逐字段证据优先级为内部方法；官方来源没有规定一个适用于全部事实的文件排名。'),
 'period-window': (['front','issuer','financial'], [(A,'P00440'),(A,'P00443'),(A,'P00453'),(A,'P00183'),(A,'P00186')], '8.1.4是财务材料两年及一期要求，不自动缩短业务、评级、重组等独立回溯期间；年末、成立不足两年及豁免按证据判断。'),
 'evidence-state': (['front','issuer','financial'], [(D,'P00024')], '用户陈述、OCR置信度与待确认标记是产品事实状态；不能因有用户输入就声明审计或公开核验通过。'),
 'identity': (['front','issuer','financial'], [(A,'P00093'),(A,'P00094'),(A,'P00200')], '实体、合并/母公司、币种、单位、期间逐项绑定；地方国有企业不能据名称自动认定城建类。'),
 'private-investors': (['front','terms'], [(M,'PAGE011'),(M,'PAGE012'),(L,'P00011'),(L,'P00025')], '200人分别检查发行及同次债券转让后持有人；机构适当性分类、穿透或例外仍需投资者适当性完整规则。'),
 'financial-validity-sse': (['financial','reference'], [(A,'P00445'),(A,'P00446'),(A,'P00447'),(A,'P00452')], '有效期截止日后新申报应更新材料；在审封卷延期不是自动宽限，须申请和交易所同意。缺申报日/批准证据不能判通过。'),
 'current-terms': (['front','terms','institutions','declarations'], [(L,'P00022'),(L,'P00038'),(L,'P00018')], '挂牌条件确认不能写成证监会公募注册。发行批文、规模、期限、机构变化均需本期依据；不推定全部条款不变。'),
 'funds-use-evidence': (['funds'], [(P,'P00009'),(P,'P00010'),(P,'P00011'),(P,'P00014'),(P,'P00018')], '用途可组合；生产性支出概括约定是有条件安排，不向所有项目自动套用。基金/股权/工程资料缺失逐项标记。'),
 'private-use-change': (['funds','holders','trustee'], [(A,'P00458'),(A,'P00459'),(P,'P00028'),(P,'P00029'),(P,'P00030'),(P,'P00031'),(P,'P00032'),(P,'P00033')], '3.2中公募跨用途类别的会议要求不直接变成所有私募要求；私募仍受8.4.1的未约定/重大影响和3.1限定偿债限制。'),
 'funds-simulation': (['funds','financial'], [(P,'P00035'),(P,'P00036'),(P,'P00037'),(P,'P00038'),(P,'P00039'),(P,'P00040'),(P,'P00041')], '发行后模拟公式是待验收内部方法。前次资金用途整改记录、台账和专户凭证缺失，不伪造已整改/合规意见。'),
 'issuer-governance': (['issuer','declarations'], [(A,'P00171'),(A,'P00175'),(A,'P00177'),(A,'P00178'),(A,'P00179'),(A,'P00186'),(A,'P00187')], '重大重组按引用的现行重组规则判断，单一50%启发式不作为已确认事实；公司法任职/监事安排仍须当期核验。'),
 'business-revenue': (['issuer','financial','risk'], [(A,'P00181'),(A,'P00182'),(A,'P00183'),(A,'P00184')], '一般10%以上主要板块是披露要求；后台前三合并主营业务收入匹配不替代全文披露。并列、分类变动和非可比期间须保留。'),
 'audit-opinion': (['financial','front','risk'], [(A,'P00198'),(A,'P00443')], '非标事项说明应来自有权机构/会计师。中期未经审计不可写成审计通过；缺意见页仍可生成标记缺口的工作稿。'),
 'financial-statements': (['financial'], [(A,'P00196'),(A,'P00199'),(A,'P00200'),(A,'P00202'),(A,'P00443')], '私募财务窗口适用8.1.4；重述、备考和合并范围变化分别保留。不能为勾平报表改写源数。'),
 'indicators': (['financial','front'], [(A,'P00200'),(A,'P00201')], '3.7.2第二段为面向普通投资者公募附加表，不作为私募强制清单。私募仍披露适用指标，定义取本期条款/专业口径。'),
 'mdna-thresholds': (['financial'], [(A,'P00203'),(A,'P00204')], '10%以上/30%以上保留原文字义；低于阈值不豁免重大事项，零/负基数不机械使用百分比。'),
 'cause-evidence': (['issuer','financial','risk'], [(A,'P00203'),(D,'P00024')], '计算差额不证明业务原因；原专家稿的推测仅作为待确认问题。'),
 'debt-liquidity': (['financial','credit','risk'], [(A,'P00205'),(A,'P00217'),(A,'P00218'),(A,'P00219')], '全口径债务与报表差异要解释；授信总/已用/剩余额度按实际证据时点，不从余额差自动推断银行承诺。'),
 'related-contingent': (['issuer','financial','risk'], [(A,'P00206'),(A,'P00207'),(A,'P00208')], '关联方、或有事项和受限资产需材料及签署日后续事项核验；未检索到不能写为不存在。'),
 'rating-enhancement': (['front','credit','enhancement','risk'], [(A,'P00210'),(A,'P00212'),(A,'P00222'),(A,'P00225'),(A,'P00231')], '无评级不是自动缺合规条件；有评级/增信以本期报告及合同为准，不添加担保人承诺。'),
 'protection': (['protection','default','holders','trustee','enhancement'], [(R,'NOTICE'),(L,'P00127'),(L,'P00128'),(L,'P00143'),(L,'P00144'),(L,'P00145'),(L,'P00146'),(L,'P00147'),(L,'P00148'),(A,'P00462')], '参考文本可以参照，不等于每个示例条款均为强制或已约定。增信、会议、违约和受托协议逐项一致；证券业协会配套规则仍待核验。'),
 'risk-disclosure': (['risk','front'], [(A,'P00089'),(A,'P00090'),(A,'P00109'),(D,'P00028')], '财务和已发生事项更新后回写；金额正确仍不能证明风险措辞充分，不自动删除历史有效风险。'),
 'sse-focus-2025': (['issuer','funds','financial','risk'], [(F,'P00030'),(F,'P00052'),(F,'P00095'),(F,'P00096'),(F,'P00097'),(F,'P00098'),(F,'P00099'),(F,'P00100'),(F,'P00101')], '城建/房地产/集团等触发后需专门审核。2025重点关注规则仍不能替代2026优化审核包或把审慎论证一律变为禁发。'),
 'special-overlays-sse': (['front','terms','funds','protection'], [], '专项品种2026原件已有，但本切片不完成其官方效力及专业验收；不得按普通私募包自动放行专项债。'),
 'document-delivery': (['front','tax','disclosure','reference','declarations'], [(A,'P00089'),(A,'P00096'),(A,'P00440'),(A,'P00441'),(A,'P00442')], '16节是专家工作骨架，不是唯一法定目录/字体标准。税务依据、签章要求、真实Word修订/批注及WPS均另验。'),
 'private-negative-list': (['terms','issuer','financial'], [(A,'P00455'),(A,'P00456')], '没有财务指标限制不等于没有准入/负面清单/偿债风险要求；证券业协会负面清单现行全文尚未核验。'),
 'idle-proceeds-2026': (['funds','protection'], [(P,'P00023'),(P,'P00024'),(P,'P00025'),(P,'P00026')], '受限定偿债等情形原则上不得约定临时补流；不得把2026条款倒写为过去已签订的合同事实。'),
 'continuing-disclosure': (['disclosure','reference'], [(A,'P00461'),(D,'P00009'),(D,'P00023')], '此处为募集说明书中的披露安排；不宣称已完成存续期所有披露事项的自动监管。'),
 'disclosure-officer-2026': (['disclosure','issuer','declarations'], [(O,'P00007'),(O,'P00008'),(O,'P00009'),(O,'P00010'),(O,'P00011'),(O,'P00016'),(O,'P00017'),(O,'P00018')], '2025-12-26发布，2026-05-01生效。任职资格及履职承诺必须实际取得；不适用于上市公司可转债。'),
 'optimized-review-version': (['terms','reference','funds'], [(V,'P00010'),(V,'P00054')], '2026-09-04起旧2023版废止；本包不实现知名成熟资格认定、简明披露或豁免，需独立审核新版本。'),
 'trustee-continuing-duties': (['trustee','holders','protection'], [(T,'P00005'),(T,'P00007'),(T,'P00012'),(T,'P00013'),(L,'P00128')], '2025指南包括鼓励措施和示范案例，不把示范案例写为发行人已履行事项；全量履职核验另作存续期覆盖。'),
}

OVERRIDES = {
 'period-window': '上交所申请文件指引8.1.4：非公开发行需最近两年财务报告和审计报告及最近一期财务报告或报表。按用户确认的目标财务期间更新，不自动追加第三年度；财务两年窗口不覆盖3.6.7业务模式、3.6.9重组等独立回溯要求。历史事件日、财务截止日、签署日和法规适用日分别保存。',
 'financial-validity-sse': '上交所8.2.1以最近一期截止日起6个月为财务有效期；到期后新申报须使用最新一期。到期日起20日内可封卷的在审项目可申请至多1个月延期，封卷时提交，交易所未同意须补报并同步更新。未知申报阶段/日期或延期批准时列待确认；不能以缺口策略伪装已满足申报要求。',
 'current-terms': '核对本期决议、挂牌条件确认意见、发行条款、多品种和机构。私募不复制公募证监会注册措辞；同品种也不默认批文、规模、利率或机构不变。未知处保留历史有效基线并准确标记待人工确认。',
 'private-use-change': '私募用途按约定及上交所8.4.1执行，披露内部决策权限、程序、风控并与会议规则/受托协议一致。无事先约定或调整可能重大影响持有人权益须履行相应会议程序。2026募集资金指南3.1限定偿债不得转为非限定偿债；3.2公募跨用途类别的额外会议情形不直接推广到所有私募。',
 'protection': '按私募挂牌规则4.2/4.3核对受托职责、会议权利/召集/表决/决议落实；投资者权益保护参考文本仅供结合实际参照，不能强塞所有示例承诺。募集书、受托协议、会议规则及增信协议不得冲突；未知本期条款标记待确认，不新增是否设置保护条款的用户问卷。',
}

# Extra candidates use the existing #19 RuleDefinition schema; no new runtime checker.
EXTRA_RULES = [
 ('private-negative-list','私募准入与公募财务门槛隔离',['negative_list_evidence','parallel_applications','unused_quota'],
  '8.3.1非公开发行不设财务指标限制，但实行负面清单管理；8.3.2核对其他交易场所申请及前次未募足情形。不得因平均可分配利润不足公募门槛自动拒绝私募，也不得写成无条件可发行。',
  ['有负面清单核查及本期方案，准确披露私募准入。','把公募利润覆盖利息或250亿元净资产门槛强加私募。','尚无负面清单现行版本，结论待补证而非默认通过。']),
 ('idle-proceeds-2026','闲置募集资金临时补流边界',['funds_use','proceeds_restrictions','temporary_use_terms','payment_schedule'],
  '按2026指南2.1—2.3核对是否允许约定临时补流，以及使用期限、回收机制和决策程序。未明确约定不得临时补流；回收不晚于12个月与原用途付款节点的孰早日。区分补流的最终用途与临时挪用闲置募集资金。',
  ['有实际约定且按两期限孰早安排回收。','无临时补流条款却写可以补流12个月。','集中偿付压力/限定偿债用途等情形尚未核实。']),
 ('continuing-disclosure','私募定期披露安排',['annual_disclosure_schedule','interim_disclosure_schedule'],
  '按8.4.3在募集书约定年后4个月内披露上年度经审计财务报告，上半年结束后2个月内披露中期报告；同步核对持续信息披露规则和本期安排。',
  ['年度与中期安排分别完整。','删除中期披露安排或把年度期限写为6个月。','特殊豁免仅有口头说法，须依据确认。']),
 ('disclosure-officer-2026','信息披露负责人及联络人',['as_of','disclosure_officer','disclosure_contact','appointment_evidence','signed_commitment'],
  '自2026-05-01起按负责人履职指引第2—6条核对适用性、负责人及联络人姓名职务联系方式、任职资格和签署承诺。负责人未变更无需重复签署但需既有有效承诺证据，不由模型代签。',
  ['适用日后有任职及承诺来源，信息完整。','把2025-12-26当生效日，或自动生成已签承诺事实。','财务截止日是2025年但发行日为2026年，按法规适用日判断。']),
 ('optimized-review-version','优化审核新旧版本边界',['as_of','optimized_review_request','eligibility_evidence'],
  '上证发〔2026〕96号自2026-09-04施行并废止2023版。当前普通私募包不确认知名成熟资格，不因旧资料EX009存在就套用简化、额度或豁免；触发后补充独立规则与审核。',
  ['当前项目明确未使用优化审核，按普通路径处理。','2026-09-04后仍用旧2023版直接确认优化资格。','未确认是否适用优化审核，保留待判断，不猜普通身份。']),
 ('trustee-continuing-duties','受托协议与持续履职衔接',['trust_agreement','trustee_duties','monitoring_evidence'],
  '参照2025受托管理指南与私募挂牌规则，核对协议职责、信用监测及信息收集安排。示范案例、鼓励措施和实际已实施程序分开，不把生成的安排冒充已经履职。',
  ['协议约定与披露一致，已履职内容有记录。','只因指南列了案例就写已开展主动信用管理。','缺少受托协议或实际监测记录时分别提示材料缺口。']),
]
