import {expect,type Page} from '@playwright/test';
import {emptyUpdateDetails,reportingWindow} from '@bondbuddy/contracts';
import {randomUUID,createHash} from 'node:crypto';
import {makeWorkerDocxFixture} from '../../worker/src/docx-test-fixture';
import {billingApi,type BillingAudit} from './local-prelaunch-billing-helpers';

const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export async function uploadBillingDocx(page:Page,projectId:string,name:string,buffer:Buffer,role='other'){
  const sha256=createHash('sha256').update(buffer).digest('hex'),declaration={byte_size:buffer.length,sha256};
  const created=await billingApi(page,'POST',`/api/v1/projects/${projectId}/materials/uploads`,{...declaration,filename:name,media_type:DOCX,role});expect(created.status,JSON.stringify(created.body)).toBe(201);
  const put=await page.evaluate(async({path,bytes})=>{
    const url=new URL(path,location.origin);if(url.origin!==location.origin||!url.pathname.startsWith('/api/v1/'))throw Error('Local upload URL required');
    const csrf=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('bb_csrf='))?.slice(8)??'';
    const r=await fetch(url,{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/octet-stream','x-bb-csrf':decodeURIComponent(csrf)},body:new Uint8Array(bytes)});return {status:r.status,text:await r.text()};
  },{path:created.body.upload_url,bytes:[...buffer]});expect([200,204],put.text).toContain(put.status);
  const completed=await billingApi(page,'POST',`/api/v1/projects/${projectId}/materials/uploads/${created.body.upload_id}/complete`,declaration);expect(completed.status,JSON.stringify(completed.body)).toBe(200);expect(completed.body.sha256).toBe(sha256);
  return {kind:'material' as const,pin:{source_project_id:projectId,material_id:completed.body.material_id,material_version:completed.body.material_version,sha256}};
}
export async function waitForQa(page:Page,project:string,runId:string,timeout=600000){
  let run:any;
  await expect.poll(async()=>{const r=await billingApi(page,'GET',`/api/v1/projects/${project}/qa?run_id=${encodeURIComponent(runId)}`);expect(r.status,JSON.stringify(r.body)).toBe(200);run=r.body.runs.find((x:any)=>x.run_id===runId);return !!run&&['succeeded','failed','cancelled','rejected'].includes(run.state);},{timeout,intervals:[1000,2000,5000]}).toBe(true);
  return run;
}
export async function prepareBillingQa(page:Page,audit:BillingAudit,emptyReference=false){
  const marker=randomUUID().slice(0,8),issuer=`合成账务验收${marker}发行人有限公司`,cutoff='2026-09-30';
  const created=await billingApi(page,'POST','/api/v1/projects',{name:`合成真实问答账务 ${marker}`,kind:'update',issuer_name:issuer,market:'sse',offering:'private',creation_request_id:randomUUID(),
    update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:cutoff,target_reporting_periods:reportingWindow('sse','private',cutoff),source_prospectuses:[]}});expect(created.status,JSON.stringify(created.body)).toBe(201);const project=created.body.project_id;
  const referenceText=`【纯合成账务验收文件，不含客户数据】发行人：${issuer}。原稿报告期：2025年度（2025年12月31日）。唯一标记：${marker}。缺失财务数据待人工提供，不得编造。`;
  const reference=await uploadBillingDocx(page,project,`billing-${marker}-reference.docx`,makeWorkerDocxFixture({externalLink:false,text:emptyReference?'':referenceText}),'historical');
  let versions=await billingApi(page,'GET',`/api/v1/projects/${project}/prospectus-versions`);expect(versions.status).toBe(200);
  let version=versions.body.versions.find((v:any)=>v.source?.material_id===reference.pin.material_id||v.material_id===reference.pin.material_id||v.sha256===reference.pin.sha256);
  if(!version){versions=await billingApi(page,'POST',`/api/v1/projects/${project}/prospectus-versions`,{request_id:randomUUID(),expected_selection_revision:versions.body.selection_revision,material_id:reference.pin.material_id,material_version:reference.pin.material_version,sha256:reference.pin.sha256});expect(versions.status).toBe(200);version=versions.body.versions.find((v:any)=>v.sha256===reference.pin.sha256);}
  expect(version,'Exact uploaded reference must exist in real version list').toBeTruthy();
  const selected=await billingApi(page,'POST',`/api/v1/projects/${project}/prospectus-versions/current`,{request_id:randomUUID(),expected_selection_revision:versions.body.selection_revision,version_id:version.version_id});expect(selected.status,JSON.stringify(selected.body)).toBe(200);
  const questionText='1. 请根据本项目募集说明书，说明发行人名称以及原稿报告期；缺失事实须明确说明，不得编造。';
  const question=await uploadBillingDocx(page,project,`billing-${marker}-questions.docx`,makeWorkerDocxFixture({externalLink:false,text:questionText}));
  const prepared=await billingApi(page,'POST',`/api/v1/projects/${project}/qa/prepare`,{request_id:randomUUID(),source:question});expect(prepared.status,JSON.stringify(prepared.body)).toBe(200);
  const preparation=await waitForQa(page,project,prepared.body.run_id,120000);expect(preparation.state,JSON.stringify(preparation)).toBe('succeeded');expect(preparation.result.questions).toHaveLength(1);
  const workspace=await billingApi(page,'GET',`/api/v1/projects/${project}/qa`);expect(workspace.status).toBe(200);expect(workspace.body.prospectus.asset.pin.sha256).toBe(reference.pin.sha256);
  const draft={preparation_id:prepared.body.run_id,questions:preparation.result.questions,materials:[workspace.body.prospectus.asset],requirements:'本轮是纯合成账务验收。仅根据提供的资料回答这一题，并保留缺失信息说明。',use_knowledge:false};
  const saved=await billingApi(page,'POST',`/api/v1/projects/${project}/qa/draft`,{expected_revision:workspace.body.revision,draft});expect(saved.status,JSON.stringify(saved.body)).toBe(200);
  audit.record('real-free-prepare-and-pinned-draft',{project,issuer,marker,reference,question,preparation:prepared.body.run_id,revision:saved.body.revision,draft});
  return {project,issuer,marker,reference,question,revision:saved.body.revision,draft};
}
