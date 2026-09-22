export const REVIEW_DIMENSIONS=[
  {id:'financial',title:'财务数据核对',description:'对照审计报告、财务报表及附注，检查金额、期间、单位、财务指标和勾稽关系。',deliverable:'定位差异，并列出材料出处'},
  {id:'compliance',title:'合规与格式检查',description:'结合发行市场和适用规则，核对必需披露、发行条款、章节结构，以及 Word 中可识别的字体、字号和格式。',deliverable:'说明规则依据及待补充披露'},
  {id:'public',title:'公开信息核验',description:'检索公开公告、工商股权、诉讼处罚和信用等信息，与募集书中的相关陈述交叉核对。',deliverable:'附查询来源、时间与覆盖说明'}
];
export const FINANCIAL_ROLES=['audit','financial','interimFinancial','notes','accountDetails'];
export const reviewSearchQueries=(issuer,scope='')=>[
  `${issuer} 官方公告 重大事项 股权变更`,
  `${issuer} 工商 股东 实际控制人 企业信用信息公示`,
  `${issuer} 诉讼 行政处罚 失信 信用中国`,
  `${issuer} 债券 信息披露 违约 兑付 ${scope.startsWith('szse')?'深圳证券交易所':scope.startsWith('nafmii')?'交易商协会':'上海证券交易所'}`
];
