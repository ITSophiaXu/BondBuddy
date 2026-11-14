/**
 * Explicit local-only smoke: real Copilot + production stages + PostgreSQL + Azurite.
 * Input issuer/financial data are synthetic. Authentication is a dedicated local
 * principal; API route validation, ownership, billing and downloads are unchanged.
 * This helper never starts/stops services, migrates a database, fabricates model
 * output/usage, or retries a failed/provider-reconciliation run automatically.
 *
 * --prepare (default): validates local infrastructure, writes the four-item input,
 * creates an isolated user/project/catalogue and reads the real current tariff.
 * --execute: prepares if needed, runs two concurrent trial files, downloads each
 * completed file immediately, confirms the remainder, and runs its two-item group.
 * --inspect: reads persisted state and downloads already available files only.
 * All evidence and durable resources are retained for diagnosis/review.
 *
 * Required env:
 * BB_PROGRESSIVE_SMOKE_DATABASE_URL=postgresql://...@<local>:.../bb_progressive_real_...
 * BB_PROGRESSIVE_SMOKE_BLOB_CONNECTION_STRING=<local Azurite devstoreaccount1>
 * BB_PROGRESSIVE_SMOKE_OUTPUT_DIR=<absolute writable evidence directory>
 * Production Copilot env: BB_CODEX_AUTH_MODE=copilot_enterprise,
 * BB_COPILOT_OAUTH_FILE=/run/secrets/bb-copilot-oauth, BB_CODEX_MODEL=gpt-6-sol,
 * BB_CODEX_PROVIDER=copilot_enterprise,
 * BB_CODEX_BASE_URL=https://api.enterprise.githubcopilot.com,
 * BB_CODEX_REASONING_EFFORT=max, BB_CODEX_CONFIG_VERSION=<explicit version>.
 * Set BONDBUDDY_WORD_PYTHON=/opt/venv/bin/python and BB_REPO_ROOT=/app.
 * Run inside the existing local Linux worker image with its normal containment.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Pool} from 'pg';
import {createServer} from '../../apps/api/dist/server.js';
import {azureBlobs,digest,transaction} from '../../apps/api/dist/data.js';
import {grantCredits} from '../../apps/api/dist/billing.js';
import {advanceWorkpaperBatch} from '../../apps/api/dist/workpapers.js';
import {headerlessCatalogueXlsx} from '../../apps/api/dist/workpaper-catalogue-fixture.js';
import {billingWireRoute,encodeBillingDto,workpaperChapters} from '@bondbuddy/contracts';
import {loadCodexAdapterConfig} from '../../apps/worker/dist/codex-adapter.js';
import {workerRuntimeOptionsFromEnv} from '../../apps/worker/dist/runtime.js';
import {runPipelineOnce} from '../../apps/worker/dist/run-pipeline.js';

const mode=process.argv[2]??'--prepare';
if(mode==='--help'){
  console.log('Read the header of scripts/local-quality/workpaper-progressive-real-smoke.mjs for required env. Modes: --prepare (no model), --execute (real model), --inspect (read/download only).');
  process.exit(0);
}
assert.ok(['--prepare','--execute','--inspect'].includes(mode),'Unsupported smoke mode');
const repo=resolve(fileURLToPath(import.meta.url),'../../..');
const required=name=>{const value=process.env[name];assert.ok(value,`Missing ${name}`);return value;};
const databaseUrl=required('BB_PROGRESSIVE_SMOKE_DATABASE_URL'),database=new URL(databaseUrl);
assert.ok(['localhost','127.0.0.1','host.docker.internal','bb-progressive-20261113-pg'].includes(database.hostname),'Only a local smoke database is allowed');
assert.match(database.pathname,/^\/bb_progressive_(?:real|smoke)_[a-z0-9_]+$/,'A dedicated progressive smoke database is required');
const storage=required('BB_PROGRESSIVE_SMOKE_BLOB_CONNECTION_STRING');
const storageParts=Object.fromEntries(storage.split(';').filter(Boolean).map(part=>{const at=part.indexOf('=');return [part.slice(0,at),part.slice(at+1)];}));
const blobEndpoint=new URL(storageParts.BlobEndpoint??'invalid:');
assert.ok(['devstoreaccount1','progressivetest'].includes(storageParts.AccountName),'Only the dedicated local Azurite account is allowed');
assert.equal(blobEndpoint.protocol,'http:','Only local HTTP Azurite is allowed');
assert.ok(['localhost','127.0.0.1','host.docker.internal'].includes(blobEndpoint.hostname),'Only local Azurite is allowed');
const output=required('BB_PROGRESSIVE_SMOKE_OUTPUT_DIR');
assert.ok(isAbsolute(output),'An absolute smoke evidence directory is required');
const config=loadCodexAdapterConfig();
assert.equal(config.model_provider,'copilot_enterprise','Real local Copilot configuration is required');
assert.equal(config.credential.kind,'command','The existing contained Copilot credential helper is required');
const publicConfig={model:config.model_id,provider:config.model_provider,reasoning_effort:config.reasoning_effort,config_version:config.model_config_version,
  command:config.command,timeout_ms:config.timeout_ms,authoring_timeout_ms:config.authoring_timeout_ms,max_schema_reasks:config.max_schema_reasks};
const localIdentity={database:database.pathname.slice(1),host:database.hostname,port:database.port,blob_host:blobEndpoint.hostname,blob_port:blobEndpoint.port};
const python=process.env.BONDBUDDY_WORD_PYTHON??'/opt/venv/bin/python';
const runPython=async(code,args=[])=>promisify(execFile)(python,['-B','-c',code,...args],{cwd:repo,env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:join(repo,'python')},maxBuffer:4*1024*1024});
await mkdir(output,{recursive:true});
await mkdir(join(output,'downloads'),{recursive:true});
const statePath=join(output,'smoke-state.json');
let state;
try{state=JSON.parse(await readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(state){assert.deepEqual(state.infrastructure,localIdentity,'Evidence belongs to another local environment');assert.deepEqual(state.model,publicConfig,'Model configuration changed; preserve this evidence and use a new smoke environment');}
else{
  assert.notEqual(mode,'--inspect','No prepared smoke state exists');
  state={version:'workpaper-progressive-real-smoke-v1',id:randomUUID(),created_at:new Date().toISOString(),infrastructure:localIdentity,model:publicConfig,
    boundary:{source:'explicitly synthetic issuer and prospectus',model:'real local Copilot through production codexModelStage',storage:'real local Azurite via azureBlobs',api:'real Fastify handlers with dedicated injected local principal',billing:'real current automatic credits; local seeded balance; provider currency price may be unknown'},
    owner:randomUUID(),container:'bb-progressive-real-'+randomUUID().replaceAll('-',''),downloads:[],events:[]};
}
const save=()=>writeFile(statePath,JSON.stringify(state,null,2)+'\n');
const event=async(phase,details={})=>{const value={at:new Date().toISOString(),phase,...details};state.events.push(value);console.log(JSON.stringify(value));await save();};
const pool=new Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:10000});
const blobs=azureBlobs(storage,state.container);
const origin='http://progressive-smoke.local';
const app=createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,principal:async()=>({userId:state.owner,csrfVerified:true})});
const send=(method,url,payload)=>{const wire=billingWireRoute(method,url);return app.inject({method,url,payload:wire?.request&&payload!==undefined?encodeBillingDto(wire.request,payload):payload,
  headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});};
const ok=async(method,url,payload)=>{const response=await send(method,url,payload);assert.ok(response.statusCode<300,`${method} ${url.split('?')[0]} returned ${response.statusCode}: ${response.body.slice(0,1000)}`);return response.json();};
const checkpoint=async(label)=>{
  if(!state.batch_id)return null;
  const batch=await ok('GET',state.base+`/batches/${state.batch_id}`);
  const [runs,calls,runtime,observations,plans,groups,counts,costs]=await Promise.all([
    pool.query('SELECT id,state,stage,billing_mode,reservation_id FROM bb_runs WHERE owner_user_id=$1 ORDER BY created_at,id',[state.owner]),
    pool.query('SELECT a.id,j.run_id,a.logical_call_id,a.attempt_no,a.model_id,a.status,a.usage_status,a.created_at FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE a.owner_user_id=$1 ORDER BY a.created_at,a.id',[state.owner]),
    pool.query('SELECT attempt_id,adapter,adapter_version,model_provider,model_config_version,started_at,duration_ms,exit_code,finish_reason,error_code,tool_attempts FROM bb_model_call_attempt_runtime WHERE owner_user_id=$1 ORDER BY started_at,id',[state.owner]),
    pool.query('SELECT attempt_id,logical_call_id,outcome,finish_reason,usage_status,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,total_tokens,error_code,observed_at FROM bb_provider_call_observations WHERE owner_user_id=$1 ORDER BY observed_at,id',[state.owner]),
    pool.query('SELECT item_id,plan_hash,plan,author_run_id,created_at FROM bb_workpaper_progressive_plans WHERE owner_user_id=$1 AND batch_id=$2 ORDER BY created_at,item_id',[state.owner,state.batch_id]),
    pool.query('SELECT group_id,receipt,author_run_id,created_at FROM bb_workpaper_progressive_groups WHERE owner_user_id=$1 AND batch_id=$2',[state.owner,state.batch_id]),
    pool.query('SELECT count(*)::int n FROM bb_workpaper_shared_sources WHERE owner_user_id=$1 AND batch_id=$2',[state.owner,state.batch_id]),
    pool.query('SELECT attempt_id,run_id,usage_status,input_tokens,output_tokens,pricing_status,cost_amount,currency FROM bb_platform_cost_ledger WHERE owner_user_id=$1 ORDER BY created_at',[state.owner])
  ]);
  const evidence={captured_at:new Date().toISOString(),label,batch,runs:runs.rows,calls:calls.rows,runtime:runtime.rows,observations:observations.rows,plans:plans.rows,groups:groups.rows,source_snapshots:counts.rows[0].n,costs:costs.rows};
  await writeFile(join(output,`${label}.json`),JSON.stringify(evidence,null,2)+'\n');
  state.latest={label,state:batch.state,phase:batch.progressive?.phase,delivered:batch.items.filter(i=>i.artifacts.length||i.explanation).length,model_calls:calls.rowCount};await save();
  return evidence;
};
const downloadAvailable=async(label)=>{
  const batch=await ok('GET',state.base+`/batches/${state.batch_id}`);
  for(const item of batch.items){
    if(state.downloads.some(d=>d.item_id===item.entry.id))continue;
    let response,sha,filename;
    if(item.explanation){response=await send('GET',state.base+`/batches/${state.batch_id}/explanations/${encodeURIComponent(item.entry.id)}`);sha=item.explanation.sha256;filename=item.explanation.filename;}
    else{
      const artifact=item.artifacts.find(a=>a.kind==='document');if(!artifact)continue;
      const meta=await ok('GET',`/api/v1/artifacts/${encodeURIComponent(artifact.pin.artifact_id)}?version=${artifact.pin.artifact_version}`);
      assert.ok(meta.download_url.startsWith('/api/v1/artifacts/'),'Download must use the authenticated product API');
      response=await send('GET',meta.download_url);sha=artifact.pin.sha256;filename=artifact.filename;
    }
    assert.equal(response.statusCode,200,'Individual Word download must succeed');
    assert.equal(digest(response.rawPayload),sha,'Downloaded Word SHA-256 must match its immutable pin');
    const safeName=filename.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_'),path=join(output,'downloads',safeName);
    await writeFile(path,response.rawPayload);
    const inspection=await runPython("from docx import Document\nimport sys,json\nd=Document(sys.argv[1])\nparagraphs=[p.text for p in d.paragraphs if p.text.strip()]\ntables=[[[c.text for c in r.cells] for r in t.rows] for t in d.tables]\nassert paragraphs or tables\nprint(json.dumps({'paragraphs':paragraphs,'tables':tables,'sections':len(d.sections)},ensure_ascii=False))\n",[path]);
    await writeFile(path+'.inspection.json',inspection.stdout);
    const elapsed=Date.now()-Date.parse(state.submitted_at);
    state.downloads.push({item_id:item.entry.id,code:item.entry.code,kind:item.explanation?'explanation':'generated_document',decision:item.decision?.status??null,filename:safeName,sha256:sha,bytes:response.rawPayload.length,downloaded_at:new Date().toISOString(),from_submission_ms:elapsed,phase:batch.progressive?.phase});
    await event('word_downloaded',{code:item.entry.code,filename:safeName,from_submission_ms:elapsed,other_items:batch.items.filter(i=>i.entry.id!==item.entry.id).map(i=>({code:i.entry.code,state:i.state}))});
  }
  if(batch.items.some(i=>i.artifacts.length||i.explanation)){
    const response=await send('GET',state.base+`/batches/${state.batch_id}/download`);assert.equal(response.statusCode,200,'Partial/final ZIP download must succeed');
    const path=join(output,`${label}.zip`);await writeFile(path,response.rawPayload);
    const inspection=await runPython("from zipfile import ZipFile\nimport sys,json\nwith ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n names=z.namelist()\n assert all(n.endswith('.docx') for n in names)\n print(json.dumps(names,ensure_ascii=False))\n",[path]);
    const names=JSON.parse(inspection.stdout),latest=await ok('GET',state.base+`/batches/${state.batch_id}`);
    const snapshotCount=batch.items.filter(i=>i.artifacts.length||i.explanation).length,currentCount=latest.items.filter(i=>i.artifacts.length||i.explanation).length;
    // The sibling may publish between the initial GET and ZIP preparation. The
    // ZIP is allowed to include that newly committed file as well.
    assert.ok(names.length>=snapshotCount&&names.length<=currentCount,'ZIP must include the initial delivered set and no unpublished files');
    assert.equal(new Set(names).size,names.length,'ZIP filenames must be unique');
    await event('zip_downloaded',{label,files:names,snapshot_files:snapshotCount,current_files:currentCount,sha256:digest(response.rawPayload),bytes:response.rawPayload.length});
  }
  return batch;
};
const upload=async(filename,bytes,media_type,role='other')=>{
  const declared={byte_size:bytes.length,sha256:digest(bytes)},u=await ok('POST',state.path+'/materials/uploads',{...declared,filename,media_type,role});
  assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204,'API upload must persist real bytes');
  const m=await ok('POST',state.path+`/materials/uploads/${u.upload_id}/complete`,declared);
  return {source_project_id:state.project_id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
};
const sourceScript=`from docx import Document
from docx.shared import Cm
import sys
d=Document()
d.add_heading('合成海岳交通集团有限公司募集说明书（本地功能测试材料）',0)
for p in [
 '本文件全部主体、项目及财务数据均为明确合成的测试材料，不对应真实发行人。核查记录可以依据下列披露内容编写，不得声称已执行访谈、外部查询或取得签章原件。',
 '第一章 发行人基本情况',
 '合成海岳交通集团有限公司成立于2008年，注册资本50000万元，主营业务为高速公路运营与交通基础设施建设。合成海岳市国有资产管理机构持有公司100%股权，为控股股东和实际控制人。',
 '截至2025年末，公司经营高速公路里程为180公里。2025年度合并营业收入为36000万元，净利润为4200万元，经营活动现金流量净额为5200万元。合并资产总额为180000万元，负债总额为108000万元，所有者权益合计为72000万元。',
 '第二章 主要子公司财务情况',
 '下表列示全部三家合并子公司2025年末及2025年度数据，单位均为万元。公司持有三家子公司股权比例均为100%。']:
 d.add_paragraph(p)
t=d.add_table(rows=1,cols=6);t.style='Table Grid'
for c,v in zip(t.rows[0].cells,['主体名称','资产总额','负债总额','净资产','营业收入','净利润']):c.text=v
for row in [['合成海岳高速运营有限公司','80000','48000','32000','20000','2600'],['合成海岳交通建设有限公司','50000','30000','20000','12000','1300'],['合成海岳交通服务有限公司','20000','12000','8000','4000','300']]:
 for c,v in zip(t.add_row().cells,row):c.text=v
for p in ['注：上表为各子公司单体口径，集团合并口径另包含母公司及合并抵销，因此不得将单体数据直接相加替代集团合并数据。',
 '第三章 有息债务与偿债安排',
 '截至2025年末，合并口径有息债务为60000万元，其中银行借款45000万元、应付债券15000万元；一年内到期12000万元，一年以上到期48000万元。公司可用银行授信为30000万元，受限货币资金为1000万元。',
 '公司以高速公路通行费和交通服务经营回款作为主要偿债资金来源，并保留可用授信作为流动性补充。上述授信不构成金融机构对本期债券的担保。',
 '第四章 本期债券及募集资金用途',
 '本期拟面向专业投资者非公开发行公司债券，发行规模10000万元，期限3年，发行金额及期限均为本地测试设定。募集资金拟用于偿还两笔银行借款，不新增建设项目投资。']:
 d.add_paragraph(p)
t=d.add_table(rows=1,cols=4);t.style='Table Grid'
for c,v in zip(t.rows[0].cells,['借款主体','借款用途','拟偿还本金（万元）','到期日']):c.text=v
for row in [['合成海岳交通集团有限公司','高速公路运营流动资金','6000','2026年6月30日'],['合成海岳高速运营有限公司','交通设施日常维护','4000','2026年9月30日']]:
 for c,v in zip(t.add_row().cells,row):c.text=v
d.add_paragraph('募集资金偿还本金合计10000万元，与本期发行规模一致。发行人拟设立募集资金专项账户，按约定用途使用资金；实际发行、账户开立、划款和债务偿还均未在本测试材料中声称已完成。')
d.sections[0].left_margin=Cm(2.5);d.sections[0].right_margin=Cm(2.5)
d.save(sys.argv[1])
`;
const prepare=async()=>{
  assert.equal((await pool.query('SELECT current_database() name')).rows[0].name,localIdentity.database);
  const migrated=(await pool.query("SELECT to_regclass('bb_workpaper_progressive_groups') groups,to_regclass('bb_workpaper_progressive_plans') plans")).rows[0];
  assert.ok(migrated.groups&&migrated.plans,'Migrations through 0177 must already be applied to this smoke database');
  // Migration 0027 installs this exact disabled principal. It is not a test
  // participant; a renamed or enabled account must still fail isolation.
  const owners=(await pool.query("SELECT id,username,status FROM bb_users WHERE NOT(id='bb-platform-probe' AND username='bb_platform_probe' AND status='disabled')")).rows;
  assert.ok(owners.every(row=>row.id===state.owner),'Smoke database contains unrelated users; refusing to run');
  await access(config.credential.path,fsConstants.X_OK);await access(config.credential.oauth_file,fsConstants.R_OK);
  const sentinel=Buffer.from('BondBuddy progressive smoke '+state.id);await blobs.put('smoke/connection-check.txt',sentinel,'text/plain');assert.equal(digest(await blobs.get('smoke/connection-check.txt')),digest(sentinel));
  await save();
  if(state.prepared_at){await event('prepared_state_reused');return;}
  if(!owners.some(row=>row.id===state.owner))await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[state.owner,'progressive_real_'+state.id.slice(0,8)]);
  await transaction(pool,c=>grantCredits(c,{owner:state.owner,source:'purchase',key:'progressive-smoke-'+state.id,points:1000000,expiresAt:null,actor:'local-real-model-smoke',reason:'Isolated local functional test balance; no external payment'}));
  if(!state.project_id){const project=await ok('POST','/api/v1/projects',{kind:'generation',name:'真实Copilot渐进底稿本地验证（合成材料）',issuer_name:'合成海岳交通集团有限公司',market:'sse',offering:'private'});state.project_id=project.project_id;state.path='/api/v1/projects/'+state.project_id;state.base=state.path+'/workpapers';await save();}
  const sourcePath=join(output,'synthetic-prospectus.docx');if(!state.source)await runPython(sourceScript,[sourcePath]);
  if(!state.source){state.source=await upload('合成募集说明书-本地测试.docx',await readFile(sourcePath),'application/vnd.openxmlformats-officedocument.wordprocessingml.document','historical');await save();}
  if(!state.selected_source){const versions=await ok('GET',state.path+'/prospectus-versions');state.selected_source=await ok('POST',state.path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions.find(v=>v.material_id===state.source.material_id)?.version_id??versions.versions[0].version_id});await save();}
  const rows=[['编号','文件名称','分类'],['1-1','发行人基本情况综合核查记录','第一章 发行人及财务核查'],['1-2','主要子公司财务情况专项核查文件','第一章 发行人及财务核查'],['1-3','有息债务及偿债安排专项核查文件','第一章 发行人及财务核查'],['2-1','募集资金用途专项核查文件','第二章 募集资金核查']];
  const catalogue=await headerlessCatalogueXlsx(rows);await writeFile(join(output,'synthetic-catalogue.xlsx'),catalogue);
  if(!state.catalogue){const material=await upload('合成底稿目录.xlsx',catalogue,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');state.catalogue=await ok('POST',state.base+'/catalogues',{request_id:randomUUID(),material});await save();}
  const chapters=workpaperChapters(state.catalogue.entries);assert.equal(chapters.length,2,'Exactly two chapters must be parsed');
  assert.equal(state.catalogue.entries.filter(e=>e.kind==='file').length,4,'Exactly four files must be parsed');
  state.price=(await ok('GET',state.base)).price;assert.equal(state.price.auto_charge,true,'Current automatic billing must be enabled');
  state.prepared_at=new Date().toISOString();await event('prepared',{project_id:state.project_id,chapters:chapters.map(c=>({id:c.id,title:c.title})),price:state.price,model:publicConfig,storage_container:state.container});
};
const executeWave=async(label)=>{
  const runtime=workerRuntimeOptionsFromEnv(pool,blobs,{...process.env,BB_WORKER_JOB_KINDS:'run',BB_WORKER_RUN_KINDS:'generation',BB_WORKER_LEASE_SECONDS:'120'});
  await advanceWorkpaperBatch(pool);await advanceWorkpaperBatch(pool);
  const before=await checkpoint(label+'-admitted');
  if(before.batch.state==='complete'||before.batch.progressive.phase==='awaiting_confirmation'){
    await downloadAvailable(label+'-already-delivered');return before;
  }
  assert.ok(['queued','running'].includes(before.batch.state),'A paused/failed/reconciliation batch requires explicit recovery outside this smoke helper');
  const jobs=(await pool.query(`SELECT j.state,j.lease_until,(j.state='queued' OR j.state='running' AND j.lease_until<now()) claimable
    FROM bb_workpaper_items i JOIN bb_jobs j ON j.owner_user_id=i.owner_user_id AND j.run_id=i.run_id
    JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
    WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND r.state NOT IN ('succeeded','failed','cancelled','rejected','test_completed')`,[state.owner,state.batch_id])).rows;
  assert.ok(jobs.length>=1&&jobs.length<=2&&jobs.every(j=>j.claimable),'Only 1–2 queued or safely expired runs may be resumed; do not overlap an active worker or bypass reconciliation');
  if(label==='trial'&&!before.batch.items.some(i=>i.state==='succeeded'))assert.equal(jobs.length,2,'Both fresh trial runs must be admitted together');
  const execute=slot=>runPipelineOnce({pool,blobs,stages:runtime.runStages,leaseSeconds:runtime.leaseSeconds,runKinds:['generation'],
    reviewedContextLoader:runtime.reviewedContextLoader,testRuleCapabilityLoader:runtime.testRuleCapabilityLoader,loadGenerationIssuerBinding:runtime.loadGenerationIssuerBinding,
    produceTargetPeriodCandidates:runtime.produceTargetPeriodCandidates,onUnexpectedError:error=>{console.error(JSON.stringify({phase:'worker_error',slot,...error}));}})
    .then(outcome=>({slot,outcome}),error=>({slot,outcome:'threw',error}));
  const pending=new Map(jobs.map((_,slot)=>[slot,execute(slot)])),outcomes=[];
  try{
    while(pending.size){
      const finished=await Promise.race(pending.values());pending.delete(finished.slot);outcomes.push(finished);
      await event('worker_finished',{label,slot:finished.slot,outcome:finished.outcome,other_worker_pending:pending.size>0});
      await downloadAvailable(label+'-'+outcomes.length+'-delivered');
      await checkpoint(label+'-'+outcomes.length+'-delivered');
    }
  }finally{
    // A diagnostic/download error must not close the pool underneath a sibling's
    // already-authorized real provider call. Let its durable outcome settle first.
    await Promise.all(pending.values());
  }
  await advanceWorkpaperBatch(pool);
  for(const outcome of outcomes)assert.equal(outcome.outcome,'succeeded',`${label} run did not succeed; inspect retained evidence before any explicit recovery`);
  return checkpoint(label+'-finished');
};
try{
  if(mode==='--inspect'){
    await checkpoint('inspection');if(state.batch_id)await downloadAvailable('inspection');
    await event('inspection_complete');
  }else{
    await prepare();
    if(mode==='--execute'){
      assert.equal(process.platform,'linux','Real contained authoring must run in the Linux worker environment');
      if(!state.request){state.request={progressive:{chapter_order:workpaperChapters(state.catalogue.entries).map(c=>c.id)},start_mode:'direct',request_id:randomUUID(),catalogue_id:state.catalogue.catalogue_id,catalogue_sha256:state.catalogue.sha256,
        item_ids:state.catalogue.entries.filter(e=>e.kind==='file').map(e=>e.id),source_version_id:state.selected_source.current_version_id,source_selection_revision:state.selected_source.selection_revision,
        requirements:'本次为合成材料本地功能测试。只编制所选四份文件；保留与各项相关的全部表格明细、单位、期间和合并/单体口径差异，不伪造外部查询、访谈、原件或签章。正文只写文件结果，来源追踪留在内部。',
        price_version:state.price.version,expected_points:(BigInt(state.price.points)*4n).toString()};state.submitted_at=new Date().toISOString();await save();}
      if(!state.batch_id){const batch=await ok('POST',state.base+'/batches',state.request);state.batch_id=batch.batch_id;await event('batch_submitted',{batch_id:batch.batch_id,trial_item_ids:batch.progressive.trial_item_ids});}
      let evidence=await checkpoint('execution-start');
      if(evidence.batch.state==='complete')await event('already_complete_no_model_call');
      else{
        if(evidence.batch.progressive.phase==='trial')evidence=await executeWave('trial');
        if(evidence.batch.progressive.phase==='awaiting_confirmation'){
          assert.equal(evidence.batch.items.filter(i=>i.state==='succeeded').length,2,'Both trial files must succeed');
          assert.equal(evidence.batch.items.filter(i=>!i.run_id).length,2,'The remainder must have no run before confirmation');
          assert.equal(evidence.groups.length,0,'No group planning is allowed before confirmation');
          assert.equal(evidence.calls.length,2,'Exactly two real trial attempts are expected before confirmation');
          await downloadAvailable('trial-before-confirmation');
          assert.equal(state.downloads.length,2,'Both trial Word files must be downloaded before confirmation');
          assert.equal(await advanceWorkpaperBatch(pool),false,'The confirmation fence must block new admission');
          await event('trial_fence_verified',{downloaded:2,remaining_unstarted:2,source_snapshots:evidence.source_snapshots});
          state.confirmation??={action:'continue_remaining',expected_revision:evidence.batch.revision,request_id:randomUUID()};await save();
          await ok('POST',state.base+`/batches/${state.batch_id}/actions`,state.confirmation);state.confirmed_at=new Date().toISOString();await event('remaining_confirmed_by_smoke_workflow');
        }else{
          assert.equal(evidence.batch.progressive.phase,'remaining','Do not skip a failed, paused or unresolved trial');
          await event('confirmed_remainder_resumed_without_reconfirmation');
        }
        evidence=await executeWave('remaining');
      }
      assert.equal(evidence.batch.state,'complete','All four files must complete');
      assert.equal(evidence.source_snapshots,1,'The batch must share one extracted source snapshot');
      assert.equal(evidence.groups.length,1,'Exactly one immutable remaining group receipt is expected');
      assert.ok(evidence.runtime.length===evidence.calls.length&&evidence.runtime.every(r=>r.adapter==='codex_exec'&&r.model_provider==='copilot_enterprise'),'All model calls must have durable real Copilot runtime evidence');
      await downloadAvailable('complete');
      assert.equal(state.downloads.length,4,'Every file must be downloaded');
      const generated=evidence.batch.items.filter(i=>i.artifacts.length&&!i.explanation).length,explanations=evidence.batch.items.filter(i=>i.explanation).length;
      state.result={functional_complete:true,generated_documents:generated,explanations,group_target_passed:evidence.groups[0].receipt.status==='items'&&evidence.calls.length===3,group_disposition:evidence.groups[0].receipt.status,model_calls:evidence.calls.length};
      await save();
      assert.equal(generated,4,'This evidence-complete synthetic sample must produce four substantive files, not four missing-material explanations');
      state.completed_at??=new Date().toISOString();state.total_from_submission_ms=Date.parse(state.completed_at)-Date.parse(state.submitted_at);
      await event('smoke_complete',{files:4,...state.result,source_snapshots:evidence.source_snapshots,first_download_ms:Math.min(...state.downloads.map(d=>d.from_submission_ms)),total_ms:state.total_from_submission_ms,charged_points:evidence.batch.charged_points});
    }
  }
}catch(error){
  const message=String(error.message??error).replace(/(?:https?|postgres(?:ql)?):\/\/\S+/g,'[connection]').slice(0,1500);
  await event('smoke_failed',{name:error.name??'Error',message});
  try{await checkpoint('failure');if(state.batch_id)await downloadAvailable('failure');}catch{console.error('Evidence snapshot incomplete; durable database and Azurite objects are preserved.');}
  process.exitCode=1;
}finally{await app.close();await pool.end();}
