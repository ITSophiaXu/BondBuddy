import {Type,type Static} from '@sinclair/typebox';

export const DirectCheckStatusSchema=Type.Union([Type.Literal('passed'),Type.Literal('not_checked'),Type.Literal('mismatch')]);
export const DirectPageCheckSchema=Type.Object({version:Type.Literal('direct-docx-page-v1'),
  status:Type.Union([Type.Literal('passed'),Type.Literal('mismatch')]),baseline_pages:Type.Integer({minimum:1}),
  result_pages:Type.Integer({minimum:1}),ratio:Type.Number({minimum:0}),minimum_ratio:Type.Number({exclusiveMinimum:0,maximum:1}),
  libreoffice_version:Type.String({minLength:1,maxLength:128})},{additionalProperties:false});
export const DirectFinancialCheckSchema=Type.Object({version:Type.Literal('direct-financial-v1'),status:DirectCheckStatusSchema,
  compared:Type.Integer({minimum:0}),issues:Type.Array(Type.Object({code:Type.String({minLength:1}),
    scope:Type.Optional(Type.String()),period:Type.Optional(Type.String()),metric:Type.Optional(Type.String()),
    source:Type.Optional(Type.String()),document:Type.Optional(Type.String()),table:Type.Optional(Type.String()),body:Type.Optional(Type.String())},
    {additionalProperties:false}),{maxItems:100}),unchecked:Type.Array(Type.String(),{maxItems:100})},{additionalProperties:false});
export const DirectDocxChecksSchema=Type.Object({page_check:DirectPageCheckSchema,financial_check:DirectFinancialCheckSchema},
  {additionalProperties:false});
export type DirectDocxChecks=Static<typeof DirectDocxChecksSchema>;
