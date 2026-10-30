import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {expect,type Page,type Route} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {schemas} from '@bondbuddy/contracts';
import type {Dto} from './billing-fixture-wire';
import {assertFixture as assertTaskFixture,docx,downloadBytes,fixture as taskFixture,hash,ids as taskIds,
  install as installTaskFixture,mime,serverSnapshot,writes,type Variant} from './consistency-task-fixtures';

export {downloadBytes,type Variant};
export const ids={...taskIds,prospectusRun:'handoff-prospectus-run',prospectusVersion:'handoff-prospectus-v9',
  prospectusClean:'handoff-prospectus-clean',prospectusRevision:'handoff-prospectus-revision'};

// Literal expectations follow the producer's frozen inputs, independently of
// artifactFilename(). File operations use operation.filename + input_revision;
// ordinary prospectus outputs use the frozen project name. Neither uses the
// catalog sequence or the date on which the user downloads the file.
export const frozen={oldInputRevision:8,laterInputRevision:10,prospectusInputRevision:6,prospectusSequence:9,
  prospectusProject:'合成冻结募集书项目',
  runInputRevisions:{[ids.prospectusRun]:6,[ids.oldCheck]:7,[ids.oldRun]:8,[ids.newCheck]:9,[ids.laterRun]:10} as Record<string,number>,
  names:{
    [ids.oldClean]:'合成发行人基本情况_V1_清洁版_V8_20261025.docx',
    [ids.oldRevision]:'合成发行人基本情况_V1_修订版_V8_20261025.docx',
    [ids.laterClean]:'合成发行人基本情况_V2_清洁版_V10_20261025.docx',
    [ids.laterRevision]:'合成发行人基本情况_V2_修订版_V10_20261025.docx',
    [ids.prospectusClean]:'合成冻结募集书项目_募集书清洁版_V6_20260930.docx',
    [ids.prospectusRevision]:'合成冻结募集书项目_募集书修订版_V6_20260930.docx'
  } as Record<string,string>};
const prospectusTime='2026-09-30T07:00:00Z';

export function fixture(){
  const task=taskFixture();task.rootProject.name='合成当前项目名称';
  // Each check/patch allocates a fresh project input revision. Retain its own
  // successful receipt time rather than making every old task finish "now".
  for(const t of task.tasks)t.updated_at=t.created_at;
  for(const [id,stored] of task.artifacts){
    stored.metadata.filename=frozen.names[id];
    stored.metadata.display_version=frozen.runInputRevisions[stored.metadata.run_id];
  }
  const originalBytes=docx('用户原上传的募集说明书。保留原文件名与准确字节，不改成成果命名。');
  if(task.source.asset.kind!=='material')throw new Error('The adopted synthetic source must remain an uploaded material.');
  task.source.asset.pin.sha256=hash(originalBytes);
  const currentCheck=task.checks.find(c=>c.run_id===ids.newCheck)!;currentCheck.source=structuredClone(task.source);
  const material:Dto<'MaterialResponse'>={material_id:task.source.asset.pin.material_id,material_version:1,
    upload_id:'handoff-original-upload',role:'historical',filename:task.source.filename,media_type:mime,
    byte_size:originalBytes.length,sha256:hash(originalBytes),state:'persisted',persisted_at:prospectusTime,error:null};
  for(const [id,variant] of [[ids.prospectusClean,'clean'],[ids.prospectusRevision,'revision']] as const){
    const bytes=docx('合成募集书 '+variant+'。冻结的2026年9月交付，业务输入第6版。');
    task.artifacts.set(id,{bytes,metadata:{artifact_id:id,run_id:ids.prospectusRun,version:2,
      filename:frozen.names[id],display_version:frozen.prospectusInputRevision,media_type:mime,sha256:hash(bytes),
      quality_status:'passed',delivery_status:'available',download_url:'/api/v1/artifacts/'+id+'/download?grant=synthetic-task',
      expires_at:'2099-01-01T00:00:00Z'}});
  }
  task.tasks.push({run_id:ids.prospectusRun,project_id:ids.root,kind:'update',state:'succeeded',stage:'completed',
    created_at:prospectusTime,updated_at:prospectusTime,artifact_id:ids.prospectusClean,
    report_id:null,topic_id:null,document_type:null,operation:null});
  const clean=task.artifacts.get(ids.prospectusClean)!.metadata;
  const prospectus:Dto<'ProspectusVersionsResponse'>={project_id:ids.root,current_version_id:task.source.version_id,
    selection_revision:task.source.selection_revision,inactive_material_ids:[],versions:[
      {version_id:ids.prospectusVersion,sequence:frozen.prospectusSequence,origin:'generated',
        filename:'募集说明书清洁版.docx',sha256:clean.sha256,created_at:prospectusTime,
        material_id:null,material_version:null,artifact_id:ids.prospectusClean,artifact_version:2,
        revision_artifact_id:ids.prospectusRevision,run_id:ids.prospectusRun},
      {version_id:task.source.version_id,sequence:task.source.sequence,origin:'upload',filename:material.filename,
        sha256:material.sha256,created_at:material.persisted_at,material_id:material.material_id,
        material_version:material.material_version,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null}
    ]};
  return {task,material,originalBytes,prospectus,materialReads:[] as string[],materialByteReads:[] as string[]};
}
export type State=ReturnType<typeof fixture>;

