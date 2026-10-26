import { Type, type Static } from '@sinclair/typebox';
import { PROJECT_DOCUMENT_CATALOG } from './project-document-catalog.js';
import { M4MaterialPinSchema, M4ArtifactPinSchema } from './m4-workspace.js';

const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const hash=Type.String({pattern:'^[a-f0-9]{64}$'});
const text=Type.String({maxLength:12000});
const short=Type.String({maxLength:200});
const nullable=<T extends Parameters<typeof Type.Union>[0][number]>(s:T)=>Type.Union([s,Type.Null()]);
export const PROJECT_FILE_UPDATE_PRICE={points:4500,version:'project-file-update-4500-v1'} as const;
export const ProjectDocumentTypeSchema=Type.Union(PROJECT_DOCUMENT_CATALOG.map(d=>Type.Literal(d.id)));
export const ProjectFileAssetSchema=Type.Union([
  obj({kind:Type.Literal('material'),pin:M4MaterialPinSchema}),
  obj({kind:Type.Literal('artifact'),pin:M4ArtifactPinSchema}),
]);
export type ProjectFileAsset=Static<typeof ProjectFileAssetSchema>;
export const ProjectFileSpanSchema=obj({id,text,location:text,sha256:hash});
export const ProjectFileTextSchema=obj({version:Type.Literal('project-file-text-v1'),sha256:hash,
  format:Type.Union([Type.Literal('docx'),Type.Literal('pdf')]),spans:Type.Array(ProjectFileSpanSchema,{maxItems:100000}),
  warnings:Type.Array(text,{maxItems:2000}),coverage:Type.Union([Type.Literal('complete'),Type.Literal('partial')])});
export type ProjectFileText=Static<typeof ProjectFileTextSchema>;
export const ProjectFileLinkSchema=obj({source_span_id:id,source_quote:text,target_span_id:id,target_quote:text,
  field:short,period:short,unit:short,source_location:text,target_location:text,source_sha256:hash,target_sha256:hash});
export type ProjectFileLink=Static<typeof ProjectFileLinkSchema>;
export const ProjectFileFindingSchema=obj({id,target_span_id:id,original:text,replacement:nullable(text),
  source_span_id:nullable(id),source_quote:text,source_location:text,target_location:text,reason:text,
  field:short,period:short,unit:short,kind:Type.Union([Type.Literal('conflict'),Type.Literal('manual')])});
export type ProjectFileFinding=Static<typeof ProjectFileFindingSchema>;
export const ProjectFileCheckResultSchema=obj({version:Type.Literal('project-file-check-v1'),
  files:Type.Array(obj({file_version_id:id,status:Type.Union([Type.Literal('consistent'),Type.Literal('conflict'),Type.Literal('manual')]),
    coverage:text,findings:Type.Array(ProjectFileFindingSchema,{maxItems:2000}),links:Type.Array(ProjectFileLinkSchema,{maxItems:10000})}),{maxItems:200})});
export type ProjectFileCheckResult=Static<typeof ProjectFileCheckResultSchema>;
export const ProjectFileSourceSchema=obj({project_id:id,version_id:id,selection_revision:Type.Integer({minimum:0}),
  filename:short,sequence:Type.Integer({minimum:1}),asset:ProjectFileAssetSchema});
export type ProjectFileSource=Static<typeof ProjectFileSourceSchema>;
export const ProjectFileCheckInputSchema=obj({version:Type.Literal('project-file-operation-v1'),operation:Type.Literal('check'),source:ProjectFileSourceSchema,
  files:Type.Array(obj({file_id:id,file_version_id:id,filename:short,sequence:Type.Integer({minimum:1}),
    asset:ProjectFileAssetSchema,links:Type.Array(ProjectFileLinkSchema,{maxItems:10000})}),{minItems:1,maxItems:200})});
export const ProjectFilePatchInputSchema=obj({version:Type.Literal('project-file-operation-v1'),operation:Type.Literal('patch'),source:ProjectFileSourceSchema,
  check_run_id:id,check_sha256:hash,file_id:id,file_version_id:id,expected_current_version_id:id,filename:short,asset:ProjectFileAssetSchema,
  findings:Type.Array(ProjectFileFindingSchema,{minItems:1,maxItems:2000}),manual_findings:Type.Optional(Type.Array(ProjectFileFindingSchema,{maxItems:2000}))});
export const ProjectFileOperationSchema=Type.Union([ProjectFileCheckInputSchema,ProjectFilePatchInputSchema]);
export type ProjectFileOperation=Static<typeof ProjectFileOperationSchema>;
export const projectFileSchemas={
  ProjectFileWorkspaceRequest:obj({request_id:id}),
  ProjectFileSourceRequest:obj({source_version_id:id,expected_selection_revision:Type.Integer({minimum:0})}),
  ProjectFileImportRequest:obj({request_id:id,document_type:ProjectDocumentTypeSchema,material:M4MaterialPinSchema,expected_latest_version_id:nullable(id)}),
  ProjectFileBatchRequest:obj({request_id:id,source_version_id:id,expected_selection_revision:Type.Integer({minimum:0}),
    documents:Type.Array(obj({document_type:ProjectDocumentTypeSchema,draft_version:Type.Integer({minimum:1})}),{minItems:1,maxItems:12})}),
  ProjectFileCheckRequest:obj({request_id:id,expected_source_version_id:id}),
  ProjectFileBatchActionRequest:obj({action:Type.Union([Type.Literal('retry'),Type.Literal('cancel')])}),
  ProjectFileUpdateRequest:obj({request_id:id,expected_check_sha256:hash,
    price_version:Type.Literal(PROJECT_FILE_UPDATE_PRICE.version),expected_points:Type.Integer({minimum:4500,maximum:900000}),
    files:Type.Array(obj({file_version_id:id}),{minItems:1,maxItems:200})}),
};

