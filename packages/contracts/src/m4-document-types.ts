import { Type, type Static } from '@sinclair/typebox';
export const M4_DOCUMENT_TYPES = ['init', 'underwriter', 'legal', 'private_summary'] as const;
export const M4_DOCUMENT_LABELS = { init: '立项报告', underwriter: '主承销商核查意见', legal: '法律意见书', private_summary: '普通私募募集说明书摘要' } as const;
export const M4_DOCUMENT_BILLING_TASKS = {init:'m4_G01',underwriter:'m4_G02',legal:'m4_G03',private_summary:'m4_G05'} as const;
export const M4_DOCUMENT_SUBTYPE = 'm4_document_v1';
export const M4_QA_SUBTYPE = 'm4_qa_v1';
export const M4DocumentTypeSchema = Type.Union(M4_DOCUMENT_TYPES.map(v => Type.Literal(v)));
export type M4DocumentType = Static<typeof M4DocumentTypeSchema>;
