import type { M4DraftInput, M4Template } from './m4-workspace.js';
import { M4_DOCUMENT_MARKETS, M4_CASE_TEMPLATES, m4DocumentScopeSupported } from './m4-document-types.js';

/** Public, actionable input feedback shared by the form and execution gate. */
export const M4_INPUT_ISSUES = {
  M4_MARKET_REQUIRED: { field: 'market', message: '尚未选择交易所，请选择上海证券交易所或深圳证券交易所。' },
  M4_RECOMMENDATION_MARKET: {field:'market',message:'推荐函请选择中国银行间市场交易商协会。'},
  M4_OFFERING_REQUIRED: {field:'offering',message:'请选择推荐函对应的品种：PPN 定向债务融资工具或中期票据。'},
  M4_OFFERING_UNSUPPORTED: {field:'offering',message:'当前材料模板适用于交易所普通私募公司债，请选择对应品种。'},
  M4_BROKER_REQUIRED: { field: 'broker', message: '尚未填写立项券商全称，请填写后选择或上传该券商的立项模板。' },
  M4_TEMPLATE_REQUIRED: { field: 'template', message: '尚未提供立项模板，请选择已保存的模板，或上传立项模板／已完成的立项报告。' },
  M4_TEMPLATE_SCOPE: { field: 'template', message: '已选模板与当前交易所或材料类型不一致，请重新选择对应模板。' },
  M4_CASE_TEMPLATE_SCOPE: {field:'case_template_id',message:'已选案例版式不适用于当前材料、市场或品种，请重新选择对应版式。'},
  M4_TEMPLATE_BROKER: { field: 'template', message: '已选模板与填写的立项券商不一致，请重新选择该券商的模板，或更正券商全称。' },
  M4_SOURCE_REQUIRED: { field: 'source_material', message: '尚未提供摘要所依据的募集书，请上传最新版募集说明书，或关联已有募集书项目并选择文件。' },
  M4_MATERIAL_REQUIRED: { field: 'materials', message: '尚未选择本次生成使用的材料，请上传或关联募集书，或在“补充资料”中上传并勾选材料。' },
} as const;
export type M4InputIssueCode = keyof typeof M4_INPUT_ISSUES;
export type M4InputField = typeof M4_INPUT_ISSUES[M4InputIssueCode]['field'];
export type M4InputIssue = { code: M4InputIssueCode; field: M4InputField; message: string };
export function m4InputIssue(code: unknown, field: unknown): M4InputIssue | undefined {
  if (typeof code !== 'string' || !Object.hasOwn(M4_INPUT_ISSUES, code)) return undefined;
  const key = code as M4InputIssueCode, issue = M4_INPUT_ISSUES[key];
  return field === issue.field ? { code: key, ...issue } : undefined;
}
export function m4DocumentInputIssues(input: M4DraftInput, template?: Pick<M4Template, 'market' | 'document_type' | 'broker'> | null): M4InputIssue[] {
  const issues: M4InputIssue[] = [];
  const add = (code: M4InputIssueCode) => issues.push({ code, ...M4_INPUT_ISSUES[code] });
  if (!(M4_DOCUMENT_MARKETS[input.document_type] as readonly string[]).includes(input.fields.market))
    add(input.document_type==='recommendation'?'M4_RECOMMENDATION_MARKET':'M4_MARKET_REQUIRED');
  const offering=input.fields.offering||(input.document_type==='recommendation'?'':'private');
  if(input.fields.case_template_id&&!M4_CASE_TEMPLATES.some(t=>t.id===input.fields.case_template_id&&t.document_type===input.document_type&&t.market===input.fields.market&&t.offering===offering))add('M4_CASE_TEMPLATE_SCOPE');
  if (!m4DocumentScopeSupported(input.document_type,input.fields.market,offering)
      && (input.document_type==='recommendation'?!['ppn','mtn'].includes(offering):offering!=='private'))
    add(input.document_type==='recommendation'?'M4_OFFERING_REQUIRED':'M4_OFFERING_UNSUPPORTED');
  if (input.document_type === 'init' && !input.template) {
    if (!input.fields.broker?.trim()) add('M4_BROKER_REQUIRED');
    add('M4_TEMPLATE_REQUIRED');
  }
  if (template && (template.market !== input.fields.market || template.document_type !== input.document_type)) add('M4_TEMPLATE_SCOPE');
  if (template && input.fields.broker && template.broker !== input.fields.broker) add('M4_TEMPLATE_BROKER');
  if (!input.source_material && !input.edit_base) {
    if (input.document_type === 'private_summary') add('M4_SOURCE_REQUIRED');
    else if (!input.materials.length) add('M4_MATERIAL_REQUIRED');
  }
  return issues;
}
