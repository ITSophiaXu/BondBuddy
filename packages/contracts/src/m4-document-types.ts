import { Type, type Static } from '@sinclair/typebox';
import { MARKETS, MARKET_OFFERINGS } from './public-enums.js';
export const M4_DOCUMENT_TYPES = ['init', 'underwriter', 'legal', 'private_summary', 'application', 'recommendation', 'annual', 'semiannual', 'issuer', 'financial', 'credit', 'proceeds', 'workpaper'] as const;
export const M4_DOCUMENT_LABELS = { init: '立项报告', underwriter: '主承销商核查意见', legal: '法律意见书', private_summary: '募集说明书摘要', application: '申请书', recommendation: '推荐函', annual:'年度报告', semiannual:'半年度报告', issuer:'发行人基本情况说明', financial:'主要财务情况说明', credit:'授信情况说明', proceeds:'募集资金使用情况说明',workpaper:'尽职调查底稿' } as const;
export const M4_DOCUMENT_BILLING_TASKS = {init:'m4_G01',underwriter:'m4_G02',legal:'m4_G03',private_summary:'m4_G05',application:'m4_application',recommendation:'m4_G04',annual:'m4_annual',semiannual:'m4_semiannual',issuer:'m4_issuer',financial:'m4_financial',credit:'m4_credit',proceeds:'m4_proceeds',workpaper:'m4_workpaper'} as const;
/** Reuse public market/offering values; material coverage is narrower. */
export const M4_DOCUMENT_MARKETS = {init:['sse','szse'],underwriter:['sse','szse'],legal:['sse','szse'],private_summary:['sse','szse'],application:['sse','szse'],recommendation:['nafmii'],annual:MARKETS,semiannual:MARKETS,issuer:MARKETS,financial:MARKETS,credit:MARKETS,proceeds:MARKETS,workpaper:MARKETS} as const;
export function m4DocumentScopeSupported(type:M4DocumentType,market:string,offering:string,projectTemplate=false):boolean {
  if(projectTemplate||type==='workpaper')return M4_DOCUMENT_TYPES.includes(type)&&(MARKETS as readonly string[]).includes(market)&&(MARKET_OFFERINGS[market as typeof MARKETS[number]] as readonly string[]).includes(offering);
  return Object.hasOwn(M4_DOCUMENT_MARKETS,type) && (M4_DOCUMENT_MARKETS[type] as readonly string[]).includes(market)
    && (type==='recommendation' ? ['ppn','mtn'].includes(offering) : offering==='private');
}
export const M4_DOCUMENT_SUBTYPE = 'm4_document_v1';
export const M4_QA_SUBTYPE = 'm4_qa_v1';
export const M4DocumentTypeSchema = Type.Union(M4_DOCUMENT_TYPES.map(v => Type.Literal(v)));
export type M4DocumentType = Static<typeof M4DocumentTypeSchema>;

export { M4_CASE_TEMPLATES } from './m4-case-template-catalog.js';
