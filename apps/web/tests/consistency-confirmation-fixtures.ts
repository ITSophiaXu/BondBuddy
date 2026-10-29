import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import {createHash} from 'node:crypto';
import {expect,type Page} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {PROJECT_DOCUMENT_CATALOG,PROJECT_FILE_UPDATE_PRICE,ProjectFileCheckSchema,ProjectFileVersionSchema,
  ProjectFileSourceSchema,schemas,resultFilename,type ProjectFileAsset,type ProjectFileCheck,type ProjectFileFinding,
  type ProjectFileVersion} from '@bondbuddy/contracts';
import type {Dto} from './billing-fixture-wire';
import {fixture as selectionFixture,install as installSelection,assertFixture as assertSelection,
  ids,base,cacheKey,fileIds,checkId,writes,serverSnapshot} from './consistency-selection-fixtures';
import {docx,now,mime} from './consistency-task-fixtures';

export {ids,base,cacheKey,fileIds,checkId,writes,serverSnapshot};
export const selectedVersions=[fileIds.issuer,fileIds.financial];
export const sharedFilename='合成同名关联文件[待核对].docx';
export const excludedFilename='合成另行保留的授信说明.docx';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

// Exact canonicalInputManifest semantics from api/src/production-rule-pin.ts:
// recursively sorted object keys, original array order, JSON primitives. Unlike
// the older UI fixture's symbolic hash, this hash is the actual result digest.
export function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}
export const resultHash=(result:unknown)=>hash(canonical(result));
export const typeName=(type:ProjectFileVersion['document_type'])=>PROJECT_DOCUMENT_CATALOG.find(d=>d.id===type)!.name;
const automatic=(f:ProjectFileFinding)=>f.kind==='conflict'&&f.replacement!==null;
const manual=(f:ProjectFileFinding)=>f.kind==='manual'||f.replacement===null;

export function fixture(options:{long?:boolean;manualUnlisted?:boolean;dropUpdateOnce?:boolean}={}){
  const s=selectionFixture({long:options.long,dropUpdateOnce:options.dropUpdateOnce});
  s.rootProject.name='合成募集书换版后的文件更新确认项目';
  const check=s.checks[0],current=[...s.files];
  const autoTemplate=structuredClone(check.result!.files[0].findings[0]);
  const manualTemplate=structuredClone(check.result!.files[0].findings[1]);
  for(const [index,file] of current.entries()){
    file.sequence=file.version_id===fileIds.issuer?2:file.version_id===fileIds.financial?4:1;
    file.version_count=file.sequence;
    file.filename=selectedVersions.includes(file.version_id)?sharedFilename:file.version_id===fileIds.credit?excludedFilename:'合成长清单_'+typeName(file.document_type)+'.docx';
    const result=check.result!.files.find(r=>r.file_version_id===file.version_id)!;
    const autoCount=file.version_id===fileIds.issuer?2:file.version_id===fileIds.financial?3:1;
    const manualCount=file.version_id===fileIds.issuer&&!options.manualUnlisted?1:0;
    result.findings=[...Array.from({length:autoCount},(_,i):ProjectFileFinding=>{
      const id='confirmation-'+file.document_type+'-automatic-'+(i+1);
      return {...structuredClone(autoTemplate),id,target_span_id:id+'-target',source_span_id:id+'-source',
        field:typeName(file.document_type)+'核对字段'+(i+1),period:'2025年度',unit:'万元',
        original:'合成'+file.document_type+'原文金额 '+(100+index*10+i),
        source_quote:'合成募集书同口径金额 '+(120+index*10+i),
        replacement:'合成'+file.document_type+'建议更新金额 '+(120+index*10+i),
        target_location:'合成'+typeName(file.document_type)+'第'+(3+i)+'页',source_location:'合成募集书第'+(12+i)+'页',
        reason:'合成'+file.document_type+'第'+(i+1)+'处：同期间同单位的金额与本轮募集书不同。'};
    }),...Array.from({length:manualCount},(_,i):ProjectFileFinding=>{
      const id='confirmation-'+file.document_type+'-manual-'+(i+1);
      return {...structuredClone(manualTemplate),id,target_span_id:id+'-target',source_span_id:null,
        field:'合成授信口径',original:'合成银行批复口径仍需业务人员核实。',replacement:null,source_quote:'',
        reason:'合成人工事项继续保留；生成自动修改稿不会把它记为处理完成。',kind:'manual'};
    })];
    result.status=options.manualUnlisted&&file.version_id===fileIds.issuer?'manual':'conflict';
    result.coverage='合成'+typeName(file.document_type)+'：本轮仅核对列出的金额与授信口径，不代表全文或专业验收。';
    file.consistency={status:'conflict',count:autoCount,check_run_id:checkId};
    // V2/V4 are real separate synthetic sequences, with the full preceding
    // immutable family history retained rather than merely relabeling V1.
    for(let sequence=1;sequence<file.sequence;sequence++){
      const id=file.version_id+'-history-'+sequence;
      s.files.push({...structuredClone(file),version_id:id,sequence,latest:false,
        asset:{kind:'material',pin:{source_project_id:ids.root,material_id:id+'-material',material_version:1,sha256:hash(id)}},
        consistency:{status:'unchecked',count:0,check_run_id:null}});
    }
  }
  check.files=current.map(v=>({file_id:v.file_id,file_version_id:v.version_id,filename:v.filename,sequence:v.sequence}));
  check.sha256=resultHash(check.result);
  if(options.manualUnlisted)s.projectionFaults.push('schema-allowed manual status with automatic findings but no supplied manual items; incomplete-detail defensive projection');
  const original={projectName:s.rootProject.name,check:structuredClone(check),files:structuredClone(current)};
  return Object.assign(s,{confirmationOptions:options,original,validatedNewEnvelopes:[] as {checkId:string;body:Dto<'ProjectFileUpdateRequest'>}[]});
}
export type State=ReturnType<typeof fixture>;
export function expected(s:State){
  return {...structuredClone(s.original),source:structuredClone(s.original.check.source),
    files:s.original.files.map(file=>{
      const result=s.original.check.result!.files.find(r=>r.file_version_id===file.version_id)!;
      return {...structuredClone(file),automatic:result.findings.filter(automatic).length,manual:result.findings.filter(manual).length,
        manualUnlisted:result.status==='manual'&&!result.findings.some(manual)};
    })};
}