function collection(s:State):Dto<'ProjectFilesResponse'>{
  const items:Dto<'ProjectFilesResponse'>['items']=s.task.files.map(v=>({
    file_id:v.asset.kind==='artifact'?v.asset.pin.artifact_id:v.asset.pin.material_id,
    file_key:'project-file:'+v.file_id,project_id:v.asset.pin.source_project_id,source:v.asset.kind,filename:v.filename,
    version:v.asset.kind==='artifact'?v.asset.pin.artifact_version:v.asset.pin.material_version,display_version:v.sequence,
    sha256:v.asset.pin.sha256,created_at:v.created_at,folder:'4.1',run_id:v.run_id,current:false,
    latest:v.latest,version_count:v.version_count}));
  // Match collectionFilesSql: standalone generated variants have separate keys
  // and canonical names, while registered project files keep their catalog name.
  for(const [id,variant] of [[ids.prospectusClean,'clean'],[ids.prospectusRevision,'revision']] as const){
    const a=s.task.artifacts.get(id)!.metadata;
    items.push({file_id:id,file_key:ids.root+':update:'+variant,project_id:ids.root,source:'artifact',
      filename:a.filename!,version:a.version,display_version:a.display_version!,sha256:a.sha256,created_at:prospectusTime,
      folder:'2',run_id:ids.prospectusRun,current:false,latest:true,version_count:1});
  }
  items.push({file_id:s.material.material_id,file_key:s.material.sha256+':historical',project_id:ids.root,source:'material',
    filename:s.material.filename,version:1,display_version:1,sha256:s.material.sha256,created_at:s.material.persisted_at,
    folder:'2',run_id:null,current:true,latest:true,version_count:1});
  return {project_id:ids.root,items};
}
function dto<K extends keyof typeof schemas>(route:Route,name:K,value:Dto<K>){
  expect(Value.Check(schemas[name],value),name+': '+JSON.stringify([...Value.Errors(schemas[name],value)])).toBe(true);
  return route.fulfill({status:200,json:fixtureBody(route,value)});
}
function run(s:State,id:string):Dto<'RunResponse'>{
  const task=s.task.tasks.find(t=>t.run_id===id);
  const artifactId=task?.artifact_id,inputRevision=frozen.runInputRevisions[id];
  if(!task||!artifactId||!inputRevision)throw new Error('Only a known successful delivery may be downloaded.');
  return {run_id:id,execution_request_id:'handoff-prior-'+id,project_id:ids.root,
    input_revision:inputRevision,input_hash:hash(id),
    state:'succeeded',stage:'completed',event_cursor:0,channel:'production',test_grant_id:null,uncovered_items:[],
    billing_mode:'fixed_credits',reservation_id:null,artifact_id:artifactId,prompt_snapshot_ref:null,updated_at:task.updated_at};
}

const installed=new WeakMap<Page,State>();
export async function install(page:Page,s=fixture()){
  expect(installed.has(page)).toBe(false);installed.set(page,s);
  // Keep the earlier owner-scoped, closed HTTP fixture as the sole fallback.
  // This overlay only adds explicit read projections needed by the three real
  // download entrances. Unknown requests still fail in the closed base fixture.
  await installTaskFixture(page,s.task);
  await page.context().route('**/api/v1/**',async route=>{
    if(await serveDisabledBillingCatalog(route))return;
    const req=route.request(),url=new URL(req.url()),path=url.pathname.slice('/api/v1'.length),method=req.method();
    if(method!=='GET')return route.fallback();
    const material=path.match(new RegExp('^/projects/'+ids.root+'/materials/([^/]+)(/download)?$'));
    const knownRun=path.match(/^\/runs\/([^/]+)$/);
    const handled=path===`/projects/${ids.root}/files`||path===`/projects/${ids.root}/prospectus-versions`
      ||material?.[1]===s.material.material_id||knownRun&&[ids.prospectusRun,ids.oldCheck,ids.oldRun,ids.newCheck,ids.laterRun].includes(knownRun[1]);
    if(!handled)return route.fallback();
    s.task.calls.push({method,path,search:url.search,body:null});
    try{
      if(path===`/projects/${ids.root}/files`)return dto(route,'ProjectFilesResponse',collection(s));
      if(path===`/projects/${ids.root}/prospectus-versions`)return dto(route,'ProspectusVersionsResponse',s.prospectus);
      if(knownRun)return dto(route,'RunResponse',run(s,knownRun[1]));
      if(material){
        expect(!url.searchParams.has('version')||url.searchParams.get('version')==='1').toBe(true);
        if(material[2]){s.materialByteReads.push(s.material.material_id);return route.fulfill({status:200,contentType:mime,body:s.originalBytes});}
        s.materialReads.push(s.material.material_id);return dto(route,'MaterialResponse',s.material);
      }
      throw new Error('Unreachable handoff fixture route.');
    }catch(error){
      s.task.errors.push(error instanceof Error?error.message:String(error));
      return route.fulfill({status:500,json:fixtureBody(route,{code:'DATA_UNAVAILABLE',message:'Synthetic handoff fixture failure',retryable:true,
        correlation_id:'handoff-test',field_errors:[]})});
    }
  });
  return s;
}
export async function openFiles(page:Page){
  await page.goto(`/#/projects/${ids.root}/files`);await expect(page.locator('#file-list')).toBeVisible();
  await expect(page.locator('.prospectus-panel')).toBeVisible();
}
export const snapshot=(s:State)=>structuredClone({business:serverSnapshot(s.task),prospectus:s.prospectus,material:s.material,
  artifacts:[...s.task.artifacts].map(([id,a])=>({id,metadata:a.metadata,sha256:hash(a.bytes)}))});
export async function assertFixture(page:Page){
  const s=installed.get(page);if(!s)return;
  await assertTaskFixture(page,s.task);expect(writes(s.task),'Archiving downloads must not execute, adopt, upload, or rename anything.').toEqual([]);
}
