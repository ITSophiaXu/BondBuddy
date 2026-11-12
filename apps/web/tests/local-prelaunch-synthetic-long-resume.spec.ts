import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {billingApi,billingConfig,billingLedger,type BillingAudit} from './local-prelaunch-billing-helpers';
import {finishSyntheticLong,syntheticLongReceipt,syntheticLongInputs} from './local-prelaunch-synthetic-long-helpers';
import {assertImmutableQualityInput,qualityHarnessSourceIdentity} from './local-prelaunch-helpers';
import {evidenceLifecycle,finalizeEvidence} from './local-prelaunch-evidence';

const directory=process.env.BB_PRELAUNCH_SYNTHETIC_LONG_RESUME_DIR;
test.skip(!directory||process.env.BB_E2E_LOCAL_PRELAUNCH!=='1'||process.env.BB_E2E_REAL_MODEL!=='1'||process.env.BB_E2E_SYNTHETIC_LONG!=='1',
  'Explicit original synthetic run receipt and real-model observation opt-in required');
test.use({viewport:{width:1440,height:1000},...(directory?{storageState:join(directory,'session.json')}:{})});
test.setTimeout(7200000);
test('verify the original immutable target without submitting or observing a new task',async({request},info)=>{
  const receipt=syntheticLongReceipt(directory!),fixture=syntheticLongInputs(receipt.fixtureDirectory),config=billingConfig();
  const pinned=assertImmutableQualityInput(receipt,{issuer:fixture.manifest.issuer,cutoff:fixture.manifest.target_cutoff},fixture.files.map((file:any)=>file.sha256));
  const response=await request.get('/__prelaunch/status');expect(response.status()).toBe(200);
  const environment=await response.json();expect(environment.instance_id).toBe(config.instanceId);expect(environment.production_server).toBe(true);
  const evidence={schema:'quality-target-contract-recheck-v1',status:'passed',readOnly:true,taskCreated:false,paymentCreated:false,
    sourceIdentity:qualityHarnessSourceIdentity(),environment,pinned};
  const output=join(directory!,'target-contract-recheck-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  writeFileSync(output,JSON.stringify(evidence,null,2));await info.attach('immutable-target-contract-recheck',{path:output,contentType:'application/json'});
});
test('observe the original synthetic long run without recreating a project, payment or model task',async({page},info)=>{
  const receipt=syntheticLongReceipt(directory!),config=billingConfig(),timeline:any[]=[],pageErrors:string[]=[];
  const sourceIdentity=qualityHarnessSourceIdentity(),lifecycle=evidenceLifecycle();
  let finalLedgerObserved=false,ownerVerified=false;
  const evidence=join(directory!,'observation-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  page.on('pageerror',error=>pageErrors.push(error.message));
  const render=(finalized=false)=>JSON.stringify({schema:'synthetic-long-observation-v1',originalRunId:receipt.runId,
    ...lifecycle.state(info,finalized),taskCreated:false,taskResumed:false,sourceIdentity,timeline,pageErrors,finalLedgerObserved},null,2);
  const write=(text:string)=>writeFileSync(evidence,text),save=()=>write(render());
  const audit:BillingAudit={owner:receipt.owner,username:receipt.username,directory:directory!,
    record(label,value){timeline.push({at:new Date().toISOString(),label,value});save();},
    checkpoint(label){const ledger=billingLedger(receipt.owner);timeline.push({at:new Date().toISOString(),label,ledger});save();return ledger;}};
  try{
    save();
    await page.goto(config.origin);const response=await page.request.get('/__prelaunch/status');expect(response.status()).toBe(200);
    const environment=await response.json();expect(environment.instance_id).toBe(config.instanceId);audit.record('actual-running-environment',environment);
    const me=await billingApi(page,'GET','/api/v1/me');expect(me.status).toBe(200);expect(me.body.user_id).toBe(receipt.owner);
    ownerVerified=true;
    const before=billingLedger(receipt.owner);expect(before.runs).toHaveLength(1);expect(before.runs[0].id).toBe(receipt.runId);
    lifecycle.enter('test');await finishSyntheticLong(page,audit,receipt);
  }catch(error){lifecycle.fail(error);}
  finally{
    lifecycle.enter('teardown');
    if(ownerVerified){try{timeline.push({label:'final-ledger',ledger:billingLedger(receipt.owner)});finalLedgerObserved=true;}
      catch(error){timeline.push({label:'final-ledger-error',error:String(error)});lifecycle.fail(error,'final-ledger');}}
    try{expect(pageErrors).toEqual([]);}catch(error){lifecycle.fail(error,'page-errors');}
    if(!finalLedgerObserved&&lifecycle.state(info,true).status==='passed')lifecycle.fail(new Error('A successful resumed observation requires a final ledger observation'),'final-ledger');
    await finalizeEvidence({lifecycle,render,write,attach:text=>info.attach('synthetic-long-original-run-observation',{body:Buffer.from(text),contentType:'application/json'})});
  }
});