export type ProjectFileVersion=Static<typeof ProjectFileVersionSchema>;
export type ProjectFileBatch=Static<typeof ProjectFileBatchSchema>;
export type ProjectFileCheck=Static<typeof ProjectFileCheckSchema>;

const status=Type.Union((['unchecked','checking','conflict','manual','consistent','stale','updated'] as const).map(s=>Type.Literal(s)));
export const ProjectFileVersionSchema=obj({version_id:id,file_id:id,document_type:ProjectDocumentTypeSchema,filename:short,sequence:Type.Integer({minimum:1}),
 asset:ProjectFileAssetSchema,revision_asset:nullable(ProjectFileAssetSchema),source_version_id:nullable(id),template_id:nullable(id),template_version:nullable(Type.Integer({minimum:1})),
 source_name:nullable(short),source_sequence:nullable(Type.Integer({minimum:1})),created_at:Type.String(),run_id:nullable(id),links:Type.Array(ProjectFileLinkSchema),
 latest:Type.Boolean(),version_count:Type.Integer({minimum:1}),consistency:obj({status,count:Type.Integer({minimum:0}),check_run_id:nullable(id)})});
export const ProjectFileBatchSchema=obj({batch_id:id,state:Type.Union((['queued','running','paused','complete','cancelled'] as const).map(s=>Type.Literal(s))),
 items:Type.Array(obj({document_type:ProjectDocumentTypeSchema,run_id:nullable(id),state:Type.String(),error:nullable(text)}))});
export const ProjectFileCheckSchema=obj({run_id:id,state:Type.String(),stage:Type.String(),created_at:Type.String(),source:ProjectFileSourceSchema,stale:Type.Boolean(),
 sha256:nullable(hash),result:nullable(ProjectFileCheckResultSchema),files:Type.Array(obj({file_id:id,file_version_id:id,filename:short,sequence:Type.Integer({minimum:1})})),
 updates:Type.Array(obj({file_version_id:id,issue_ids:Type.Array(id),run_id:nullable(id),state:Type.String(),new_version_id:nullable(id)}))});
export type ProjectFileWorkspace={project_id:string;source:ProjectFileSource|null;workspace:import('./m4-workspace.js').M4Workspace;files:ProjectFileVersion[];batches:ProjectFileBatch[]};
export type ProjectFileUpdateBatches={batches:{batch_id:string;state:string;items:{file_version_id:string;filename:string;run_id:string|null;error:string|null}[]}[]};
export function projectFileOpenApiPaths(){
 const route=(method:string,description:string,body:unknown,response:unknown,extra?:string)=>({[method]:{description,security:[{sessionCookie:[]}],
   parameters:[{name:'project_id',in:'path',required:true,schema:id},...(extra?[{name:extra,in:'path',required:true,schema:id}]:[])],
   ...(body?{requestBody:{required:true,content:{'application/json':{schema:body}}}}:{}),
   responses:{200:{description:'Success',...(response?{content:{'application/json':{schema:response}}}:{})},404:{description:'Not found or not owned'},409:{description:'Version, active task or idempotency conflict'},422:{description:'Required source or template missing'}}}});
 const base='/api/v1/projects/{project_id}/project-files',files=obj({files:Type.Array(ProjectFileVersionSchema)});
 return {
   [base]:route('get','Immutable project file versions with current-source consistency status',null,files),
   [base+'/workspace']:{...route('get','Project source, reusable M4 templates and drafts, files and durable batches',null,null),...route('post','Prepare project file workspace without starting a model or charging',projectFileSchemas.ProjectFileWorkspaceRequest,null)},
   [base+'/source']:route('post','Pin current project prospectus in file drafts',projectFileSchemas.ProjectFileSourceRequest,null),
   [base+'/batches']:route('post','Persist frozen template-backed generation package',projectFileSchemas.ProjectFileBatchRequest,ProjectFileBatchSchema),
   [base+'/batches/{batch_id}/actions']:route('post','Explicitly retry unfinished generation or stop later files',projectFileSchemas.ProjectFileBatchActionRequest,null,'batch_id'),
   [base+'/imports']:route('post','Append owned historical file or new edition; retain old bytes',projectFileSchemas.ProjectFileImportRequest,files),
   [base+'/checks']:{...route('get','Checks against pinned prospectus versions and accepted changes',null,obj({checks:Type.Array(ProjectFileCheckSchema)})),
     ...route('post','Check latest project files against current prospectus',projectFileSchemas.ProjectFileCheckRequest,obj({run_id:id}))},
   [base+'/checks/{run_id}']:route('get','Read one owned project check by its exact run, including checks outside the recent list',null,obj({check:ProjectFileCheckSchema}),'run_id'),
   [base+'/checks/{run_id}/updates']:route('post','Generate tracked/clean versions for selected files, 4500 credits per file on delivery; reject stale inputs',projectFileSchemas.ProjectFileUpdateRequest,obj({batch_id:id}),'run_id'),
   [base+'/updates']:route('get','Pending and completed accepted update packages',null,null),
   [base+'/updates/{run_id}/cancel']:route('post','Stop later files; started runs and successful outputs stay available',null,obj({ok:Type.Boolean()}),'run_id'),
   [base+'/updates/{run_id}/retry']:route('post','Retry unfinished files after funding or task recovery; successful files are not charged again',null,obj({ok:Type.Boolean()}),'run_id')
 };
}

