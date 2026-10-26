import {expect,type Page} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {PROJECT_DOCUMENT_CATALOG,PROJECT_FILE_UPDATE_PRICE,projectFileSchemas,type ProjectFileFinding,type ProjectFileVersion} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import {fixture as taskFixture,install as installTask,assertFixture as assertTask,
  ids,base,cacheKey,hash,now,serverSnapshot} from './consistency-task-fixtures';

export {ids,base,cacheKey,serverSnapshot};
export const fileIds={issuer:'consistency-selection-issuer-v1',financial:'consistency-selection-financial-v1',credit:'consistency-selection-credit-v1'};
export const checkId=ids.newCheck;
type UpdatePost={checkId:string;body:Dto<'ProjectFileUpdateRequest'>};
type Receipt={post:UpdatePost;batchId:string};

// Extend the existing closed, schema-checked producer. One current family per
// document_type follows bb_project_files' UNIQUE(project_id,document_type).
// The long list uses all twelve real catalogue types, not duplicate fake families.
export function fixture(options:{long?:boolean;nullManual?:boolean;dropUpdateOnce?:boolean}={}){
  const s=taskFixture(),template=structuredClone(s.files[0]);
  s.rootProject.name='合成文件选择与人工事项项目';
  const types=options.long?['issuer','financial','credit',...PROJECT_DOCUMENT_CATALOG.map(d=>d.id).filter(id=>!['issuer','financial','credit'].includes(id))] as ProjectFileVersion['document_type'][]:['issuer','financial','credit'] as ProjectFileVersion['document_type'][];
  const files=types.map((type):ProjectFileVersion=>{
    const id='consistency-selection-'+type,attention=['issuer','financial','credit'].includes(type);
    return {...structuredClone(template),version_id:id+'-v1',file_id:id+'-family',document_type:type,
      filename:'合成'+PROJECT_DOCUMENT_CATALOG.find(d=>d.id===type)!.name+'.docx',sequence:1,
      asset:{kind:'material',pin:{source_project_id:ids.root,material_id:id+'-material',material_version:1,sha256:hash(id+'-material')}},
      revision_asset:null,run_id:null,latest:true,version_count:1,source_version_id:s.source.version_id,
      source_name:s.source.filename,source_sequence:s.source.sequence,created_at:now,
      // The real checker cannot call a file consistent with no findings AND no
      // verified links. Keep an explicit matching synthetic evidence link.
      links:attention?[]:[{source_span_id:id+'-source-span',target_span_id:id+'-target-span',
        source_quote:'合成2025年度同口径数值120万元',target_quote:'合成2025年度同口径数值120万元',
        field:'合成财务数据',period:'2025年度',unit:'万元',source_location:'合成募集书第12页',target_location:'合成文件第3页',
        source_sha256:hash('合成2025年度同口径数值120万元'),target_sha256:hash('合成2025年度同口径数值120万元')}],
      consistency:{status:type==='credit'?'manual':attention?'conflict':'consistent',count:type==='issuer'||type==='financial'?1:0,check_run_id:checkId}};
  });
  const conflictTemplate=structuredClone(s.checks[0].result!.files[0].findings[0]);
  const manualTemplate=structuredClone(s.checks[0].result!.files[1].findings[0]);
  const finding=(type:string,manual=false):ProjectFileFinding=>{
    const id='consistency-selection-'+type+(manual?'-manual':'-conflict');
    return {...structuredClone(manual?manualTemplate:conflictTemplate),id,target_span_id:id+'-target',
      source_span_id:manual?null:id+'-source',field:manual?'合成授信口径':'合成财务数据',period:'2025年度',
      original:manual?'合成人工待核：授信口径与银行证明尚未逐项确认。':'合成原文件数值 100',
      source_quote:manual?'':'合成募集书数值 120',replacement:manual?null:'合成本轮建议数值 120',
      reason:manual?'仍需人工确认授信口径及补充依据；自动更新可确认差异不会消除本事项。':'与本轮固定募集书的同期间披露数值不同。',
      kind:manual?'manual':'conflict'};
  };
  const check=structuredClone(s.checks[0]);
  check.run_id=checkId;check.source=structuredClone(s.source);check.stale=false;check.sha256=hash('consistency-selection-check-result');check.updates=[];
  check.files=files.map(v=>({file_id:v.file_id,file_version_id:v.version_id,filename:v.filename,sequence:v.sequence}));
  check.result={version:'project-file-check-v1',files:files.map(v=>({file_version_id:v.version_id,
    status:v.document_type==='credit'?(options.nullManual?'conflict':'manual'):['issuer','financial'].includes(v.document_type)?'conflict':'consistent',
    coverage:'明确标记的合成文件选择检查范围；不代表专业验收。',links:structuredClone(v.links),
    findings:v.document_type==='issuer'?[finding('issuer'),finding('issuer',true)]:v.document_type==='financial'?[finding('financial')]:v.document_type==='credit'?[{...finding('credit',true),kind:options.nullManual?'conflict':'manual'}]:[]}))};
  s.files=files;s.checks=[check];s.batches=[];
  s.tasks=s.tasks.filter(t=>t.run_id===checkId);s.artifacts.clear();
  // Deliberately defensive projection: the public schema permits conflict/null,
  // while verifiedFileCheck normally normalizes such a finding to kind=manual.
  // This option tests conservative rendering, not a normal worker output claim.
  if(options.nullManual)s.projectionFaults.push('schema-allowed conflict/null replacement; normal worker output is manual');
  return Object.assign(s,{options,posts:[] as UpdatePost[],receipts:new Map<string,Receipt>(),dropRemaining:!!options.dropUpdateOnce});
}
export type State=ReturnType<typeof fixture>;
const installed=new WeakMap<Page,State>();
export const writes=(s:State)=>s.calls.filter(call=>call.method!=='GET');
export const routeFor=()=>`/#consistency?project=${ids.root}&run=${checkId}&return_project=${ids.root}`;
export const fileRoute=()=>`/#/projects/${ids.root}/files`;