function assertData(s:State){
  expect(Value.Check(ProjectFileSourceSchema,s.source),'Public source schema').toBe(true);
  expect(new Set(s.files.map(f=>f.version_id)).size).toBe(s.files.length);
  const current=s.files.filter(f=>f.latest);
  expect(new Set(current.map(f=>f.document_type)).size).toBe(current.length);
  for(const family of new Set(s.files.map(f=>f.file_id))){
    const history=s.files.filter(f=>f.file_id===family).sort((a,b)=>a.sequence-b.sequence);
    expect(history.filter(f=>f.latest)).toHaveLength(1);
    expect(new Set(history.map(f=>f.document_type)).size).toBe(1);
    expect(history.map(f=>f.sequence)).toEqual(Array.from({length:history.length},(_,i)=>i+1));
    for(const file of history){expect(file.version_count).toBe(history.length);expect(Value.Check(ProjectFileVersionSchema,file)).toBe(true);expect(file.asset.pin.source_project_id).toBe(ids.root);}
  }
  for(const check of s.checks){
    expect(Value.Check(ProjectFileCheckSchema,check),'Public check schema').toBe(true);
    expect(check.sha256).toBe(resultHash(check.result));
    expect(new Set(check.files.map(f=>f.file_version_id)).size).toBe(check.files.length);
    expect(check.result!.files.map(f=>f.file_version_id)).toEqual(check.files.map(f=>f.file_version_id));
    for(const input of check.files){const file=s.files.filter(f=>f.version_id===input.file_version_id);expect(file).toHaveLength(1);expect(file[0]).toMatchObject({file_id:input.file_id,filename:input.filename,sequence:input.sequence});}
    for(const update of check.updates){
      const input=check.files.find(f=>f.file_version_id===update.file_version_id)!;expect(input).toBeDefined();
      expect(s.tasks.some(t=>t.run_id===update.run_id&&t.state===update.state)).toBe(true);
      if(update.state!=='succeeded')continue;
      const output=s.files.filter(f=>f.version_id===update.new_version_id);expect(output).toHaveLength(1);
      expect(output[0]).toMatchObject({file_id:input.file_id,run_id:update.run_id,source_version_id:check.source.version_id,source_name:check.source.filename,source_sequence:check.source.sequence});
      for(const asset of [output[0].asset,output[0].revision_asset]){
        expect(asset?.kind).toBe('artifact');if(asset?.kind!=='artifact')continue;
        const stored=s.artifacts.get(asset.pin.artifact_id)!;expect(stored).toBeDefined();
        expect(stored.metadata).toMatchObject({artifact_id:asset.pin.artifact_id,run_id:update.run_id,version:asset.pin.artifact_version,sha256:asset.pin.sha256});
        expect(hash(stored.bytes)).toBe(asset.pin.sha256);
      }
    }
  }
}

