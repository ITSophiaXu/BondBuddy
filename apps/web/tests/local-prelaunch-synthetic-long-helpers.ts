import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,type Page} from '@playwright/test';
import {billingApi,billingLedger,integer,type BillingAudit} from './local-prelaunch-billing-helpers';
import {assertImmutableQualityInput} from './local-prelaunch-helpers';

export const syntheticRepo=fileURLToPath(new URL('../../..',import.meta.url));
export const syntheticEvidenceRoot=resolve(syntheticRepo,'../quality-prelaunch-20261107');
export const syntheticPython=process.env.BB_PRELAUNCH_QUALITY_PYTHON??'C:/Users/lezhai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
export const syntheticHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

export function syntheticLongInputs(directory=process.env.BB_PRELAUNCH_SYNTHETIC_LONG_FIXTURES){
  if(!directory||dirname(resolve(directory))!==syntheticEvidenceRoot)throw Error('Explicit external synthetic fixture directory required');
  const manifestBytes=readFileSync(join(directory,'fixture-manifest.json')),manifest=JSON.parse(manifestBytes.toString('utf8'));
  if(manifest.schema!=='synthetic-long-2026q3-v1'||manifest.synthetic_only!==true||manifest.customer_inputs_read!==false||
    manifest.issuer!=='合成澄星测试投资有限公司'||manifest.controls?.length!==24||manifest.files?.length!==3)
    throw Error('Only the dedicated wholly invented long-form fixture is accepted');
  expect(manifest.files.map((file:any)=>file.role).sort()).toEqual(['financial','historical','notes']);
  const files=manifest.files.map((file:any)=>{
    const path=resolve(directory,file.filename);if(dirname(path)!==resolve(directory))throw Error('Fixture filename escaped dedicated directory');
    const bytes=readFileSync(path);expect(bytes.length).toBe(file.bytes);expect(syntheticHash(bytes)).toBe(file.sha256);
    return {...file,path};
  });
  return {directory:resolve(directory),manifestHash:syntheticHash(manifestBytes),manifest,files};
}

export function privateSyntheticDirectory(directory:string){
  if(dirname(resolve(directory))!==syntheticEvidenceRoot)throw Error('External evidence directory required');
  mkdirSync(directory,{recursive:false,mode:0o700});
  if(process.platform==='win32'){
    const principal=[process.env.USERDOMAIN,process.env.USERNAME].filter(Boolean).join('\\');
    if(!principal||/[\r\n]/.test(principal))throw Error('Current Windows principal unavailable');
    execFileSync('icacls.exe',[directory,'/inheritance:r','/grant:r',`${principal}:(OI)(CI)F`,'SYSTEM:(OI)(CI)F'],
      {encoding:'utf8',windowsHide:true,timeout:30000});
  }
}

export interface SyntheticLongReceipt {
  case:'synthetic-long-2026q3-v1';owner:string;username:string;projectId:string;runId:string;directory:string;
  fixtureDirectory:string;manifestHash:string;sourceHashes:{role:string;filename:string;bytes:number;sha256:string}[];
  materialVersions:{material_id:string;material_version:number}[];
  request:any;originalQuote?:any;
}
export function syntheticLongReceipt(directory:string):SyntheticLongReceipt{
  if(dirname(resolve(directory))!==syntheticEvidenceRoot)throw Error('External synthetic receipt required');
  const receipt=JSON.parse(readFileSync(join(directory,'run.json'),'utf8'));
  if(receipt.case!=='synthetic-long-2026q3-v1'||resolve(receipt.directory)!==resolve(directory)||
    !/^[a-f0-9-]{36}$/.test(receipt.runId)||!/^[a-f0-9-]{36}$/.test(receipt.projectId)||!receipt.owner||
    receipt.materialVersions?.length!==3||receipt.materialVersions.some((pin:any)=>!pin.material_id||!Number.isInteger(pin.material_version)||pin.material_version<1))
    throw Error('Invalid original synthetic run receipt');
  return receipt;
}

