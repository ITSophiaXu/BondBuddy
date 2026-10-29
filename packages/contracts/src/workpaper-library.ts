import {Type,type Static} from '@sinclair/typebox';
import {ProjectFileSourceSchema,type ProjectFileLink} from './project-file-workspace.js';
import type {WorkpaperItem} from './workpapers.js';
import type {CommercePriceMetadata} from './commerce.js';
const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
export const WorkpaperCheckRequestSchema=obj({request_id:id,source_version_id:id,source_selection_revision:Type.Integer({minimum:0})});
export const WorkpaperPaidCheckRequestSchema=obj({request_id:id,workpaper_batch_id:id,source_version_id:id,source_selection_revision:Type.Integer({minimum:0}),
 file_version_ids:Type.Optional(Type.Array(id,{minItems:1,maxItems:1000,uniqueItems:true})),
 price_version:Type.Optional(id),expected_points:Type.Optional(Type.Integer({minimum:0,maximum:100000000})),
 scopes:Type.Optional(Type.Array(obj({file_version_id:id,scope_quote_id:id}),{maxItems:1000}))});
export type WorkpaperPaidCheckRequest=Static<typeof WorkpaperPaidCheckRequestSchema>;
export type WorkpaperPaidCheckQuote={points:number;price_version:string;auto_charge:true;source:import('./project-file-workspace.js').ProjectFileSource;
 items:({item_id:string;file_version_id:string;filename:string;points:number}&CommercePriceMetadata)[];excluded:{item_id:string;filename:string;reason:string}[]};
export type WorkpaperPaidCheckBatch={batch_id:string;workpaper_batch_id:string;created_at:string;source:import('./project-file-workspace.js').ProjectFileSource;points:number;
 state:'queued'|'running'|'complete'|'partial'|'failed';items:{item_id:string;file_version_id:string;filename:string;run_id:string;state:string;points:number;charged_points:number;scope_quote_id:string|null}[]};
export const WorkpaperChangeInputSchema=obj({version:Type.Literal('workpaper-change-v1'),batch_id:id,source:ProjectFileSourceSchema,baseline:ProjectFileSourceSchema});
export type WorkpaperChangeInput=Static<typeof WorkpaperChangeInputSchema>;
export type WorkpaperChange={source_span_id:string;before:string;after:string;source_location:string;target_locations:string[];fields:string[];reason:string};
export type WorkpaperImpact={item_id:string;status:'needs_update'|'manual'|'current';changes:WorkpaperChange[];reason:string};
export type WorkpaperChangeResult={version:'workpaper-change-result-v1';source_sha256:string;baseline_sha256:string;items:WorkpaperImpact[];warnings:string[];changed_spans:number};
export type WorkpaperCheck={run_id:string;batch_id:string;state:string;source:WorkpaperChangeInput['source'];baseline:WorkpaperChangeInput['baseline'];stale:boolean;result:WorkpaperChangeResult|null;created_at:string};
export type WorkpaperLibraryItem=WorkpaperItem&{batch_id:string;catalogue_id:string;created_at:string;source:WorkpaperChangeInput['source'];latest:boolean;version_count:number;impact:WorkpaperImpact|null;check_stale:boolean;links_count:number};
export const WORKPAPER_CHECK_UNAVAILABLE='底稿变更检查暂未开放，已有文件和历史检查记录仍可查看、下载。';
export type WorkpaperLibrary={items:WorkpaperLibraryItem[];total:number;offset:number;limit:number;source:WorkpaperChangeInput['source']|null;checks:WorkpaperCheck[];
 paid_checks?:WorkpaperPaidCheckBatch[];check_capability?:{enabled:boolean;reason:string;mode?:'per_file'|'legacy'}};
export type WorkpaperDependencies={links:ProjectFileLink[];warnings:string[];source_sha256:string;target_sha256:string};
