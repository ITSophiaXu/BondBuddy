// Design B reference: http://127.0.0.1:4321/#project, reviewed 2026-10-19.
// This is a UI catalog, not a declaration of server generation capabilities.
export const FOLDERS = [
  { id: '1', name: '投标文件及立项申请文件' },
  { id: '2', name: '申报、发行备案文件' },
  { id: '2.2', name: '其他申报、发行备案文件', parent: '2' },
  { id: '3', name: '受托管理材料' },
  { id: '4', name: '底稿文件' },
  { id: '4.1', name: '说明性文件', parent: '4' },
  { id: '4.2', name: '核查记录 / 已导入底稿', parent: '4' },
  { id: '4.3', name: '诚信核查', parent: '4' },
  { id: 'sources', name: '原始资料' },
] as const;
export type FolderId = typeof FOLDERS[number]['id'];
export type DocumentType = { id: string; name: string; code: string; folder: FolderId; hint: string; kind: 'generation' | 'integrity' };
export const DOCUMENTS: DocumentType[] = [
  { id: 'initiation', name: '立项报告', code: '1.1', folder: '1', hint: '选用本公司立项模板，补充尽调与立项依据', kind: 'generation' },
  { id: 'opinion', name: '主承销商核查意见', code: '2.2.1', folder: '2.2', hint: '从募集书整理，补充承销商核查依据', kind: 'generation' },
  { id: 'legal', name: '法律意见书', code: '2.2.2', folder: '2.2', hint: '补充律师核查依据，结论待专业确认', kind: 'generation' },
  { id: 'application', name: '挂牌 / 发行申请书', code: '2.2.3', folder: '2.2', hint: '提取发行主体、发行安排与申请事项', kind: 'generation' },
  { id: 'recommendation', name: '推荐函', code: '2.2.4', folder: '2.2', hint: '整理发行概况、推荐依据及待落实事项', kind: 'generation' },
  { id: 'summary', name: '募集说明书摘要', code: '2.2.5', folder: '2.2', hint: '基于所选募集书版本准备内容摘要', kind: 'generation' },
  { id: 'annual', name: '年度报告', code: '3.1', folder: '3', hint: '补充年度财务报告、附注与履职资料', kind: 'generation' },
  { id: 'semiannual', name: '半年度报告', code: '3.2', folder: '3', hint: '补充半年度财务报告、附注与履职资料', kind: 'generation' },
  { id: 'issuer', name: '发行人基本情况说明', code: '1-1-1', folder: '4.1', hint: '整理发行人概况、股权及主营业务', kind: 'generation' },
  { id: 'financial', name: '主要财务情况说明', code: '2-1-1', folder: '4.1', hint: '整理报告期财务数据与主要指标', kind: 'generation' },
  { id: 'credit', name: '授信情况说明', code: '3-1-3', folder: '4.1', hint: '整理授信额度、已用额度与可用额度', kind: 'generation' },
  { id: 'proceeds', name: '募集资金使用情况说明', code: '4.1', folder: '4.1', hint: '整理募集资金用途及使用安排', kind: 'generation' },
  { id: 'company-integrity', name: '发行人诚信信息汇总清单及查询记录', code: '3-1-1', folder: '4.3', hint: '从诚信核查入口准备企业查询记录', kind: 'integrity' },
  { id: 'people-integrity', name: '董事及高级管理人员诚信信息汇总清单及查询记录', code: '1-5-3-4', folder: '4.3', hint: '从诚信核查入口准备人员查询记录', kind: 'integrity' },
];
export const GENERATABLE = DOCUMENTS.filter(d => d.kind === 'generation');
export const preparationFor = (type: string) => type === 'initiation' ? { label: '上传 / 选择模板', hint: '上传并保存本公司模板' } : type === 'legal' ? { label: '补充资料', hint: '补充律师核查依据' } : ['annual', 'semiannual'].includes(type) ? { label: '补充资料', hint: '补充本期财务报告及附注' } : { label: '准备文件', hint: '可从募集书准备' };
export const belongsTo = (folder: string, parent: string) => parent === 'all' ? folder !== 'sources' : folder === parent || folder.startsWith(parent + '.');
export const folderName = (id: string): string => FOLDERS.find(f => f.id === id)?.name ?? id;
export const folderPath = (id: string): string => {
  const folder = FOLDERS.find(f => f.id === id);
  return folder ? `${'parent' in folder ? folderPath(folder.parent) + ' / ' : ''}${folder.id === 'sources' ? '' : folder.id + ' '}${folder.name}` : id;
};
