import {Type,type Static} from '@sinclair/typebox';
import {ProjectFileAssetSchema,ProjectFileTextSchema} from './project-file-workspace.js';
import {OUTCOME_PRICE_VERSION,CommerceMetadataFields} from './commerce.js';

export const PROJECT_QA_PRICE={points:60,version:'project-qa-question-60-v1'} as const;
const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128}),short=Type.String({maxLength:250}),text=Type.String({maxLength:16000});
const hash=Type.String({pattern:'^[a-f0-9]{64}$'}),nullable=<T extends import('@sinclair/typebox').TSchema>(s:T)=>Type.Union([s,Type.Null()]);
const qaPriceVersion=Type.Union([Type.Literal(PROJECT_QA_PRICE.version),Type.Literal(OUTCOME_PRICE_VERSION)]);
export const QaQuestionSchema=obj({id,start:Type.Integer({minimum:0}),end:Type.Integer({minimum:0}),question:Type.String({minLength:1,maxLength:16000})});
export type QaQuestion=Static<typeof QaQuestionSchema>;
export const QaCaseContentSchema=obj({title:Type.String({minLength:1,maxLength:250}),url:Type.String({minLength:1,maxLength:4096}),topic:Type.String({minLength:1,maxLength:250}),question:Type.String({minLength:1,maxLength:16000}),answer:Type.String({minLength:1,maxLength:16000}),approach:Type.String({minLength:1,maxLength:16000}),evidence_requirements:text});
export const QaCaseSchema=obj({id,revision:Type.Integer({minimum:1}),content:QaCaseContentSchema,sha256:hash,status:Type.Union(['pending','approved','withdrawn'].map(x=>Type.Literal(x))),review_note:text,created_at:short});
export type QaCase=Static<typeof QaCaseSchema>;
export const QaCitationSchema=obj({asset_index:Type.Integer({minimum:0}),span_id:id,quote:Type.String({minLength:1,maxLength:4000})});
export const QaAnswerSchema=obj({question_id:id,answer:Type.String({minLength:1,maxLength:16000}),status:Type.Union([Type.Literal('draft'),Type.Literal('missing')]),missing_materials:Type.Array(Type.String({minLength:1,maxLength:2000}),{maxItems:30}),citations:Type.Array(QaCitationSchema,{maxItems:30}),case_ids:Type.Array(id,{uniqueItems:true,maxItems:8}),approach:text});
export type QaAnswer=Static<typeof QaAnswerSchema>;
export const QaAssetSchema=obj({filename:short,asset:ProjectFileAssetSchema});
export const QaDraftSchema=obj({included_followup_of:Type.Optional(id),preparation_id:nullable(id),questions:Type.Array(QaQuestionSchema,{maxItems:200}),materials:Type.Array(ProjectFileAssetSchema,{maxItems:50}),requirements:text,use_knowledge:Type.Boolean()});
export type QaDraft=Static<typeof QaDraftSchema>;
export const QaInputSchema=obj({...CommerceMetadataFields,included_followup_of:Type.Optional(id),version:Type.Literal('project-qa-v1'),operation:Type.Union([Type.Literal('prepare'),Type.Literal('answer')]),project_name:short,source:QaAssetSchema,preparation_id:nullable(id),questions:Type.Array(QaQuestionSchema,{maxItems:200}),materials:Type.Array(QaAssetSchema,{maxItems:50}),requirements:text,cases:Type.Array(QaCaseSchema,{maxItems:40}),price_version:qaPriceVersion,points:Type.Integer({minimum:0,maximum:100000000})});
export type QaInput=Static<typeof QaInputSchema>;
export const QaDocumentSchema=obj({key:Type.String({maxLength:4096}),sha256:hash,byte_size:Type.Integer({minimum:1,maximum:104857600})});
export const QaEvidenceTextSchema=obj({...ProjectFileTextSchema.properties,format:Type.Union(['docx','pdf','doc','xlsx','unreadable'].map(x=>Type.Literal(x)))});
export const QaResultSchema=obj({version:Type.Literal('project-qa-result-v1'),input_hash:hash,document:QaDocumentSchema,snapshot:ProjectFileTextSchema,questions:Type.Array(QaQuestionSchema,{maxItems:200}),answers:Type.Array(QaAnswerSchema,{maxItems:200}),warnings:Type.Array(text,{maxItems:300}),evidence:Type.Array(obj({filename:short,snapshot:QaEvidenceTextSchema}),{maxItems:50})});
export type QaResult=Static<typeof QaResultSchema>;
export const QaRunSchema=obj({...CommerceMetadataFields,run_id:id,sequence:Type.Integer({minimum:1}),operation:Type.Union([Type.Literal('prepare'),Type.Literal('answer')]),state:short,stage:nullable(short),created_at:short,manifest:QaInputSchema,result:nullable(QaResultSchema),artifact_id:nullable(id),reserved_points:Type.Integer({minimum:0}),charged_points:Type.Integer({minimum:0})});
export type QaRun=Static<typeof QaRunSchema>;
export const QaWorkspaceSchema=obj({draft:QaDraftSchema,revision:Type.Integer({minimum:0}),runs:Type.Array(QaRunSchema),materials:Type.Array(QaAssetSchema),price:obj({...CommerceMetadataFields,points:Type.Integer({minimum:0}),version:qaPriceVersion})});
export type QaWorkspace=Static<typeof QaWorkspaceSchema>;
export const qaSchemas={QaWorkspaceResponse:QaWorkspaceSchema,QaRunResponse:obj({run_id:id}),QaQuery:obj({run_id:Type.Optional(id)}),
 QaQuoteRequest:obj({expected_revision:Type.Integer({minimum:0}),included_followup_of:Type.Optional(id)}),
 QaQuoteResponse:obj({...CommerceMetadataFields,points:Type.Integer({minimum:0,maximum:100000000}),price_version:qaPriceVersion}),
 QaPrepareRequest:obj({request_id:id,source:ProjectFileAssetSchema}),
 QaDraftRequest:obj({expected_revision:Type.Integer({minimum:0}),draft:QaDraftSchema}),
 QaAnswerRequest:obj({scope_quote_id:Type.Optional(id),included_followup_of:Type.Optional(id),request_id:id,expected_revision:Type.Integer({minimum:0}),expected_points:Type.Integer({minimum:0,maximum:100000000}),price_version:qaPriceVersion}),
 QaCasesResponse:obj({cases:Type.Array(QaCaseSchema),can_review:Type.Boolean()}),
 QaCaseQuery:obj({q:Type.Optional(Type.String({maxLength:200}))}),
 QaCaseCreateRequest:obj({request_id:id,content:QaCaseContentSchema}),
 QaCaseReviewRequest:obj({expected_revision:Type.Integer({minimum:1}),status:Type.Union([Type.Literal('approved'),Type.Literal('withdrawn')]),review_note:Type.String({minLength:1,maxLength:16000})})};
