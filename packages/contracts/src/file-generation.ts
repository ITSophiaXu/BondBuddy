import {Type,type Static} from '@sinclair/typebox';
import {GenerationProgressSchema} from './generation-progress.js';
import {M4MaterialPinSchema,M4TemplateRefSchema,type M4TemplateRef} from './m4-workspace.js';
import {M4DocumentTypeSchema} from './m4-document-types.js';
import type {WorkpaperCatalogue,WorkpaperBatch} from './workpapers.js';
import type {ProjectFileBatch} from './project-file-workspace.js';
import type {CommercePriceMetadata} from './commerce.js';
const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const sha=Type.String({pattern:'^[a-f0-9]{64}$'});
export const FileTemplatePinSchema=obj({set_id:id,record_id:id,sha256:sha});
export type FileTemplatePin=Static<typeof FileTemplatePinSchema>;
export const FileTemplateChoiceSchema=Type.Union([FileTemplatePinSchema,obj({private_template:M4TemplateRefSchema})]);
export type FileTemplateChoice=Static<typeof FileTemplateChoiceSchema>;
export const FileGenerationPreparationSchema=obj({
  // Omitted preserves the original requirement for an explicitly pinned Word.
  workpaper_template_mode:Type.Optional(Type.Union([Type.Literal('automatic'),Type.Literal('selected')])),
  document_types:Type.Array(M4DocumentTypeSchema,{maxItems:20,uniqueItems:true}),
  catalogue_id:Type.Union([id,Type.Null()]),template_set_id:Type.Union([id,Type.Null()]),
  item_ids:Type.Array(id,{maxItems:1000,uniqueItems:true}),
  mappings:Type.Record(id,FileTemplatePinSchema,{maxProperties:1000}),
  document_templates:Type.Record(id,FileTemplateChoiceSchema,{maxProperties:20}),
  materials:Type.Array(M4MaterialPinSchema,{maxItems:50}),
  requirements:Type.String({maxLength:12000}),target_year:Type.String({pattern:'^$|^20[0-9]{2}$'}),
});
export type FileGenerationPreparation=Static<typeof FileGenerationPreparationSchema>;
export const emptyFileGenerationPreparation=():FileGenerationPreparation=>({document_types:[],catalogue_id:null,template_set_id:null,item_ids:[],mappings:{},document_templates:{},materials:[],requirements:'',target_year:''});
export const FilePreparationSaveSchema=obj({expected_revision:Type.Integer({minimum:0}),preparation:FileGenerationPreparationSchema});
export const FileGenerationSubmitSchema=obj({request_id:id,expected_revision:Type.Integer({minimum:1}),source_version_id:id,source_selection_revision:Type.Integer({minimum:0}),expected_points:Type.Integer({minimum:0}),price_version:id,document_quotes:Type.Optional(Type.Array(obj({document_type:M4DocumentTypeSchema,draft_version:Type.Integer({minimum:1}),scope_quote_id:id}),{maxItems:20}))});
export type FileGenerationSubmit=Static<typeof FileGenerationSubmitSchema>;
export const FileTemplateImportSchema=obj({request_id:id,sha256:sha,document_type:M4DocumentTypeSchema});
export const FileTemplateImportQuerySchema=obj({...FileTemplateImportSchema.properties,format:Type.Union([Type.Literal('zip'),Type.Literal('docx')]),filename:Type.String({minLength:1,maxLength:500})});
export const FileTemplateCombineSchema=obj({request_id:id,set_ids:Type.Array(id,{minItems:1,maxItems:500,uniqueItems:true})});
export const FileTemplateMatchQuerySchema=obj({catalogue_id:id,set_id:id});
export const FileBuiltinAdoptSchema=obj({request_id:id,version:id,part:Type.Union([Type.Literal('catalogue'),Type.Literal('templates'),Type.Literal('all')])});
export type FileTemplateRecord=FileTemplatePin & {name:string;code:string;role:string;document_type:Static<typeof M4DocumentTypeSchema>};
export type FileTemplateSet={set_id:string;name:string;version:string;origin:'builtin'|'private';records:FileTemplateRecord[];warnings:string[];catalogue?:WorkpaperCatalogue};
export type FileTemplatePreview={title:string;redacted:true;view:'structure';blocks:({kind:'paragraph';text:string;bold:boolean;align:string}|{kind:'table';rows:string[][]})[];pdf_available:boolean};
export type SystemWorkpaperTemplates={templates:{family:string;preview:FileTemplatePreview}[]};
export type FileGenerationBatch={batch_id:string;created_at:string;points:number;workpapers:WorkpaperBatch|null;documents:ProjectFileBatch|null};
export type FileGenerationPricing={mode:'legacy'|'automatic'|'scope';price_version:string;workpaper_points:number;document_points:number|null};
export type FileGenerationWorkspace={revision:number;preparation:FileGenerationPreparation;sets:FileTemplateSet[];builtin:{name:string;version:string;available:boolean};batches:FileGenerationBatch[];pricing?:FileGenerationPricing};
export type FileTemplateMatch={item_id:string;status:'suggested'|'multiple'|'missing';candidates:FileTemplatePin[];reason:string};
export type FileGenerationQuote={count:number;points:number;price_version:string;omitted:{id:string;code:string;title:string}[];auto_charge?:boolean;quote_status?:'ready'|'pending_scope';documents?:({document_type:Static<typeof M4DocumentTypeSchema>;draft_version:number;points:number}&CommercePriceMetadata)[]};
export const fileGenerationOpenApiPaths=()=>{
  const base='/api/v1/projects/{project_id}/file-generation';
  const route=(schema?:unknown)=>({security:[{sessionCookie:[]}],parameters:[{name:'project_id',in:'path',required:true,schema:{type:'string'}}],...(schema?{requestBody:{required:true,content:{'application/json':{schema}}}}:{}),responses:{200:{description:'Owner-scoped generation preparation'},404:{description:'Not found'}}});
  return {[base]:{get:route()},[base+'/progress']:{get:{...route(),responses:{200:{description:'Private opaque change token; no document content',content:{'application/json':{schema:GenerationProgressSchema}}},404:{description:'Not found'}}}},[base+'/preparation']:{put:route(FilePreparationSaveSchema)},[base+'/builtin']:{post:route(FileBuiltinAdoptSchema)},[base+'/quote']:{post:route(FileGenerationSubmitSchema)},[base+'/batches']:{post:route(FileGenerationSubmitSchema)},
    [base+'/stop-submission']:{post:route(FileGenerationSubmitSchema)},
    [base+'/templates/combine']:{post:route(FileTemplateCombineSchema)},
    [base+'/system-templates']:{get:route()},
    [base+'/template-preview']:{post:route(FileTemplatePinSchema)},
    [base+'/template-preview-pdf']:{post:route(FileTemplatePinSchema)},
    [base+'/templates/import']:{post:{...route(),parameters:[...route().parameters,...Object.entries(FileTemplateImportQuerySchema.properties).map(([name,schema])=>({name,in:'query',required:true,schema}))],requestBody:{required:true,content:{'application/octet-stream':{schema:{type:'string',format:'binary'}}}}}},
    [base+'/matches']:{get:{...route(),parameters:[...route().parameters,...Object.entries(FileTemplateMatchQuerySchema.properties).map(([name,schema])=>({name,in:'query',required:true,schema}))]}},
    [base+'/batches/{batch_id}']:{get:{...route(),parameters:[...route().parameters,{name:'batch_id',in:'path',required:true,schema:id}]}}
  };
};
