import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {billingApi,billingConfig,billingLedger,type BillingAudit} from './local-prelaunch-billing-helpers';
import {finishSyntheticLong,syntheticLongReceipt} from './local-prelaunch-synthetic-long-helpers';

const directory=process.env.BB_PRELAUNCH_SYNTHETIC_LONG_RESUME_DIR;
test.skip(!directory||process.env.BB_E2E_LOCAL_PRELAUNCH!=='1'||process.env.BB_E2E_REAL_MODEL!=='1'||process.env.BB_E2E_SYNTHETIC_LONG!=='1',
  'Explicit original synthetic run receipt and real-model observation opt-in required');
test.use({viewport:{width:1440,height:1000},...(directory?{storageState:join(directory,'session.json')}:{})});
test.setTimeout(7200000);
test('observe the original synthetic long run without recreating a project, payment or model task',async({page},info)=>{
  const receipt=syntheticLongReceipt(directory!),config=billingConfig(),timeline:any[]=[];
  let status='running';const evidence=join(directory!,'observation-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  const save=()=>writeFileSync(evidence,JSON.stringify({schema:'synthetic-long-observation-v1',status,originalRunId:receipt.runId,
    taskCreated:false,taskResumed:false,timeline,errors:info.errors.map(e=>({message:e.message}))},null,2));
  const audit:BillingAudit={owner:receipt.owner,username:receipt.username,directory:directory!,
    record(label,value){timeline.push({at:new Date().toISOString(),label,value});save();},
    checkpoint(label){const ledger=billingLedger(receipt.owner);timeline.push({at:new Date().toISOString(),label,ledger});save();return ledger;}};
  try{
    await page.goto(config.origin);const response=await page.request.get('/__prelaunch/status');expect(response.status()).toBe(200);
    const environment=await response.json();expect(environment.instance_id).toBe(config.instanceId);audit.record('actual-running-environment',environment);
    const me=await billingApi(page,'GET','/api/v1/me');expect(me.status).toBe(200);expect(me.body.user_id).toBe(receipt.owner);
    const before=billingLedger(receipt.owner);expect(before.runs).toHaveLength(1);expect(before.runs[0].id).toBe(receipt.runId);
    await finishSyntheticLong(page,audit,receipt);status='passed';
  }catch(error){status='failed';throw error;}
  finally{
    try{audit.checkpoint('final-actual-ledger');}catch(error){status='failed';save();throw error;}
    save();await info.attach('synthetic-long-original-run-observation',{path:evidence,contentType:'application/json'});
  }
});
