/** Latest project file design, 35da7b8c. IDs also identify a document's version family. */
export const PROJECT_DOCUMENT_CATALOG = [
  {id:'init', name:'立项报告', code:'1.1', folder:'1', hint:'根据本公司模板整理发行概况、尽调和立项依据'},
  {id:'underwriter', name:'主承销商核查意见', code:'2.2.1', folder:'2.2', hint:'关联发行人、财务与发行安排，补充承销商核查依据'},
  {id:'legal', name:'法律意见书', code:'2.2.2', folder:'2.2', hint:'关联主体与发行安排，缺少律师核查依据的结论标注待确认'},
  {id:'application', name:'挂牌 / 发行申请书', code:'2.2.3', folder:'2.2', hint:'关联发行主体、发行规模、期限与申请事项'},
  {id:'recommendation', name:'推荐函', code:'2.2.4', folder:'2.2', hint:'关联发行概况和推荐依据'},
  {id:'private_summary', name:'募集说明书摘要', code:'2.2.5', folder:'2.2', hint:'依据所选募集说明书版本编制摘要'},
  {id:'annual', name:'年度报告', code:'3.1', folder:'3', hint:'关联财务期间与数据，补充年度报告、附注和履职资料'},
  {id:'semiannual', name:'半年度报告', code:'3.2', folder:'3', hint:'关联财务期间与数据，补充半年度报告、附注和履职资料'},
  {id:'issuer', name:'发行人基本情况说明', code:'1-1-1', folder:'4.1', hint:'关联发行人概况、股权结构及主营业务'},
  {id:'financial', name:'主要财务情况说明', code:'2-1-1', folder:'4.1', hint:'关联同期间、同口径的财务数据和主要指标'},
  {id:'credit', name:'授信情况说明', code:'3-1-3', folder:'4.1', hint:'关联授信银行、额度、已用额度与可用额度'},
  {id:'proceeds', name:'募集资金使用情况说明', code:'4.1', folder:'4.1', hint:'关联募集资金用途、分配金额和使用安排'},
] as const;
export type ProjectDocumentType = typeof PROJECT_DOCUMENT_CATALOG[number]['id'];
export const PROJECT_DOCUMENT_FOLDERS = [
  {id:'1',name:'投标文件及立项申请文件'},
  {id:'2',name:'申报、发行备案文件'},
  {id:'2.2',name:'其他申报、发行备案文件',parent:'2'},
  {id:'3',name:'受托管理材料'},
  {id:'4',name:'底稿文件'},
  {id:'4.1',name:'说明性文件',parent:'4'},
  {id:'4.2',name:'核查记录 / 已导入底稿',parent:'4'},
  {id:'4.3',name:'诚信核查',parent:'4'},
  {id:'sources',name:'原始资料'},
] as const;
