import { Type, type Static } from '@sinclair/typebox';
export const M4_DOCUMENT_TYPES = ['init', 'underwriter', 'legal', 'private_summary', 'application', 'recommendation'] as const;
export const M4_DOCUMENT_LABELS = { init: '立项报告', underwriter: '主承销商核查意见', legal: '法律意见书', private_summary: '募集说明书摘要', application: '申请书', recommendation: '推荐函' } as const;
export const M4_DOCUMENT_BILLING_TASKS = {init:'m4_G01',underwriter:'m4_G02',legal:'m4_G03',private_summary:'m4_G05',application:'m4_application',recommendation:'m4_G04'} as const;
/** Reuse public market/offering values; material coverage is narrower. */
export const M4_DOCUMENT_MARKETS = {init:['sse','szse'],underwriter:['sse','szse'],legal:['sse','szse'],private_summary:['sse','szse'],application:['sse','szse'],recommendation:['nafmii']} as const;
export function m4DocumentScopeSupported(type:M4DocumentType,market:string,offering:string):boolean {
  return Object.hasOwn(M4_DOCUMENT_MARKETS,type) && (M4_DOCUMENT_MARKETS[type] as readonly string[]).includes(market)
    && (type==='recommendation' ? ['ppn','mtn'].includes(offering) : offering==='private');
}
export const M4_DOCUMENT_SUBTYPE = 'm4_document_v1';
export const M4_QA_SUBTYPE = 'm4_qa_v1';
export const M4DocumentTypeSchema = Type.Union(M4_DOCUMENT_TYPES.map(v => Type.Literal(v)));
export type M4DocumentType = Static<typeof M4DocumentTypeSchema>;

export { M4_CASE_TEMPLATES } from './m4-case-template-catalog.js';