export function qaSearchTerms(value:string){return [...new Set((value.toLowerCase().match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/g)??[]).flatMap(s=>/[\u3400-\u9fff]/.test(s)?Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)):[s]))].slice(0,1000);}
export function qaOpenApiPaths(){
 const ref=(name:string)=>({content:{'application/json':{schema:{$ref:'#/components/schemas/'+name}}}});
 const project=[{name:'project_id',in:'path',required:true,schema:{type:'string'}}];
 const post=(request:string,response:string,parameters=project)=>({parameters,requestBody:{required:true,...ref(request)},responses:{200:{description:'Project Q&A',...ref(response)}}});
 return {'/projects/{project_id}/qa':{get:{parameters:project,responses:{200:{description:'Project Q&A',...ref('QaWorkspaceResponse')}}}},
 '/projects/{project_id}/qa/quote':{post:post('QaQuoteRequest','QaQuoteResponse')},'/projects/{project_id}/qa/prepare':{post:post('QaPrepareRequest','QaRunResponse')},'/projects/{project_id}/qa/draft':{post:post('QaDraftRequest','QaWorkspaceResponse')},'/projects/{project_id}/qa/runs':{post:post('QaAnswerRequest','QaRunResponse')},
 '/qa/cases':{get:{responses:{200:{description:'Public Q&A cases',...ref('QaCasesResponse')}}},post:post('QaCaseCreateRequest','QaCasesResponse',[])},
 '/qa/cases/{case_id}/review':{post:post('QaCaseReviewRequest','QaCasesResponse',[{name:'case_id',in:'path',required:true,schema:{type:'string'}}])}};
}
