import {Type,type Static} from '@sinclair/typebox';
import {M4MaterialPinSchema} from './m4-workspace.js';
import {INTEGRITY_SITE_LIMIT} from './integrity-sites.js';
export * from './integrity-sites.js';
export const INTEGRITY_PRICE={points:5000,version:'integrity-round-5000-v1'} as const;
const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128}),short=Type.String({maxLength:200}),text=Type.String({maxLength:12000});
const hash=Type.String({pattern:'^[a-f0-9]{64}$'}),time=Type.String({pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?Z$'});
export const IntegritySubjectSchema=obj({id,kind:Type.Union([Type.Literal('company'),Type.Literal('person')]),name:Type.String({minLength:1,maxLength:200}),identifier:short,role:short,province:short,city:short});
export type IntegritySubject=Static<typeof IntegritySubjectSchema>;
export const IntegrityDraftSchema=obj({subjects:Type.Array(IntegritySubjectSchema,{maxItems:100}),site_ids:Type.Array(id,{uniqueItems:true,maxItems:INTEGRITY_SITE_LIMIT}),notes:text});
export type IntegrityDraft=Static<typeof IntegrityDraftSchema>;
export const IntegritySourceSchema=obj({url:Type.String({maxLength:4096}),title:short,quote:text,retrieved_at:time,tool_call_id:id,sha256:hash});
export const IntegrityCaptureSchema=obj({id,kind:Type.Union((['result','detail','blocker'] as const).map(x=>Type.Literal(x))),url:Type.String({maxLength:4096}),title:short,captured_at:time,page:Type.Integer({minimum:1,maximum:20}),screenshot_sha256:hash,text_sha256:hash,byte_size:Type.Integer({minimum:1,maximum:15000000})});
export type IntegrityCapture=Static<typeof IntegrityCaptureSchema>;
export const IntegrityBrowserSchema=obj({version:Type.Literal('official-browser-v1'),outcome:Type.Union((['results','no_results','blocked','failed','unverified'] as const).map(x=>Type.Literal(x))),scope:text,limitation:text,captures:Type.Array(IntegrityCaptureSchema,{maxItems:20})});
export type IntegrityBrowser=Static<typeof IntegrityBrowserSchema>;
export const IntegrityBrowserInterpretationSchema=obj({summary:text,findings:Type.Array(obj({capture_id:id,quote:text,explanation:text}),{maxItems:20})});
export type IntegrityBrowserInterpretation=Static<typeof IntegrityBrowserInterpretationSchema>;
export const IntegrityRecordSchema=obj({subject_id:id,site_id:id,site_name:short,urls:Type.Array(Type.String({maxLength:4096})),query:Type.String({maxLength:4000}),
  status:Type.Union((['public_matches','no_public_results','needs_manual','not_applicable','query_failed'] as const).map(x=>Type.Literal(x))),reason:text,checked_at:time,sources:Type.Array(IntegritySourceSchema,{maxItems:30}),search_performed:Type.Boolean(),browser:Type.Optional(IntegrityBrowserSchema)});
export type IntegrityRecord=Static<typeof IntegrityRecordSchema>;
export const IntegrityInputSchema=obj({version:Type.Literal('integrity-round-v1'),operation:Type.Union([Type.Literal('check'),Type.Literal('export')]),
  round_id:id,project_name:short,draft:IntegrityDraftSchema,price_version:Type.Literal(INTEGRITY_PRICE.version),points:Type.Integer({minimum:0}),
  records:Type.Array(IntegrityRecordSchema,{maxItems:100*INTEGRITY_SITE_LIMIT}),evidence_ids:Type.Array(id,{maxItems:2000}),collector:Type.Optional(Type.Literal('official-browser-v1'))});
export type IntegrityInput=Static<typeof IntegrityInputSchema>;
export const IntegrityManualSchema=obj({request_id:id,subject_id:id,site_id:id,queried_at:time,url:Type.String({maxLength:4096}),note:text,
  conclusion:Type.Union([Type.Literal('records_found'),Type.Literal('no_records'),Type.Literal('unresolved')]),material:M4MaterialPinSchema,registration:Type.Optional(obj({province:short,city:short}))});
export type IntegrityManual=Static<typeof IntegrityManualSchema>;
export const IntegrityEvidenceSchema=obj({...IntegrityManualSchema.properties,id,created_at:time});
export type IntegrityEvidence=Static<typeof IntegrityEvidenceSchema>;
export const IntegrityProposalSchema=obj({sites:Type.Array(obj({site_id:id,note:text,sources:Type.Array(obj({url:Type.String({maxLength:4096}),quote:text}),{maxItems:30})}),{maxItems:INTEGRITY_SITE_LIMIT})});
export type IntegrityProposal=Static<typeof IntegrityProposalSchema>;
export const IntegrityRoundSchema=obj({run_id:id,round_id:id,operation:Type.Union([Type.Literal('check'),Type.Literal('export')]),sequence:Type.Integer({minimum:1}),state:short,stage:Type.Union([short,Type.Null()]),created_at:time,manifest:IntegrityInputSchema,records:Type.Array(IntegrityRecordSchema),evidence:Type.Array(IntegrityEvidenceSchema),artifact_id:Type.Union([id,Type.Null()]),artifacts:Type.Array(obj({kind:Type.Union([Type.Literal('company'),Type.Literal('person')]),artifact_id:id,artifact_version:Type.Integer({minimum:1})})),charged_points:Type.Integer({minimum:0}),reserved_points:Type.Integer({minimum:0})});
export type IntegrityRound=Static<typeof IntegrityRoundSchema>;
export const IntegrityWorkspaceSchema=obj({draft:IntegrityDraftSchema,revision:Type.Integer({minimum:0}),rounds:Type.Array(IntegrityRoundSchema),price:obj({points:Type.Literal(5000),version:Type.Literal(INTEGRITY_PRICE.version)})});
export type IntegrityWorkspace=Static<typeof IntegrityWorkspaceSchema>;
export const integritySchemas={
 IntegrityWorkspaceResponse:IntegrityWorkspaceSchema,IntegrityRunResponse:obj({run_id:id}),
 IntegrityQuery:obj({run_id:Type.Optional(id)}),
 IntegrityDraftRequest:obj({expected_revision:Type.Integer({minimum:0}),draft:IntegrityDraftSchema}),
 IntegrityRunRequest:obj({request_id:id,expected_revision:Type.Integer({minimum:0}),price_version:Type.Literal(INTEGRITY_PRICE.version),expected_points:Type.Literal(5000)}),
 IntegrityExportRequest:obj({request_id:id,expected_evidence_ids:Type.Array(id,{uniqueItems:true,maxItems:2000})}),
 IntegrityManualRequest:IntegrityManualSchema,
 IntegrityCaptureParams:obj({project_id:id,run_id:id,capture_id:id}),
};
export function integrityOpenApiPaths(){
 const content=(name:string)=>({content:{'application/json':{schema:{$ref:'#/components/schemas/'+name}}}});
 const parameters=[{name:'project_id',in:'path',required:true,schema:{type:'string'}}];
 const post=(name:string,response='IntegrityWorkspaceResponse',round=false)=>({parameters:[...parameters,...(round?[{name:'run_id',in:'path',required:true,schema:{type:'string'}}]:[])],requestBody:{required:true,...content(name)},responses:{200:{description:'Owned integrity result',...content(response)}}});
 return {'/projects/{project_id}/integrity':{get:{parameters:[...parameters,{name:'run_id',in:'query',required:false,schema:{type:'string'}}],responses:{200:{description:'Owned integrity workspace',...content('IntegrityWorkspaceResponse')}}}},
 '/projects/{project_id}/integrity/draft':{post:post('IntegrityDraftRequest')},
 '/projects/{project_id}/integrity/runs':{post:post('IntegrityRunRequest','IntegrityRunResponse')},
 '/projects/{project_id}/integrity/runs/{run_id}/evidence':{post:post('IntegrityManualRequest','IntegrityWorkspaceResponse',true)},
 '/projects/{project_id}/integrity/runs/{run_id}/exports':{post:post('IntegrityExportRequest','IntegrityRunResponse',true)},
 '/projects/{project_id}/integrity/runs/{run_id}/captures/{capture_id}':{get:{parameters:[...parameters,...['run_id','capture_id'].map(name=>({name,in:'path',required:true,schema:{type:'string'}}))],responses:{200:{description:'Owned hash-verified official screenshot',content:{'image/png':{schema:{type:'string',format:'binary'}}}}}}}};
}