const installed=new WeakMap<Page,State>();
export async function install(page:Page,s=fixture()){
  assertData(s);await installSelection(page,s);installed.set(page,s);
  // Layer only semantic checks over the original closed producer. The original
  // receipt-before-freshness ordering and its actual dropped response survive.
  await page.route('**/api/v1/**',async route=>{
    if(await serveDisabledBillingCatalog(route))return;
    try{
      const request=route.request(),url=new URL(request.url()),p=url.pathname.slice('/api/v1'.length);
      if(request.method()==='GET')assertData(s);
      if(request.method()==='GET'&&p===base+'/checks/'+checkId&&!s.checks.some(check=>check.run_id===checkId)){
        // This synthetic read projection does not expose an individually
        // readable old check. Its original receipt and immutable confirmation
        // remain available; do not recreate a check from that cached snapshot.
        s.calls.push({method:'GET',path:p,search:url.search,body:null});
        return route.fulfill({status:404,json:fixtureBody(route,{code:'NOT_FOUND',message:'Synthetic original check is not individually readable',retryable:false,correlation_id:'consistency-confirmation',field_errors:[]})});
      }
      if(request.method()==='POST'&&p===base+'/checks/'+checkId+'/updates'){
        const body=fixtureRequest(request) as Dto<'ProjectFileUpdateRequest'>;
        const prior=s.receipts.get(body.request_id);
        if(prior)expect({checkId,body}).toEqual(prior.post);
        else{
          const check=s.checks.find(c=>c.run_id===checkId)!;expect(check).toBeDefined();
          expect(body.expected_check_sha256).toBe(resultHash(check.result));
          expect(body.expected_points).toBe(body.files.length*PROJECT_FILE_UPDATE_PRICE.points);
          s.validatedNewEnvelopes.push({checkId,body:structuredClone(body)});
        }
      }
    }catch(error){s.errors.push(error instanceof Error?error.message:String(error));return route.fulfill({status:500,json:fixtureBody(route,{code:'DATA_UNAVAILABLE',message:'Synthetic confirmation producer assertion failed',retryable:true,correlation_id:'consistency-confirmation',field_errors:[]})});}
    return route.fallback();
  });
  return s;
}
export async function open(page:Page,s=fixture(),entry:'check'|'files'='check'){
  await page.setViewportSize({width:1440,height:960});await install(page,s);
  await page.goto(entry==='files'?`/#/projects/${ids.root}/files`:`/#consistency?project=${ids.root}&run=${checkId}&return_project=${ids.root}`);
  await expect(page.locator(entry==='files'?'#file-list':'.fc-results')).toBeVisible();return s;
}
export async function assertFixture(page:Page){const s=installed.get(page);if(s){assertData(s);await assertSelection(page);}}

