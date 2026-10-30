import {Type,type Static} from '@sinclair/typebox';
import {M4MaterialPinSchema} from './m4-workspace.js';
import type {WorkpaperEntry} from './workpaper-entry.js';
const column=Type.Integer({minimum:0,maximum:99});
export const WorkpaperColumnMappingSchema=Type.Object({
  sheet:Type.String({minLength:1,maxLength:200}),first_row:Type.Integer({minimum:1,maximum:10000}),last_row:Type.Integer({minimum:1,maximum:10000}),
  title_column:column,code_column:Type.Optional(column),kind_column:Type.Optional(column),
  folder_columns:Type.Array(column,{maxItems:12,uniqueItems:true}),instruction_columns:Type.Array(column,{maxItems:12,uniqueItems:true}),split_code:Type.Boolean(),
},{additionalProperties:false});
export const WorkpaperMappingsSchema=Type.Array(WorkpaperColumnMappingSchema,{minItems:1,maxItems:60});
export const WorkpaperPreviewSchema=Type.Object({material:M4MaterialPinSchema,
  scope:Type.Optional(Type.Union([Type.Literal('due_diligence'),Type.Literal('all')])),mapping:Type.Optional(WorkpaperMappingsSchema),
},{additionalProperties:false});
export type WorkpaperColumnMapping=Static<typeof WorkpaperColumnMappingSchema>;
export type WorkpaperCataloguePreview={
  filename:string;entries:WorkpaperEntry[];warnings:string[];needs_review:boolean;mapping:WorkpaperColumnMapping[];
  sheets:{name:string;last_row:number;columns:{index:number;label:string;sample:string}[];sample_rows:{row:number;cells:string[]}[]}[];
  unrecognized_rows:{sheet:string;row:number;cells:string[]}[];unrecognized_count:number;
};