/** Observes the original run; the only POST is an exact replay of its immutable request. */
export async function finishSyntheticLong(page:Page,audit:BillingAudit,receipt:SyntheticLongReceipt){
  const fixture=syntheticLongInputs(receipt.fixtureDirectory);
  expect(fixture.manifestHash).toBe(receipt.manifestHash);
  expect(fixture.files.map(({role,filename,bytes,sha256}:any)=>({role,filename,bytes,sha256}))).toEqual(receipt.sourceHashes);
  const me=await billingApi(page,'GET','/api/v1/me');expect(me.status).toBe(200);expect(me.body.user_id).toBe(receipt.owner);
  const input=await billingApi(page,'GET',`/api/v1/projects/${receipt.projectId}/input-revisions/${receipt.request.input_revision}`);
  expect(input.status).toBe(200);expect(input.body.input_hash).toBe(receipt.request.input_hash);
  expect([...input.body.material_versions].sort((a:any,b:any)=>a.material_id.localeCompare(b.material_id)))
    .toEqual([...receipt.materialVersions].sort((a,b)=>a.material_id.localeCompare(b.material_id)));
  audit.record('immutable-unified-authoring-target',assertImmutableQualityInput(receipt,
    {issuer:fixture.manifest.issuer,cutoff:fixture.manifest.target_cutoff},fixture.files.map((file:any)=>file.sha256)));
  let terminal:any,last='';
  await expect.poll(async()=>{
    const state=await billingApi(page,'GET',`/api/v1/runs/${receipt.runId}`);expect(state.status).toBe(200);terminal=state.body;
    expect(terminal.project_id).toBe(receipt.projectId);expect(terminal.input_revision).toBe(receipt.request.input_revision);
    expect(terminal.input_hash).toBe(receipt.request.input_hash);
    const next=`${terminal.state}/${terminal.stage}`;
    if(next!==last){last=next;audit.record('synthetic-full-worker-progress',terminal);console.log(`Synthetic long ${receipt.runId} ${next}`);}
    return ['succeeded','failed','cancelled','rejected','paused'].includes(terminal.state);
  },{timeout:6600000,intervals:[3000,10000,15000]}).toBe(true);
  writeFileSync(join(receipt.directory,'terminal.json'),JSON.stringify(terminal,null,2));
  audit.record('synthetic-full-terminal',terminal);expect(terminal.state,JSON.stringify(terminal)).toBe('succeeded');
  const charge=await billingApi(page,'GET',`/api/v1/runs/${receipt.runId}/credit-charge`);expect(charge.status).toBe(200);
  expect(charge.body.quote.quote_id).toBe(receipt.request.quote_id);
  if(receipt.originalQuote)expect(charge.body.quote).toEqual(receipt.originalQuote);
  const points=charge.body.quote.points;expect(integer(points)).toBeGreaterThan(0n);
  expect(charge.body).toMatchObject({state:'settled',progress:{policy:'on_delivery',charged_points:points,released_points:'0',clock_running:false}});
  const ledger=audit.checkpoint('synthetic-full-delivery-settlement');expect(ledger.runs).toHaveLength(1);
  const reservations=ledger.reservations.filter((row:any)=>row.run_id===receipt.runId);expect(reservations).toHaveLength(1);
  expect(reservations[0]).toMatchObject({state:'settled',billing_policy:'on_delivery',points,charged_points:points});
  for(const kind of ['reserve','settle']){
    const events=ledger.events.filter((row:any)=>row.run_id===receipt.runId&&row.kind===kind);expect(events).toHaveLength(1);expect(events[0].points).toBe(points);
  }
  expect(ledger.events.filter((row:any)=>row.run_id===receipt.runId&&row.kind==='release')).toHaveLength(0);
  expect(ledger.lots.reduce((sum:bigint,row:any)=>sum+integer(row.frozen),0n)).toBe(0n);
  const calls=ledger.modelCalls.filter((row:any)=>row.run_id===receipt.runId);expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({status:'completed',model_id:'gpt-6-sol',usage_status:'measured'});
  const artifact=await billingApi(page,'GET',`/api/v1/artifacts/${terminal.artifact_id}`);expect(artifact.status).toBe(200);
  expect(artifact.body.run_id).toBe(receipt.runId);const pair=artifact.body.word_delivery;
  expect(pair.revision_artifact_id).toBe(terminal.artifact_id);expect(pair.clean_artifact_id).toBeTruthy();
  await page.goto(`/#/artifacts/${terminal.artifact_id}`);
  for(const [label,name,id] of [['下载修订版','tracked.docx',pair.revision_artifact_id],['下载清洁版','clean.docx',pair.clean_artifact_id]] as const){
    const descriptor=await billingApi(page,'GET',`/api/v1/artifacts/${id}`);expect(descriptor.status).toBe(200);expect(descriptor.body.run_id).toBe(receipt.runId);
    const pending=page.waitForEvent('download',{timeout:120000});await page.getByRole('button',{name:label,exact:true}).click();
    const path=join(receipt.directory,name);await(await pending).saveAs(path);const bytes=readFileSync(path);
    expect(syntheticHash(bytes)).toBe(descriptor.body.sha256);expect(bytes.length).toBeGreaterThan(1000);
    audit.record('synthetic-full-actual-browser-download',{name,id,bytes:bytes.length,sha256:syntheticHash(bytes)});
  }
  await page.screenshot({path:join(receipt.directory,'dual-Word-delivered.png'),fullPage:true});
  const check=spawnSync(syntheticPython,[join(syntheticRepo,'scripts/local-quality/synthetic_long_check.py'),'--fixture-dir',receipt.fixtureDirectory,
    '--clean',join(receipt.directory,'clean.docx'),'--tracked',join(receipt.directory,'tracked.docx'),'--output-dir',receipt.directory],
    {cwd:syntheticRepo,encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'},timeout:120000});
  audit.record('independent-synthetic-long-output-check',{exitCode:check.status,summary:check.stdout,diagnostic:check.stderr,visualReview:'not_performed'});
  syntheticLongInputs(receipt.fixtureDirectory);
  const replay=await billingApi(page,'POST','/api/v1/runs/execute',receipt.request);expect(replay.status).toBe(202);expect(replay.body.run_id).toBe(receipt.runId);
  expect(billingLedger(receipt.owner)).toEqual(ledger);
  expect(check.status,'Full synthetic quality report retained at '+receipt.directory).toBe(0);
}
