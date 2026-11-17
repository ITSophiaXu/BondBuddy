import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readdir,writeFile,mkdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {chromium} from 'playwright';
import {createServer} from '../../apps/api/dist/server.js';
import {azureBlobs,digest,transaction} from '../../apps/api/dist/data.js';
import {grantCredits,creditBalance} from '../../apps/api/dist/billing.js';

import {isolatedTestDatabase} from '../../apps/worker/dist/test-database.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce} from '../../apps/worker/dist/run-pipeline.js';
import {integrityModelStage,integrityDeliveryStage} from '../../apps/worker/dist/integrity-stage.js';
import {integrityWebsiteFixture} from '../../apps/worker/dist/integrity-browser-fixture.js';

// Deliberately send an unmatched reply into the installed Playwright CDP transport.
// This executes the dependency's real assertion; no Error or stack is fabricated.
function unmatchedReply(browser){
 const implementation=browser._connection.toImpl(browser);
 const transport=implementation._connection._transport;
 assert.equal(typeof transport.onmessage,'function');
 setImmediate(()=>{void transport.onmessage({id:2147483647,result:{}});});
}
const source=process.env.BB_VERIFICATION_SOURCE;
assert.match(source??'',/^[a-f0-9]{40}$/,'BB_VERIFICATION_SOURCE must pin the tested revision');
const output=process.env.BB_INTEGRITY_TEST_OUTPUT_DIRECTORY;
assert.ok(output,'BB_INTEGRITY_TEST_OUTPUT_DIRECTORY required');
await mkdir(output,{recursive:true});
const negative=spawnSync(process.execPath,['--input-type=module','-e',`
 import {chromium} from 'playwright';
 const browser=await chromium.launch({headless:true});
 const transport=browser._connection.toImpl(browser)._connection._transport;
 setImmediate(()=>{void transport.onmessage({id:2147483647,result:{}});});
 await new Promise(resolve=>setTimeout(resolve,3000));
 await browser.close();
 throw Error('Negative control unexpectedly survived');
`],{encoding:'utf8',timeout:30000});
assert.equal(negative.status,1,negative.stderr);
assert.match(negative.stderr,/at _CRSession\._onMessage /);
assert.match(negative.stderr,/at CRConnection\._onMessage /);
await writeFile(output+'/negative-control.log',negative.stderr);
process.stdout.write('PASS negative control: actual CDP assertion exits process with code 1\n');
const database=await isolatedTestDatabase(undefined,'integrity-cdp-1449');
assert.ok(database);assert.ok(process.env.BB_TEST_AZURITE_CONNECTION_STRING);
const pool=new Pool({connectionString:database}),owner=randomUUID(),other=randomUUID();
const container='bb-cdp-'+randomUUID().replaceAll('-','');
const blobs=azureBlobs(process.env.BB_TEST_AZURITE_CONNECTION_STRING,container);
let actor=owner;
const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',enableRunRuntime:true,principal:async()=>({userId:actor,csrfVerified:true})});
const send=(method,url,payload)=>app.inject({method,url,payload,headers:{origin:'http://bondbuddy.test'}});
const ok=async(method,url,payload)=>{const response=await send(method,url,payload);assert.ok(response.statusCode<300,response.body);return response.body?response.json():null;};
const originalLaunch=chromium.launch.bind(chromium);
let launches=0,injected=0,mode='first',modelCalls=0;
const browsers=[];
// The production collector, desktop, proxy, screenshots, cleanup and boundary run
// unchanged. Only the remote website responses and fault trigger are fixtures.
chromium.launch=async options=>{
 const browser=await originalLaunch(options);launches++;browsers.push(browser);
 const fail=mode==='all'||mode==='first'&&launches===1;
 const newContext=browser.newContext.bind(browser);
 browser.newContext=async options=>{
  const context=await newContext(options),newPage=context.newPage.bind(context);
  context.newPage=async()=>{
   await integrityWebsiteFixture(context,'zero');
   const page=await newPage();let fired=false;
   if(fail)page.on('requestfinished',request=>{
    if(!fired&&new URL(request.url()).pathname==='/result'){
     fired=true;injected++;unmatchedReply(browser);
    }
   });
   return page;
  };
  return context;
 };
 return browser;
};
const model=()=>({name:'forbidden_model',run:async()=>{modelCalls++;throw Error('Zero-result fixture must not call a model');}});
const execute=()=>runPipelineOnce({pool,blobs,leaseSeconds:120,runKinds:['generation'],stages:[inputLockStage,materialsReadyStage,integrityModelStage({model}),integrityDeliveryStage()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
const listeners=process.listenerCount('unhandledRejection');
const temporary=async()=>new Set((await readdir('/tmp')).filter(p=>p.startsWith('bb-integrity-browser-')));
const before=await temporary();
const receipts=[];
try{
 for(const id of [owner,other])await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'cdp_'+id.slice(0,8)]);
 await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:randomUUID(),points:30000,expiresAt:null,actor:'synthetic-test',reason:'Isolated CDP regression'}));
 const project=await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic CDP fault regression',issuer_name:'合成诚信测试企业',market:'sse',offering:'private'});
 const base='/api/v1/projects/'+project.project_id+'/integrity';
 await ok('POST',base+'/draft',{expected_revision:0,draft:{subjects:[{id:'issuer',kind:'company',name:'合成诚信测试企业',identifier:'',role:'发行人',province:'山东',city:'东营市'}],site_ids:['emergency','ndrc','tax'],notes:'Synthetic website responses; actual Playwright CDP failure'}});
 for(const current of ['first','none','all']){
  mode=current;
  const roundId=randomUUID();
  const quote=await ok('POST',base+'/quote',{expected_revision:1,round_id:roundId});
  assert.equal(quote.quote_status,'ready');assert.ok(Number(quote.points)>0);
  const start=await ok('POST',base+'/runs',{request_id:randomUUID(),round_id:roundId,expected_revision:1,price_version:quote.price_version,expected_points:quote.points,scope_quote_id:quote.scope_quote_id});
  let status=await execute();
  for(let poll=0;status==='idle'&&poll<30;poll++){await new Promise(resolve=>setTimeout(resolve,500));status=await execute();}
  assert.equal(status,current==='all'?'failed':'succeeded');
  const workspace=await ok('GET',base),round=workspace.rounds.find(r=>r.run_id===start.run_id);
  assert.ok(round,JSON.stringify(workspace));
  const failed=round.records.filter(r=>r.status==='query_failed');
  assert.equal(failed.length,current==='all'?3:current==='first'?1:0);
  for(const record of failed){assert.equal(record.search_performed,false);assert.equal(record.browser.diagnostic.detail,'INTEGRITY_BROWSER_RUNTIME_FAILED');assert.equal(record.browser.captures.length,0);}
  for(const record of round.records.filter(r=>r.status!=='query_failed')){assert.equal(record.status,'no_public_results');assert.equal(record.search_performed,true);assert.ok(record.browser.captures.length>0);}
  assert.equal(process.listenerCount('unhandledRejection'),listeners);
  assert.ok(browsers.every(browser=>!browser.isConnected()));
  assert.deepEqual(await temporary(),before,'collector temporary directories must be cleaned');
  if(current==='all'){assert.equal(round.artifacts.length,0);assert.equal(round.charged_points,'0');}
  else{
   assert.equal(round.artifacts.length,1);
   if(current==='first')assert.ok(Number(round.charged_points)>0&&Number(round.charged_points)<Number(quote.points));
   else assert.equal(round.charged_points,quote.points);
   const artifact=await ok('GET','/api/v1/artifacts/'+round.artifact_id),download=await send('GET',artifact.download_url);
   assert.equal(download.statusCode,200);assert.equal(digest(download.rawPayload),artifact.sha256);
   await writeFile(output+'/'+current+'.docx',download.rawPayload);
   actor=other;try{assert.equal((await send('GET',artifact.download_url)).statusCode,404);}finally{actor=owner;}
  }
  receipts.push({mode:current,run_id:start.run_id,status,quoted_points:quote.points,records:round.records.map(r=>({site:r.site_id,status:r.status,queried:r.search_performed,captures:r.browser.captures.length})),artifacts:round.artifacts.length,charged_points:round.charged_points,balance:await creditBalance(pool,owner)});
  process.stdout.write('PASS '+JSON.stringify(receipts.at(-1))+'\n');
 }
 assert.equal(launches,9);assert.equal(injected,4);assert.equal(modelCalls,0);
 const balance=await creditBalance(pool,owner);assert.deepEqual(balance,{available:30000-receipts.reduce((sum,r)=>sum+Number(r.charged_points),0),frozen:0});
 await writeFile(output+'/verification.json',JSON.stringify({source,playwright:'1.63.0',website_responses:'synthetic',actual_cdp_assertions:injected,model_calls:modelCalls,launches,receipts,listeners_restored:true,browsers_closed:true,temporary_directories_removed:true,balance},null,2));
}finally{
 chromium.launch=originalLaunch;
 await Promise.allSettled(browsers.map(browser=>browser.close()));
 await app.close();await pool.end();
 await BlobServiceClient.fromConnectionString(process.env.BB_TEST_AZURITE_CONNECTION_STRING).getContainerClient(container).deleteIfExists();
}
