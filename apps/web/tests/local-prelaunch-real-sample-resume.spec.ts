import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {billingApi,billingConfig,billingLedger,type BillingAudit} from './local-prelaunch-billing-helpers';
import {finishRealSample,readRealSampleReceipt} from './local-prelaunch-real-sample-helpers';
import {evidenceLifecycle,finalizeEvidence} from './local-prelaunch-evidence';
import {qualityHarnessSourceIdentity} from './local-prelaunch-helpers';

const directory=process.env.BB_PRELAUNCH_RQ_RESUME_DIR;
test.skip(!directory||process.env.BB_E2E_LOCAL_PRELAUNCH!=='1'||process.env.BB_E2E_REAL_MODEL!=='1'||process.env.BB_E2E_RQ_REAL_SAMPLE!=='1',
  'Explicit existing authorized real-sample run directory required.');
test.use({viewport:{width:1440,height:1000},...(directory?{storageState:join(directory,'session.json')}:{})});
test.setTimeout(7200000);

test('observe the original full-prospectus run after a harness interruption without starting another task',async({page},info)=>{
  const receipt=readRealSampleReceipt(directory!),timeline:any[]=[],lifecycle=evidenceLifecycle();
  const sourceIdentity=qualityHarnessSourceIdentity();
  let finalLedgerObserved=false,ownerVerified=false;
  const evidence=join(directory!,'observation-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  const render=(finalized=false)=>JSON.stringify({schema:'local-prelaunch-real-sample-resumed-observation-v1',
    originalRunId:receipt.runId,projectId:receipt.projectId,owner:receipt.owner,...lifecycle.state(info,finalized),timeline,
    taskCreated:false,taskResumed:false,originalCredentialsDisclosed:false,sourceIdentity,finalLedgerObserved},null,2);
  const write=(text:string)=>writeFileSync(evidence,text),save=()=>write(render());
  const audit:BillingAudit={owner:receipt.owner,username:receipt.username,directory:directory!,
    record(label,value){timeline.push({at:new Date().toISOString(),label,value});save();},
    checkpoint(label){const ledger=billingLedger(receipt.owner);timeline.push({at:new Date().toISOString(),label,ledger});save();return ledger;}};
  try{
    save();const config=billingConfig();
    await page.goto(config.origin);
    const status=await page.request.get('/__prelaunch/status');expect(status.status()).toBe(200);
    const environment=await status.json();expect(environment.instance_id).toBe(config.instanceId);expect(environment.model_results_synthetic).toBe(false);
    const me=await billingApi(page,'GET','/api/v1/me');expect(me.status).toBe(200);expect(me.body.user_id).toBe(receipt.owner);
    ownerVerified=true;
    const before=billingLedger(receipt.owner);expect(before.runs).toHaveLength(1);expect(before.runs[0].id).toBe(receipt.runId);
    audit.record('original-run-observation-restored',{environment,before});
    await page.goto(`/#/projects/${receipt.projectId}?run=${receipt.runId}`);
    lifecycle.enter('test');
    await finishRealSample(page,audit,receipt);
  }catch(error){lifecycle.fail(error);}
  finally{
    lifecycle.enter('teardown');
    if(ownerVerified){try{timeline.push({label:'final-ledger',ledger:billingLedger(receipt.owner)});finalLedgerObserved=true;}catch(error){timeline.push({label:'final-ledger-error',error:String(error)});lifecycle.fail(error,'final-ledger');}}
    if(!finalLedgerObserved&&lifecycle.state(info,true).status==='passed')lifecycle.fail(new Error('A successful resumed observation requires a final ledger observation'),'final-ledger');
    await finalizeEvidence({lifecycle,render,write,attach:text=>info.attach('original-run-resumed-observation',{body:Buffer.from(text),contentType:'application/json'})});
  }
});
