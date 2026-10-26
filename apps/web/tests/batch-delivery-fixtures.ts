import {expect,type Page,type Route} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {M4_DOCUMENT_BILLING_TASKS,M4DocumentManifestSchema,PROJECT_DOCUMENT_CATALOG,ProjectFileBatchSchema,ProjectFileVersionSchema,projectFileSchemas,schemas,
  type M4Artifact,type M4DocumentType,type M4Task,type ProjectFileBatch,type ProjectFileVersion,type ProjectFileWorkspace,type Run} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import type {FileGenerationBatchRequest} from '../src/file-generation-cache';
import {assertFixture,fixture,ids,mime,now,type State as EntryState} from './generation-entry-fixtures';
import {docx,hash} from './word-roundtrip-fixtures';

// A narrow extension of the sealed entry fixture: real routes and public HTTP
// projections, synthetic serial task progress and immutable small OOXML bytes.
// It does not run a worker/model, settle credits or prove external persistence.
export const types:M4DocumentType[]=['init','underwriter','legal'];
export const label=(type:M4DocumentType)=>PROJECT_DOCUMENT_CATALOG.find(d=>d.id===type)!.name;
const base=`/projects/${ids.api}/project-files`;
type Artifact={artifact:M4Artifact;metadata:Dto<'ArtifactResponse'>;bytes:Buffer};
type HeldRead={snapshot:ProjectFileWorkspace;release:()=>void};
type Delivery={requests:Map<string,{body:FileGenerationBatchRequest;batch:ProjectFileBatch;manifests:M4Task['manifest'][]}>;
  artifacts:Map<string,Artifact>;reads:number;failReads:number;holdNextRead:boolean;held:HeldRead[];actions:{batch_id:string;action:string}[]};
export type State=EntryState&{delivery:Delivery};
const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,json:body});
export const workspace=(s:State)=>s.workspaces.get(ids.api)!;
export const batch=(s:State)=>workspace(s).batches[0];
export const artifacts=(s:State)=>[...s.delivery.artifacts.values()];
export const readCalls=(s:State)=>s.calls.filter(c=>c.method==='GET'&&c.path===base+'/workspace');
export const actionCalls=(s:State)=>s.calls.filter(c=>c.method==='POST'&&c.path.includes('/batches/')&&c.path.endsWith('/actions'));

function accept(s:State,body:FileGenerationBatchRequest){
  expect(Value.Check(projectFileSchemas.ProjectFileBatchRequest,body)).toBe(true);
  const prior=s.delivery.requests.get(body.request_id);
  if(prior){expect(body).toEqual(prior.body);return prior.batch;}
  const w=workspace(s),source=w.source!;
  expect(body.source_version_id).toBe(source.version_id);expect(body.expected_selection_revision).toBe(source.selection_revision);
  const manifests=body.documents.map(d=>{
    const draft=w.workspace.drafts[d.document_type],template=w.workspace.templates.find(t=>t.template_id===draft.template?.template_id)!;
    expect(d.draft_version).toBe(draft.version);
    const {version:_version,sha256:_sha,updated_at:_updated,...input}=structuredClone(draft);
    const manifest={version:'m4-document-input-v1' as const,kind:'document' as const,topic_id:ids.topic,execution_scope_project_id:ids.api,
      draft_version:d.draft_version,input,template_material:structuredClone(template.material),market:'sse' as const,offering:'private' as const,billing_task:M4_DOCUMENT_BILLING_TASKS[d.document_type]};
    expect(Value.Check(M4DocumentManifestSchema,manifest)).toBe(true);return manifest;
  });
  const accepted:ProjectFileBatch={batch_id:'delivery-batch-'+(s.delivery.requests.size+1),state:'queued',
    items:body.documents.map(d=>({document_type:d.document_type,run_id:null,state:'queued',error:null}))};
  expect(Value.Check(ProjectFileBatchSchema,accepted)).toBe(true);
  s.delivery.requests.set(body.request_id,{body:structuredClone(body),batch:accepted,manifests});w.batches.unshift(accepted);return accepted;
}

