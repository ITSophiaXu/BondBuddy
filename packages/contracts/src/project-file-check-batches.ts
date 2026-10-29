import {Type,type Static} from '@sinclair/typebox';
import {Int64Schema} from './billing-integers.js';
import {ProjectFileSourceSchema} from './project-file-workspace.js';
const id=Type.String({minLength:1,maxLength:128});
const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const nullableId=Type.Union([id,Type.Null()]);
const selection={request_id:id,expected_source_version_id:id,expected_source_selection_revision:Type.Integer({minimum:0}),
  file_version_ids:Type.Optional(Type.Array(id,{minItems:1,maxItems:100,uniqueItems:true}))};
const admissionVersion=Type.String({minLength:1,maxLength:128,description:'Admission catalog/recovery tag only. Each item retains its actual quoted price_version; price_versions lists those immutable versions.'});
const item={file_version_id:id,filename:Type.String(),price_version:id,points:Int64Schema,scope_quote_id:nullableId,reused_run_id:nullableId};
export const FileCheckBatchSchema=obj({batch_id:id,request_id:id,source:ProjectFileSourceSchema,created_at:Type.String(),price_version:admissionVersion,price_versions:Type.Array(id,{minItems:1,maxItems:200,uniqueItems:true}),points:Int64Schema,charged_points:Int64Schema,
  state:Type.Union(['queued','running','complete','partial','failed'].map(v=>Type.Literal(v))),
  items:Type.Array(obj({...item,run_id:id,state:Type.String(),attempt:Type.Integer({minimum:0,description:'0 for a reused result; otherwise the current child attempt number'}),charged_points:Int64Schema}),{maxItems:200})});
export const projectFileCheckBatchSchemas={
  FileCheckBatchQuoteRequest:obj(selection),
  FileCheckBatchQuoteResponse:obj({source:ProjectFileSourceSchema,points:Int64Schema,price_version:admissionVersion,price_versions:Type.Array(id,{minItems:1,maxItems:200,uniqueItems:true}),auto_charge:Type.Literal(true),
    items:Type.Array(obj({...item,quote_status:Type.String()}),{minItems:1,maxItems:200})}),
  FileCheckBatchCreateRequest:obj({...selection,file_version_ids:Type.Array(id,{minItems:1,maxItems:100,uniqueItems:true}),expected_points:Int64Schema,price_version:id,
    scopes:Type.Array(obj({file_version_id:id,scope_quote_id:nullableId}),{minItems:1,maxItems:100})}),
  FileCheckBatchRetryRequest:obj({request_id:id,price_version:id,expected_points:Int64Schema,expected_attempts:Type.Array(obj({file_version_id:id,run_id:id}),{minItems:1,maxItems:100})}),
  FileCheckBatchResponse:FileCheckBatchSchema,
  FileCheckBatchListResponse:obj({batches:Type.Array(FileCheckBatchSchema,{maxItems:30})}),
};
export type FileCheckBatch=Static<typeof FileCheckBatchSchema>;
export type FileCheckBatchQuoteRequest=Static<typeof projectFileCheckBatchSchemas.FileCheckBatchQuoteRequest>;
export type FileCheckBatchQuote=Static<typeof projectFileCheckBatchSchemas.FileCheckBatchQuoteResponse>;
export type FileCheckBatchCreate=Static<typeof projectFileCheckBatchSchemas.FileCheckBatchCreateRequest>;
export type FileCheckBatchRetry=Static<typeof projectFileCheckBatchSchemas.FileCheckBatchRetryRequest>;
export function projectFileCheckBatchOpenApiPaths(){
  const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
  const op=(summary:string,response:string,request?:string)=>({summary,security:[{sessionCookie:[]}],
    ...(request?{requestBody:{required:true,content:{'application/json':{schema:ref(request)}}}}:{}),
    responses:{200:{description:'Owned per-file check batch; all money is decimal integer text',content:{'application/json':{schema:ref(response)}}}}});
  const base='/projects/{project_id}/project-files/check-batches',project=[{name:'project_id',in:'path',required:true,schema:{type:'string'}}],batch=[...project,{name:'batch_id',in:'path',required:true,schema:{type:'string'}}];
  return{[base+'/quote']:{parameters:project,post:op('按所选各文件锁定独立检查价格','FileCheckBatchQuoteResponse','FileCheckBatchQuoteRequest')},
    [base]:{parameters:project,get:op('读取近期逐份检查批次','FileCheckBatchListResponse'),post:op('原子预留全部所选文件，独立交付与结算','FileCheckBatchResponse','FileCheckBatchCreateRequest')},
    [base+'/{batch_id}']:{parameters:batch,get:op('读取原逐份检查批次','FileCheckBatchResponse')},
    [base+'/{batch_id}/retry']:{parameters:batch,post:op('按原价仅重试明确失败或取消的文件','FileCheckBatchResponse','FileCheckBatchRetryRequest')}};
}
