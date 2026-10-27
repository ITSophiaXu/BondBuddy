import {Type,type Static} from '@sinclair/typebox';
import {WorkpaperEntrySchema,WORKPAPER_LIMITS,type WorkpaperDecision} from './workpaper-entry.js';
import {ProjectFileSourceSchema} from './project-file-workspace.js';
const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const hash=Type.String({pattern:'^[a-f0-9]{64}$'});
export const WorkpaperAssessSchema=obj({request_id:id,catalogue_id:id,catalogue_sha256:hash,
 item_ids:Type.Array(id,{minItems:1,maxItems:WORKPAPER_LIMITS.items,uniqueItems:true}),source_version_id:id,
 source_selection_revision:Type.Integer({minimum:0}),requirements:Type.String({maxLength:12000})});
export type WorkpaperAssess=Static<typeof WorkpaperAssessSchema>;
export const WorkpaperAssessmentInputSchema=obj({version:Type.Literal('workpaper-assessment-v1'),request:WorkpaperAssessSchema,
 source:ProjectFileSourceSchema,entries:Type.Array(WorkpaperEntrySchema,{minItems:1,maxItems:WORKPAPER_LIMITS.items})});
export type WorkpaperAssessmentInput=Static<typeof WorkpaperAssessmentInputSchema>;
export type WorkpaperAssessment={assessment_id:string;state:string;source:WorkpaperAssessmentInput['source'];request:WorkpaperAssess;created_at:string;
 result_hash:string|null;decisions:WorkpaperDecision[];warnings:string[];completed_items:number};