/** Explicit fixture transitions model the existing serial worker's public projection. */
export function setItemState(s:State,index:number,state:Run['state']){
  const b=batch(s),item=b.items[index],w=workspace(s).workspace,receipt=[...s.delivery.requests.values()].find(r=>r.batch===b)!;
  if(!item.run_id){
    expect(b.state).not.toBe('cancelled');expect(index===0||b.items[index-1].state==='succeeded').toBe(true);
    item.run_id=`${b.batch_id}-run-${index+1}`;
    const manifest=receipt.manifests[index],run:Run={run_id:item.run_id,project_id:w.project.project_id,
      execution_request_id:`project-files:${b.batch_id}:${index}:1`,input_revision:index+1,input_hash:hash(JSON.stringify(manifest)),state,stage:state,
      channel:'production',test_grant_id:null,uncovered_items:[],event_cursor:0,billing_mode:'fixed_credits',reservation_id:'reservation-'+item.run_id,
      artifact_id:null,prompt_snapshot_ref:null,updated_at:now};
    w.tasks.push({run,manifest,created_at:now,events:[],artifacts:[]});
  }
  const task=w.tasks.find(t=>t.run.run_id===item.run_id)!;item.state=state;task.run.state=state;task.run.stage=state;
  if(state==='succeeded'&&!task.artifacts.length){
    const m=task.manifest;expect(m.kind).toBe('document');if(m.kind!=='document')throw Error('document manifest required');
    for(const kind of ['document','preparation_note'] as const){
      const text=JSON.stringify({synthetic:true,kind,run_id:item.run_id,document_type:item.document_type,draft_version:m.draft_version,
        source:m.input.source_material,project_file:m.input.project_file,template:m.input.template,requirements:m.input.requirements,
        supplemental_requirements:m.input.supplemental_requirements,input_hash:task.run.input_hash});
      const bytes=docx(text),id=`${item.run_id}-${kind}`,filename=label(item.document_type)+(kind==='document'?'_正文_V1.docx':'_编制说明_V1.docx');
      const artifact:M4Artifact={source_project_id:w.project.project_id,artifact_id:id,artifact_version:1,sha256:hash(bytes),topic_id:ids.topic,
        run_id:item.run_id!,document_type:item.document_type,kind,filename,mime_type:mime,byte_size:bytes.length,created_at:now,base_artifact:null,
        input_hash:task.run.input_hash,revision_number:1};
      const metadata:Dto<'ArtifactResponse'>={filename,artifact_id:id,run_id:item.run_id!,version:1,media_type:mime,sha256:artifact.sha256,
        quality_status:'passed',delivery_status:'available',download_url:`/api/v1/artifacts/${id}/download?grant=synthetic-delivery`,expires_at:'2099-01-01T00:00:00Z'};
      expect(Value.Check(schemas.ArtifactResponse,metadata)).toBe(true);
      s.delivery.artifacts.set(id,{artifact,metadata,bytes});task.artifacts.push(artifact);w.artifacts.push(artifact);
      if(kind==='document'){
        task.run.artifact_id=id;
        const version:ProjectFileVersion={version_id:id+'-version',file_id:'delivery-family-'+item.document_type,document_type:item.document_type,filename,
          sequence:1,asset:{kind:'artifact',pin:{source_project_id:w.project.project_id,artifact_id:id,artifact_version:1,sha256:artifact.sha256}},revision_asset:null,
          source_version_id:m.input.project_file!.source_version_id,template_id:m.input.template!.template_id,template_version:m.input.template!.template_version,
          source_name:workspace(s).source!.filename,source_sequence:workspace(s).source!.sequence,created_at:now,run_id:item.run_id!,links:[],latest:true,version_count:1,
          consistency:{status:'unchecked',count:0,check_run_id:null}};
        expect(Value.Check(ProjectFileVersionSchema,version)).toBe(true);
        workspace(s).files.push(version);
      }
    }
  }
  expect(Value.Check(schemas.RunResponse,task.run)).toBe(true);
  w.active_run=w.tasks.find(t=>!['succeeded','test_completed','failed','cancelled','rejected'].includes(t.run.state))?.run??null;
  if(b.state!=='cancelled'&&b.state!=='paused')b.state=b.items.every(i=>i.state==='succeeded')?'complete':'running';
}

export function queue(s:State,request_id='seed-delivery-package'){
  const w=workspace(s),source=w.source!;
  return accept(s,{request_id,source_version_id:source.version_id,expected_selection_revision:source.selection_revision,
    documents:types.map(document_type=>({document_type,draft_version:w.workspace.drafts[document_type].version}))});
}
export function seed(s:State,state:ProjectFileBatch['state']='running',second:Run['state']='running'){
  queue(s);
  setItemState(s,0,'succeeded');setItemState(s,1,second);batch(s).state=state;return batch(s);
}

export async function deliveryFixture(page:Page){
  const s=Object.assign(await fixture(page),{delivery:{requests:new Map(),artifacts:new Map(),reads:0,failReads:0,holdNextRead:false,held:[],actions:[]} as Delivery});
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname.slice('/api/v1'.length),method=req.method();
    const owns=path===base+'/workspace'&&method==='GET'||path===base+'/batches'&&method==='POST'||path.startsWith(base+'/batches/')&&path.endsWith('/actions')&&method==='POST'||path.startsWith('/artifacts/');
    if(!owns)return route.fallback();
    const body=req.postData()?req.postDataJSON():undefined;s.calls.push({path,method,body});
    if(path===base+'/workspace'){
      s.delivery.reads++;
      if(s.delivery.failReads){s.delivery.failReads--;return json(route,503,{code:'DATA_UNAVAILABLE'});}
      const snapshot=structuredClone(workspace(s));
      if(s.delivery.holdNextRead){s.delivery.holdNextRead=false;await new Promise<void>(resolve=>s.delivery.held.push({snapshot,release:resolve}));}
      return json(route,200,snapshot);
    }
    if(path===base+'/batches')return json(route,200,accept(s,body));
    const action=path.match(/\/batches\/([^/]+)\/actions$/);
    if(action){
      expect(Value.Check(projectFileSchemas.ProjectFileBatchActionRequest,body)).toBe(true);expect(action[1]).toBe(batch(s).batch_id);expect(body).toEqual({action:'cancel'});
      s.delivery.actions.push({batch_id:action[1],action:body.action});batch(s).state='cancelled';return json(route,200,workspace(s));
    }
    const artifact=path.match(/^\/artifacts\/([^/]+)(\/download)?$/),stored=artifact&&s.delivery.artifacts.get(artifact[1]);
    if(stored){
      expect(method).toBe('GET');expect(s.owner).toBe(ids.owner);
      return artifact![2]?route.fulfill({status:200,contentType:mime,body:stored.bytes}):json(route,200,stored.metadata);
    }
    s.unexpected.push(`${method} ${path}`);return json(route,404,{code:'NOT_FOUND'});
  });
  return s;
}

export function assertDeliveryFixture(s:State){
  assertFixture(s);expect(s.calls.filter(c=>c.method==='POST'&&/\/runs\/[^/]+\/(cancel|pause|resume)$/.test(c.path))).toEqual([]);
}
