import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,type Page} from '@playwright/test';
import {billingApi,billingLedger,integer,type BillingAudit} from './local-prelaunch-billing-helpers';
import {assertImmutableQualityInput} from './local-prelaunch-helpers';
import {checkRealSampleDeliveryNotes} from './local-prelaunch-real-sample-summary';

export const realSampleRepo=fileURLToPath(new URL('../../..',import.meta.url));
const sourceRoot=join(realSampleRepo,'tests/samples/2026-09-25');
export const realSampleEvidenceRoot=resolve(realSampleRepo,'../quality-prelaunch-20261107');
export const qualityPython=process.env.BB_PRELAUNCH_QUALITY_PYTHON??'C:/Users/lezhai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
export const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

export function retainedRealSampleDownload(path:string,expectedHash:string):Buffer|undefined {
  let bytes:Buffer;
  try{bytes=readFileSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  if(sha256(bytes)!==expectedHash)throw Error('Existing downloaded evidence differs from the artifact hash; file preserved.');
  return bytes;
}
export function preserveRealSampleDownload(path:string,bytes:Buffer,expectedHash:string):'saved'|'reused' {
  if(sha256(bytes)!==expectedHash)throw Error('Downloaded bytes do not match the artifact hash; evidence not written.');
  try{writeFileSync(path,bytes,{flag:'wx',mode:0o600});return 'saved';}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  retainedRealSampleDownload(path,expectedHash);return 'reused';
}

export function realSampleSources(){
  const manifest=JSON.parse(readFileSync(join(sourceRoot,'manifest.json'),'utf8'));
  const selected=manifest.cases.find((entry:any)=>(entry.case_id??entry.id)==='rq-202509');
  if(!selected||selected.files.length!==3)throw Error('Exactly the three authorized RQ Q3 inputs are required.');
  return selected.files.map((entry:any)=>{
    const path=resolve(sourceRoot,entry.path),bytes=readFileSync(path);
    if(!path.startsWith(resolve(sourceRoot,'rq-202509')+'/')&&!path.startsWith(resolve(sourceRoot,'rq-202509')+'\\'))throw Error('Unauthorized input path');
    expect(bytes.length).toBe(entry.bytes);expect(sha256(bytes)).toBe(entry.sha256);
    return {...entry,absolutePath:path};
  });
}

/** Limit resumable authentication and customer evidence to this new external run directory. */
export function privateRealSampleDirectory(directory:string){
  if(dirname(resolve(directory))!==realSampleEvidenceRoot)throw Error('Direct external real-sample evidence directory required');
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(process.platform==='win32'){
    const principal=[process.env.USERDOMAIN,process.env.USERNAME].filter(Boolean).join('\\');
    if(!principal||/[\r\n]/.test(principal))throw Error('Current Windows principal unavailable');
    execFileSync('icacls.exe',[directory,'/inheritance:r','/grant:r',`${principal}:(OI)(CI)F`,'SYSTEM:(OI)(CI)F'],
      {encoding:'utf8',windowsHide:true,timeout:30000});
  }
}

export interface RealSampleReceipt {
  case:'rq-202509'; owner:string; username:string; outputDirectory:string; projectId:string; runId:string;
  request:any; originalQuote?:any; sourceHashes:{file_id:string;sha256:string;bytes:number}[];
  materialVersions:{material_id:string;material_version:number}[];
}
export function readRealSampleReceipt(directory:string):RealSampleReceipt{
  if(dirname(resolve(directory))!==realSampleEvidenceRoot)throw Error('External real-sample run directory required');
  const receipt=JSON.parse(readFileSync(join(directory,'run.json'),'utf8'));
  if(receipt.case!=='rq-202509'||resolve(receipt.outputDirectory)!==resolve(directory)||
      !/^[a-f0-9-]{36}$/.test(receipt.runId)||!/^[a-f0-9-]{36}$/.test(receipt.projectId)||!receipt.owner||
      receipt.materialVersions?.length!==3||receipt.materialVersions.some((pin:any)=>!pin.material_id||!Number.isInteger(pin.material_version)||pin.material_version<1))
    throw Error('Invalid original real-sample run receipt');
  return receipt;
}

/** Continue observing an existing product task. This function never submits or resumes a task. */
export async function finishRealSample(page:Page,billing:BillingAudit,receipt:RealSampleReceipt){
  const {runId,projectId,outputDirectory:directory,request}=receipt;
  const originals=realSampleSources();
  expect(originals.map((s:any)=>({file_id:s.file_id,sha256:s.sha256,bytes:s.bytes}))).toEqual(receipt.sourceHashes);
  const me=await billingApi(page,'GET','/api/v1/me');expect(me.status).toBe(200);expect(me.body.user_id).toBe(receipt.owner);
  billing.record('immutable-unified-authoring-target',assertImmutableQualityInput(receipt,
    {issuer:'任丘市建设投资集团有限公司',cutoff:'2025-09-30'},originals.map((file:any)=>file.sha256)));
  let terminal:any,last='';
  await expect.poll(async()=>{
    const state=await billingApi(page,'GET',`/api/v1/runs/${runId}`);expect(state.status).toBe(200);terminal=state.body;
    expect(terminal.project_id).toBe(projectId);expect(terminal.input_revision).toBe(request.input_revision);expect(terminal.input_hash).toBe(request.input_hash);
    const next=`${terminal.state}/${terminal.stage}`;
    if(next!==last){last=next;billing.record('real-full-prospectus-worker-progress',terminal);console.log(`RQ Q3 ${runId} ${next}`);}
    return ['succeeded','failed','cancelled','rejected','paused'].includes(terminal.state);
  },{timeout:6600000,intervals:[3000,10000,15000]}).toBe(true);
  billing.record('real-full-prospectus-terminal',terminal);writeFileSync(join(directory,'terminal.json'),JSON.stringify(terminal,null,2));
  expect(terminal.state,JSON.stringify(terminal)).toBe('succeeded');expect(terminal.artifact_id).toBeTruthy();
  const charge=await billingApi(page,'GET',`/api/v1/runs/${runId}/credit-charge`);expect(charge.status).toBe(200);
  expect(charge.body.quote.quote_id).toBe(request.quote_id);expect(charge.body.quote.input_hash).toBe(request.input_hash);
  if(receipt.originalQuote)expect(charge.body.quote).toEqual(receipt.originalQuote);
  expect(charge.body.state).toBe('settled');
  const points=charge.body.quote.points;expect(integer(points)).toBeGreaterThan(0n);
  expect(charge.body.progress).toMatchObject({policy:'on_delivery',charged_points:points,released_points:'0',clock_running:false});
  billing.record('full-prospectus-final-charge',charge.body);
  const settled=billing.checkpoint('real-full-prospectus-delivered-and-settled');expect(settled.runs).toHaveLength(1);
  const reservations=settled.reservations.filter((row:any)=>row.run_id===runId);expect(reservations).toHaveLength(1);
  expect(reservations[0]).toMatchObject({state:'settled',billing_policy:'on_delivery',points,charged_points:points});
  for(const kind of ['reserve','settle']){
    const events=settled.events.filter((row:any)=>row.run_id===runId&&row.kind===kind);expect(events).toHaveLength(1);expect(events[0].points).toBe(points);
  }
  expect(settled.events.filter((row:any)=>row.run_id===runId&&row.kind==='release')).toHaveLength(0);
  expect(settled.lots.reduce((sum:bigint,row:any)=>sum+integer(row.frozen),0n)).toBe(0n);
  const calls=settled.modelCalls.filter((row:any)=>row.run_id===runId);expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({status:'completed',model_id:'gpt-6-sol',usage_status:'measured'});
  const artifact=await billingApi(page,'GET',`/api/v1/artifacts/${terminal.artifact_id}`);expect(artifact.status).toBe(200);
  expect(artifact.body.artifact_id).toBe(terminal.artifact_id);expect(artifact.body.run_id).toBe(runId);
  const pair=artifact.body.word_delivery;expect(pair.revision_artifact_id).toBe(terminal.artifact_id);expect(pair.clean_artifact_id).toBeTruthy();
  // Both a new submission and same-run observation inspect the actual artifact API value.
  // Preserve earlier observations and Word reports; never redact or rewrite saved notes.
  const observationDirectory=join(directory,`quality-observation-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
  mkdirSync(observationDirectory,{mode:0o700});
  const notesCheck=checkRealSampleDeliveryNotes(pair.authoring_summary);
  const notesReportPath=join(observationDirectory,'user-delivery-notes-check.json');
  const notesEvidence={...notesCheck,checkedAt:new Date().toISOString(),
    checkerSourceSha256:sha256(readFileSync(fileURLToPath(new URL('./local-prelaunch-real-sample-summary.ts',import.meta.url)))),source:{kind:'actual-artifact-api',
    artifactId:artifact.body.artifact_id,runId,artifactVersion:artifact.body.version},reportPath:notesReportPath};
  writeFileSync(notesReportPath,JSON.stringify(notesEvidence,null,2),{flag:'wx',mode:0o600});
  billing.record('actual-api-user-delivery-notes-check',notesEvidence);
  await page.goto(`/#/artifacts/${terminal.artifact_id}`);
  for(const [label,name,id] of [['下载修订版','tracked.docx',pair.revision_artifact_id],['下载清洁版','clean.docx',pair.clean_artifact_id]] as const){
    const descriptor=await billingApi(page,'GET',`/api/v1/artifacts/${id}`);expect(descriptor.status).toBe(200);expect(descriptor.body.run_id).toBe(runId);
    const path=join(directory,name);let bytes=retainedRealSampleDownload(path,descriptor.body.sha256);
    let downloadedThisObservation=false,evidenceReused=!!bytes;
    if(!bytes){
      const pending=page.waitForEvent('download',{timeout:120000});await page.getByRole('button',{name:label,exact:true}).click();
      const receivedPath=join(observationDirectory,name);await(await pending).saveAs(receivedPath);bytes=readFileSync(receivedPath);
      evidenceReused=preserveRealSampleDownload(path,bytes,descriptor.body.sha256)==='reused';downloadedThisObservation=true;
    }
    expect(sha256(bytes)).toBe(descriptor.body.sha256);expect(bytes.length).toBeGreaterThan(1000);
    billing.record('full-prospectus-actual-Word-download',{name,artifactId:id,bytes:bytes.length,sha256:sha256(bytes),downloadedThisObservation,evidenceReused});
  }
  await page.screenshot({path:join(observationDirectory,'dual-Word-delivered.png'),fullPage:true});
  const checkerSourceHashes=Object.fromEntries(['rq_q3_baseline.py','rq_q3_check.py','rq_q3_narrative_check.py']
    .map(name=>[name,sha256(readFileSync(join(realSampleRepo,'scripts/local-quality',name)))]));
  const check=spawnSync(qualityPython,[join(realSampleRepo,'scripts/local-quality/rq_q3_check.py'),'--clean',join(directory,'clean.docx'),
    '--tracked',join(directory,'tracked.docx'),'--output-dir',observationDirectory],{cwd:realSampleRepo,encoding:'utf8',windowsHide:true,
    env:{...process.env,PYTHONIOENCODING:'utf-8'},timeout:120000});
  billing.record('independent-downloaded-Word-quality-check',{exitCode:check.status,summary:check.stdout,diagnostic:check.stderr,checkerSourceHashes,
    reportPath:join(observationDirectory,'rq-q3-quality-report.json'),visualReview:'not_performed'});
  const narrative=spawnSync(qualityPython,[join(realSampleRepo,'scripts/local-quality/rq_q3_narrative_check.py'),
    '--clean',join(directory,'clean.docx'),'--tracked',join(directory,'tracked.docx'),'--output-dir',observationDirectory],
    {cwd:realSampleRepo,encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'},timeout:120000});
  billing.record('independent-downloaded-Word-narrative-check',{exitCode:narrative.status,summary:narrative.stdout,diagnostic:narrative.stderr,checkerSourceHashes,
    reportPath:join(observationDirectory,'rq-q3-narrative-report.json'),visualReview:'not_performed'});
  for(const file of originals)expect(sha256(readFileSync(file.absolutePath))).toBe(file.sha256);
  // Replay remains the original immutable execution request; never create a new request to observe an old run.
  const replay=await billingApi(page,'POST','/api/v1/runs/execute',request);expect(replay.status).toBe(202);expect(replay.body.run_id).toBe(runId);
  expect(billingLedger(billing.owner)).toEqual(settled);
  expect.soft(notesCheck.status,'User delivery-note technical-detail check retained at '+notesReportPath).toBe('passed');
  expect.soft(check.status,'Independent Word quality report retained at '+observationDirectory).toBe(0);
  expect(narrative.status,'Independent Word narrative report retained at '+observationDirectory).toBe(0);
}
