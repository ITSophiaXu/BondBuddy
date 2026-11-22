import {Type,type Static,type TSchema} from '@sinclair/typebox';

const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:256});
const hash=Type.String({pattern:'^[a-f0-9]{64}$'});
const count=Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER});
const nullable=<T extends TSchema>(s:T)=>Type.Union([s,Type.Null()]);
const refs=Type.Array(id,{maxItems:20000,uniqueItems:true});
const texts=Type.Array(Type.String({minLength:1,maxLength:4096}),{maxItems:1000});
const time=Type.String({pattern:'^\\d{4}-\\d{2}-\\d{2}T.*Z$'});
export const WorkflowPhaseSchema=Type.Union([Type.Literal('authoring'),Type.Literal('postprocess')]);
export type WorkflowPhase=Static<typeof WorkflowPhaseSchema>;
export const WorkflowObjectSchema=obj({key:Type.String({minLength:1,maxLength:4096}),sha256:hash,byte_size:Type.Integer({minimum:1,maximum:100*1024*1024})});
export type WorkflowObject=Static<typeof WorkflowObjectSchema>;
export const WorkflowCursorSchema=obj({chapter:count,batch:count});
export const AuthoringPlanV1Schema=obj({version:Type.Literal('authoring-plan-v1'),input_hash:hash,baseline_hash:nullable(hash),material_snapshot_hash:hash,knowledge_hash:hash,
  chapters:Type.Array(obj({chapter_id:id,order:count,title:Type.String({minLength:1,maxLength:1024}),required:Type.Boolean(),depends_on:refs,source_node_ids:refs,evidence_refs:refs,
    batches:Type.Array(obj({batch_id:id,order:count,allowed_node_ids:refs,context_refs:refs,output_contract:Type.Union([Type.Literal('controlled-operations-v1'),Type.Literal('document-projection-v1')])}),{minItems:1,maxItems:2000})}),{minItems:1,maxItems:2000}),
  limits:obj({call_ms:Type.Integer({minimum:1}),repair_ms:Type.Integer({minimum:1}),repair_revisions:Type.Integer({minimum:1,maximum:2}),context_records:Type.Integer({minimum:1,maximum:600}),context_chars:Type.Integer({minimum:1,maximum:18000}),context_bytes:Type.Integer({minimum:1,maximum:96000}),output_bytes:Type.Integer({minimum:1,maximum:98304})}),plan_hash:hash});
export type AuthoringPlanV1=Static<typeof AuthoringPlanV1Schema>;
export const DocumentBlockV1Schema=obj({block_id:id,order:count,kind:Type.Union([Type.Literal('heading'),Type.Literal('paragraph'),Type.Literal('table')]),text:Type.String({maxLength:32768}),
  rows:Type.Array(Type.Array(Type.String({maxLength:32768}),{minItems:1,maxItems:32}),{maxItems:129}),evidence:refs,pending:texts,heading_level:nullable(Type.Integer({minimum:1,maximum:9})),
  style_key:Type.Union([Type.Literal('heading'),Type.Literal('body'),Type.Literal('table'),Type.Literal('caption')]),table_id:nullable(id),row_order:nullable(count)});