export function completeReceipt(s:State,requestId:string){
  const receipt=s.receipts.get(requestId)!;expect(receipt).toBeDefined();
  const check=s.checks.find(c=>c.run_id===receipt.post.checkId)!;expect(check).toBeDefined();
  const batch=s.batches.find(b=>b.batch_id===receipt.batchId)!;expect(batch).toBeDefined();
  const completedAt='2026-10-26T03:00:00Z';
  for(const [index,selection] of receipt.post.body.files.entries()){
    const input=s.files.find(f=>f.version_id===selection.file_version_id)!;
    const runId='confirmation-'+input.document_type+'-delivered-run',next=input.sequence+1;
    const asset=(variant:'clean'|'revision'):ProjectFileAsset=>{
      const id=runId+'-'+variant,bytes=docx('明确合成 '+typeName(input.document_type)+' '+variant+'；原V'+input.sequence+'更新后V'+next+'，人工事项仍保留。');
      const metadata:Dto<'ArtifactResponse'>={artifact_id:id,run_id:runId,version:1,
        filename:resultFilename({project:input.filename.replace(/\.docx$/i,''),kind:variant==='revision'?'修订版':'清洁版',version:1,createdAt:completedAt,mediaType:mime}),
        display_version:1,media_type:mime,sha256:hash(bytes),quality_status:'passed',delivery_status:'available',
        download_url:'/api/v1/artifacts/'+id+'/download?grant=synthetic-task',expires_at:'2099-01-01T00:00:00Z'};
      expect(Value.Check(schemas.ArtifactResponse,metadata)).toBe(true);s.artifacts.set(id,{metadata,bytes});
      return {kind:'artifact',pin:{source_project_id:ids.root,artifact_id:id,artifact_version:1,sha256:metadata.sha256}};
    };
    for(const version of s.files.filter(f=>f.file_id===input.file_id)){version.latest=false;version.version_count=next;}
    const result=check.result!.files.find(f=>f.file_version_id===input.version_id)!;
    const output:ProjectFileVersion={...structuredClone(input),version_id:input.version_id+'-delivered',sequence:next,latest:true,version_count:next,
      asset:asset('clean'),revision_asset:asset('revision'),created_at:completedAt,run_id:runId,
      source_version_id:check.source.version_id,source_name:check.source.filename,source_sequence:check.source.sequence,
      consistency:{status:result.findings.some(manual)?'manual':'updated',count:0,check_run_id:checkId}};
    s.files.push(output);check.updates.push({file_version_id:input.version_id,issue_ids:result.findings.filter(automatic).map(f=>f.id),run_id:runId,state:'succeeded',new_version_id:output.version_id});
    s.tasks.unshift({...structuredClone(s.tasks[0]),run_id:runId,state:'succeeded',stage:'completed',operation:'file_patch',document_type:input.document_type,artifact_id:output.asset.kind==='artifact'?output.asset.pin.artifact_id:null,created_at:completedAt,updated_at:completedAt});
    batch.items[index].run_id=runId;
  }
  batch.state='complete';assertData(s);
}

export function changeLive(s:State){
  const old=s.source;Object.assign(old,{version_id:'confirmation-new-current-source',sequence:old.sequence+1,selection_revision:old.selection_revision+1,
    filename:'合成后来采用的新募集书.docx',asset:{kind:'material',pin:{source_project_id:ids.root,material_id:'confirmation-new-source-material',material_version:1,sha256:hash('new-source')}}});
  for(const check of s.checks)check.stale=true;
  const prior=s.files.find(f=>f.file_id===s.original.files.find(f=>f.version_id===fileIds.financial)!.file_id&&f.latest)!,next=prior.sequence+1;
  for(const file of s.files.filter(f=>f.file_id===prior.file_id)){file.latest=false;file.version_count=next;}
  s.files.push({...structuredClone(prior),version_id:prior.version_id+'-later-manual-save',sequence:next,latest:true,version_count:next,
    filename:'合成后来保存的财务新稿.docx',run_id:null,revision_asset:null,
    asset:{kind:'material',pin:{source_project_id:ids.root,material_id:'confirmation-later-financial-material',material_version:1,sha256:hash('later-financial')}},
    source_version_id:old.version_id,source_name:old.filename,source_sequence:old.sequence,consistency:{status:'unchecked',count:0,check_run_id:null}});
  assertData(s);
}

export function forgetOriginalCheck(s:State){
  // Only the recent-list projection forgets the original. Its server receipt,
  // immutable original input, historical output and task still exist.
  const original=s.original.check,latest=s.files.filter(f=>f.latest),newId='confirmation-newer-check';
  const newer:ProjectFileCheck={...structuredClone(original),run_id:newId,source:structuredClone(s.source),stale:false,updates:[],created_at:'2026-10-26T04:00:00Z',
    files:latest.map(f=>({file_id:f.file_id,file_version_id:f.version_id,filename:f.filename,sequence:f.sequence})),
    result:{version:'project-file-check-v1',files:latest.map(f=>{
      const prior=original.result!.files.find(r=>original.files.find(input=>input.file_version_id===r.file_version_id)?.file_id===f.file_id)!;
      return {...structuredClone(prior),file_version_id:f.version_id,findings:prior.findings.map(i=>({...i,id:'newer-'+i.id,reason:'合成后来检查的不同范围，不得冒作原确认。'}))};
    })}};
  newer.sha256=resultHash(newer.result);s.checks=[newer];
  s.tasks.unshift({...structuredClone(s.tasks.find(t=>t.run_id===checkId)!),run_id:newId,created_at:newer.created_at,updated_at:newer.created_at});
  assertData(s);
}
