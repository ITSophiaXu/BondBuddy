import { Type, type Static } from '@sinclair/typebox';
const id=Type.String({minLength:1,maxLength:128});
const hash=Type.String({pattern:'^[a-f0-9]{64}$'});
export const ReviewDecisionSchema=Type.Object({id,decision:Type.Union([Type.Literal('suggested'),Type.Literal('original'),Type.Literal('manual')]),manual_text:Type.String({maxLength:12000})},{additionalProperties:false});
export type ReviewDecision=Static<typeof ReviewDecisionSchema>;
export const ReviewExportRequestSchema=Type.Object({request_id:id,source_run_id:id,expected_editor_sha256:hash,decisions:Type.Array(ReviewDecisionSchema,{maxItems:2000})},{additionalProperties:false});
export type ReviewExportRequest=Static<typeof ReviewExportRequestSchema>;
export const ReviewSourceRequestSchema=Type.Object({version_id:id},{additionalProperties:false});
export type ReviewSourceRequest=Static<typeof ReviewSourceRequestSchema>;
export type ReviewEditorIssue=Static<typeof ReviewEditorIssueSchema>;
export type ReviewEditorSnapshot=Static<typeof ReviewEditorSnapshotSchema>;
export type ReviewEditorResponse=Static<typeof ReviewEditorResponseSchema>;
export type ReviewExportPin={source_run_id:string;editor_sha256:string;decisions:ReviewDecision[]};

/** API response schemas and OpenAPI share the same issue/decision definition. */
const text=Type.String();
export const ReviewEditorIssueSchema=Type.Object({...ReviewDecisionSchema.properties,category:text,title:text,original:text,replacement:text,reason:text,evidence:text,missing:text,uncertain:Type.Boolean(),paragraph_id:Type.Union([text,Type.Null()]),applied:Type.Boolean(),limitation:text,original_location:Type.Optional(text),source_finding_id:Type.Optional(id)},{additionalProperties:false});
export const ReviewEditorSnapshotSchema=Type.Object({version:Type.Literal('review-editor-v1'),source_filename:text,source_sha256:hash,source_format:Type.Union([Type.Literal('docx'),Type.Literal('pdf')]),warnings:Type.Array(text),paragraphs:Type.Array(Type.Object({id:text,text})),issues:Type.Array(ReviewEditorIssueSchema)},{additionalProperties:false});
export const ReviewEditorResponseSchema=Type.Object({run_id:id,sha256:hash,snapshot:ReviewEditorSnapshotSchema},{additionalProperties:false});
export function reviewEditorOpenApiPaths(ref:(name:'RunResponse'|'MaterialResponse')=>unknown){
  const route=(method:string,description:string,body:unknown,response:unknown,run=false)=>({[method]:{description,security:[{sessionCookie:[]}],parameters:[{name:'project_id',in:'path',required:true,schema:id},...(run?[{name:'run_id',in:'path',required:true,schema:id}]:[])],...(body?{requestBody:{required:true,content:{'application/json':{schema:body}}}}:{}),responses:{200:{description:'Success',content:{'application/json':{schema:response}}},404:{description:'Not found or not owned'},409:{description:'Input, execution or idempotency conflict'}}}});
  return {
    '/api/v1/projects/{project_id}/review-executions/{run_id}/editor':route('get','Immutable completed review edition',null,ReviewEditorResponseSchema,true),
    '/api/v1/projects/{project_id}/review-exports':route('post','Durable deterministic export; no model call or AI credit reservation',ReviewExportRequestSchema,ref('RunResponse')),
    '/api/v1/projects/{project_id}/review-source':route('post','Import an exact project prospectus version as review input; does not execute or select current',ReviewSourceRequestSchema,ref('MaterialResponse')),
    '/api/v1/projects/{project_id}/review-entry':route('post','Resolve existing project workspace without changing its kind',Type.Object({},{additionalProperties:false}),Type.Object({project_id:id})),
  };
}