export const DocumentProjectionV1Schema=obj({version:Type.Literal('document-projection-v1'),input_hash:hash,plan_hash:hash,chapter_id:id,batch_id:id,blocks:Type.Array(DocumentBlockV1Schema,{minItems:1,maxItems:600}),summary:texts});
export type DocumentProjectionV1=Static<typeof DocumentProjectionV1Schema>;
const controlledCommon={node_id:id,before:Type.String({maxLength:18000}),evidence:refs,pending:texts};
const position=Type.Optional(Type.Union([Type.Literal('before'),Type.Literal('after')]));
const cellText=Type.Union([Type.String({maxLength:18000}),Type.Array(Type.String({maxLength:18000}),{minItems:1,maxItems:32})]);
export const ControlledChapterEditV1Schema=Type.Union([
  obj({...controlledCommon,kind:Type.Literal('replace_text'),after:Type.String({maxLength:18000})}),
  obj({...controlledCommon,kind:Type.Literal('replace_cell_text'),after:Type.String({maxLength:18000})}),
  obj({...controlledCommon,kind:Type.Literal('add_comment'),after:Type.String({maxLength:18000})}),
  obj({...controlledCommon,kind:Type.Literal('insert_paragraph'),text:Type.String({maxLength:18000}),position,style_node_id:Type.Optional(id)}),
  obj({...controlledCommon,kind:Type.Literal('insert_column'),column_index:Type.Integer({minimum:0,maximum:31}),position,values:Type.Array(cellText,{minItems:1,maxItems:128})}),
  obj({...controlledCommon,kind:Type.Literal('insert_row'),position,values:Type.Array(cellText,{minItems:1,maxItems:32})}),
  obj({...controlledCommon,kind:Type.Literal('insert_table'),position,style_node_id:Type.Optional(id),rows:Type.Array(Type.Array(Type.String({maxLength:18000}),{minItems:1,maxItems:20}),{minItems:1,maxItems:100})}),
  obj({...controlledCommon,kind:Type.Literal('delete_table')})
]);
export const ControlledChapterOutputV1Schema=obj({reviewed:refs,edits:Type.Array(ControlledChapterEditV1Schema,{maxItems:12}),summary:texts});
export type ControlledChapterOutputV1=Static<typeof ControlledChapterOutputV1Schema>;
export const WorkflowOutlineV1Schema=obj({chapters:Type.Array(Type.String({minLength:1,maxLength:1024}),{minItems:1,maxItems:40,uniqueItems:true})});
export const ChapterReceiptV1Schema=obj({version:Type.Literal('chapter-receipt-v1'),run_id:id,job_id:id,input_hash:hash,plan_hash:hash,chapter_id:id,batch_id:id,logical_call_id:id,execution_generation:Type.Integer({minimum:1}),call_status:Type.Literal('completed'),object:WorkflowObjectSchema,
  projection_version:count,operations_sha256:nullable(hash),accepted_op_receipts:Type.Array(obj({op_id:id,input_hash:hash,projection_version:count}),{maxItems:20000}),
  validation:obj({schema_version:id,range_verified:Type.Literal(true),structure_verified:Type.Literal(true),evidence_refs_valid:Type.Literal(true)}),created_at:time});
export type ChapterReceiptV1=Static<typeof ChapterReceiptV1Schema>;
export const WorkflowPostprocessManifestV1Schema=obj({version:Type.Literal('workflow-postprocess-manifest-v1'),input_hash:hash,plan_hash:hash,chapter_receipts:Type.Array(ChapterReceiptV1Schema,{maxItems:20000}),candidate:WorkflowObjectSchema});
export type WorkflowPostprocessManifestV1=Static<typeof WorkflowPostprocessManifestV1Schema>;
export const WorkflowPendingDispositionSchema=obj({kind:Type.Union(['pause','cancel','handoff','fail','succeeded'].map(x=>Type.Literal(x))),stage:id,reason:id,error_code:Type.Optional(id),artifact_id:Type.Optional(id),artifact_version:Type.Optional(count)});
export const AuthoringWorkflowV1Schema=obj({protocol_version:Type.Literal(1),input_hash:hash,plan_hash:hash,plan:AuthoringPlanV1Schema,plan_ref:Type.Optional(WorkflowObjectSchema),phase:WorkflowPhaseSchema,next_cursor:WorkflowCursorSchema,completed:Type.Array(ChapterReceiptV1Schema,{maxItems:20000}),run_deadline_at:time,
  token_budget:obj({limit:Type.Integer({minimum:1}),used_known:count,unknown_calls:refs}),repair_budget:obj({used_ms:count,used_revisions:count}),phase_failures:obj({authoring:count,postprocess:count}),handoff_id:nullable(id),postprocess_manifest:nullable(WorkflowPostprocessManifestV1Schema),pending_disposition:Type.Optional(WorkflowPendingDispositionSchema)});
export type AuthoringWorkflowV1=Static<typeof AuthoringWorkflowV1Schema>;
