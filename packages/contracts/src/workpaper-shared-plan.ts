import {Type,type Static} from '@sinclair/typebox';
import {WorkpaperDecisionSchema} from './workpaper-entry.js';
const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const ids=Type.Array(id,{maxItems:100000,uniqueItems:true});
const text=Type.String({minLength:1,maxLength:20000});
// Internal model/worker contract. It is never included in the customer ZIP.
export const WorkpaperSharedPlanSchema=obj({version:Type.Literal('workpaper-shared-plan-v1'),
 source_sha256:Type.String({pattern:'^[a-f0-9]{64}$'}),reviewed_span_ids:ids,
 excluded:Type.Array(obj({span_ids:ids,reason:text}),{maxItems:10000}),
 image_reviews:Type.Array(obj({image_id:id,description:text,item_ids:ids,verified:Type.Boolean()}),{maxItems:1000}),
 items:Type.Array(obj({item_id:id,decision:WorkpaperDecisionSchema,required_evidence:text,
   facts:ids,searched_span_ids:ids,
   narrative:Type.Array(obj({text,sources:ids}),{maxItems:1000}),
   calculations:Type.Array(obj({label:text,operation:Type.Union(['sum','difference','ratio','growth'].map(x=>Type.Literal(x))),
     operands:Type.Array(obj({span_id:id,context_span_ids:Type.Array(id,{minItems:1,maxItems:100,uniqueItems:true}),value:Type.String({pattern:'^-?[0-9]+(\\.[0-9]+)?$'}),unit:text,period:text,scope:text}),{minItems:1,maxItems:1000}),
     unit:text,period:text,scope:text,decimals:Type.Integer({minimum:0,maximum:6})}),{maxItems:1000})
 }),{minItems:1,maxItems:1000})});
export type WorkpaperSharedPlan=Static<typeof WorkpaperSharedPlanSchema>;
export type WorkpaperSharedItem=WorkpaperSharedPlan['items'][number];