export function replaceCurrent(s:State,version=fileIds.issuer){
  const previous=s.files.find(v=>v.version_id===version)!;expect(previous.latest).toBe(true);previous.latest=false;previous.version_count=2;
  const current:ProjectFileVersion={...structuredClone(previous),version_id:version.replace(/-v1$/,'-v2'),sequence:2,latest:true,
    asset:{kind:'material',pin:{source_project_id:ids.root,material_id:version+'-saved-v2-material',material_version:1,sha256:hash(version+'-saved-v2-material')}},
    consistency:{status:'unchecked',count:0,check_run_id:null}};
  s.files.push(current);return current;
}
export function changeSource(s:State){s.source.version_id='consistency-selection-source-v4';s.source.sequence=4;s.source.selection_revision++;s.source.filename='合成当前募集说明书_V4.docx';s.source.asset={kind:'material',pin:{source_project_id:ids.root,material_id:'consistency-selection-source-v4-material',material_version:1,sha256:hash('consistency-selection-source-v4-material')}};s.checks[0].stale=true;}

export async function install(page:Page,s=fixture()){
  await installTask(page,s);installed.set(page,s);
  // Override only this round's explicit update endpoint; all reads, identity,
  // collection projections and unexpected-request checks remain in the producer.
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length),match=path.match(new RegExp('^'+base+'/checks/([^/]+)/updates$'));
    if(request.method()!=='POST'||!match)return route.fallback();
    const body=request.postDataJSON() as Dto<'ProjectFileUpdateRequest'>;
    s.calls.push({method:'POST',path,search:url.search,body:structuredClone(body)});
    try{
      expect(Value.Check(projectFileSchemas.ProjectFileUpdateRequest,body),'Existing public update request schema').toBe(true);
      const post={checkId:decodeURIComponent(match[1]),body:structuredClone(body)};s.posts.push(post);
      const original=s.receipts.get(body.request_id);
      if(original){expect(post,'A retry keeps the whole original envelope').toEqual(original.post);return route.fulfill({status:200,json:{batch_id:original.batchId}});}
      expect(post.checkId).toBe(checkId);expect(body.expected_check_sha256).toBe(s.checks[0].sha256);
      expect(body.price_version).toBe(PROJECT_FILE_UPDATE_PRICE.version);expect(body.expected_points).toBe(body.files.length*PROJECT_FILE_UPDATE_PRICE.points);
      expect(new Set(body.files.map(v=>v.file_version_id)).size).toBe(body.files.length);
      for(const entry of body.files){
        const checked=s.checks[0].files.find(f=>f.file_version_id===entry.file_version_id),result=s.checks[0].result!.files.find(f=>f.file_version_id===entry.file_version_id);
        expect(checked).toBeDefined();expect(s.files.find(f=>f.file_id===checked!.file_id&&f.latest)?.version_id).toBe(entry.file_version_id);
        expect(result!.findings.some(f=>f.kind==='conflict'&&f.replacement!==null),'Manual-only files never enter an update').toBe(true);
      }
      const batchId='consistency-selection-batch-'+(s.receipts.size+1);s.receipts.set(body.request_id,{post:structuredClone(post),batchId});
      s.batches.push({batch_id:batchId,state:'queued',items:body.files.map(v=>({file_version_id:v.file_version_id,filename:s.files.find(f=>f.version_id===v.file_version_id)!.filename,run_id:null,error:null}))});
      if(s.dropRemaining){s.dropRemaining=false;return route.abort('connectionreset');}
      return route.fulfill({status:200,json:{batch_id:batchId}});
    }catch(error){s.errors.push(error instanceof Error?error.message:String(error));return route.fulfill({status:500,json:{code:'DATA_UNAVAILABLE',message:'Synthetic fixture assertion failed',retryable:true,correlation_id:'consistency-selection',field_errors:[]}});}
  });
  return s;
}
export async function open(page:Page,s=fixture(),entry:'check'|'files'='check'){
  await page.setViewportSize({width:1440,height:960});await install(page,s);await page.goto(entry==='files'?fileRoute():routeFor());
  await expect(page.locator(entry==='files'?'#file-list':'.fc-results')).toBeVisible();return s;
}
export async function assertFixture(page:Page){const s=installed.get(page);if(s)await assertTask(page,s);}
