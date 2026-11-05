import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {runtime,repo,pgBase} from './config.mjs';
import {createServer} from '../../apps/api/dist/server.js';
import {digest,transaction} from '../../apps/api/dist/data.js';
import {activePrice} from '../../apps/api/dist/billing.js';
import {automaticBillingEnabled,withAutomaticBilling,pinnedAutomaticPriceVersion} from '../../apps/api/dist/automatic-billing-context.js';
import {AUTOMATIC_PRICE_VERSION,LEGACY_AUTOMATIC_PRICE_VERSION,OUTCOME_PRICE_VERSION} from '../../packages/contracts/dist/index.js';

// Dedicated fresh local database, but a SINGLE Pool is shared by every real API
// configuration below. Separate Pools would hide configuration cross-talk.
// Fixtures are explicit synthetic users/material metadata. No payment, task,
// journal, model call, price publication or production connection is created.
const startedAt=new Date().toISOString(),attempt=randomUUID(),origin='https://synthetic-policy-conflict.invalid';
const database='bb_policy_conflict_'+attempt.replaceAll('-',''),connection=pgBase+database;
assert.match(database,/^bb_policy_conflict_[a-f0-9]{32}$/);
const maintenance=new Pool({connectionString:pgBase+'postgres',max:1});
const pool=new Pool({connectionString:connection,max:4}),owner=randomUUID(),apps=[],checks=[],observations=[],migrations=[];
let created=false;
async function prepareDatabase(){
  // The identifier is generated above, never accepted from an environment,
  // template, running instance or report. Only this empty local DB is migrated.
  await maintenance.query(`CREATE DATABASE "${database}"`);created=true;
  await pool.query('CREATE TABLE bb_schema_migrations(filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const directory=join(repo,'db/migrations');
  for(const filename of (await readdir(directory)).filter(name=>/^\d+.*\.sql$/.test(name)).sort()){
    await transaction(pool,async client=>{
      await client.query(await readFile(join(directory,filename),'utf8'));
      await client.query('INSERT INTO bb_schema_migrations(filename) VALUES($1)',[filename]);
    });migrations.push(filename);
  }
}
const gates=new Map();
async function rendezvous(key){
  if(!gates.has(key)){let resolve;const promise=new Promise(done=>{resolve=done;});gates.set(key,{arrivals:0,promise,resolve});}
  const gate=gates.get(key);if(++gate.arrivals===2)gate.resolve();
  let timeout;
  try{await Promise.race([gate.promise,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Concurrent request rendezvous timed out')),5000);})]);}
  finally{clearTimeout(timeout);}
}
const create=automatic=>{
  const app=createServer({pool,allowedOrigin:origin,enableSubscriptionBilling:automatic,enableOutcomePricing:false,
    enablePaidReview:true,principal:async()=>({userId:owner,csrfVerified:true}),paymentProviders:[]});
  // Non-listening synthetic probe forces both real request contexts to overlap
  // before and inside their real transactions on this one shared connection Pool.
  app.get('/__synthetic/policy-context',async request=>{
    const group=request.query.group;
    await rendezvous(group+':request');
    const before=automaticBillingEnabled(pool);
    const sampled=await transaction(pool,async client=>{
      await rendezvous(group+':transaction');
      const initial=automaticBillingEnabled(client),initialPrice=(await activePrice(client,true)).id;
      const pinned=await withAutomaticBilling(client,true,async()=>{
        await new Promise(setImmediate);
        return{enabled:automaticBillingEnabled(client),price:(await activePrice(client,true)).id,pin:pinnedAutomaticPriceVersion(client)};
      },LEGACY_AUTOMATIC_PRICE_VERSION);
      const manual=await withAutomaticBilling(client,false,async()=>({enabled:automaticBillingEnabled(client),price:(await activePrice(client,true)).id}));
      return{initial,initialPrice,pinned,manual,restored:automaticBillingEnabled(client),restoredPrice:(await activePrice(client,true)).id,
        restoredPin:pinnedAutomaticPriceVersion(client)??null};
    });
    return{before,...sampled,after:automaticBillingEnabled(pool)};
  });
  apps.push(app);return app;
};
const send=(app,method,url,payload)=>app.inject({method,url,payload,headers:{origin}});
const ok=response=>{assert.ok(response.statusCode>=200&&response.statusCode<300,response.body);return response.json();};
const catalog=async app=>ok(await send(app,'GET','/api/v1/commerce/catalog'));
async function newReview(app,label){
  const project=ok(await send(app,'POST','/api/v1/projects',{kind:'review',name:'Synthetic policy conflict '+label,issuer_name:null,market:null,offering:null})).project_id;
  const upload=randomUUID(),material=randomUUID(),sha=digest('explicit synthetic policy-conflict material');
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,'historical',$5,now()+interval '1 hour','completed')`,[upload,owner,project,sha,'synthetic/'+upload]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',16,$5,$6,'persisted')`,[material,owner,project,upload,sha,'synthetic/'+material]);
  const pin={material_id:material,material_version:1,sha256:sha};
  ok(await send(app,'PUT',`/api/v1/projects/${project}/review-draft`,{kind:'input',expected_version:0,input:{source_material_ref:pin,material_versions:[pin],requirements:[],as_of:null}}));
  const intent={execution_request_id:randomUUID(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
  return{project,quote:ok(await send(app,'POST',`/api/v1/projects/${project}/review-executions/quote`,intent)).quote};
}
function verify(name,passed,details){checks.push({name,passed});observations.push({name,passed,...details});}
let failure;
try{
  await prepareDatabase();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_policy_'+owner.slice(0,8)]);
  const automatic=create(true),baseline=await catalog(automatic),first=await newReview(automatic,'baseline');
  assert.equal(baseline.model,'subscription_and_topup');assert.equal(first.quote.auto_charge,true);assert.equal(first.quote.quote_status,'ready');
  verify('automatic API baseline has an executable automatic quote',true,{catalog:baseline.model,quote:first.quote});

  const legacy=create(false),afterLegacy=await catalog(automatic),newAutomatic=await newReview(automatic,'after-legacy');
  verify('creating a legacy API on the same Pool cannot change the existing automatic API catalogue',
    afterLegacy.model===baseline.model,{expected:baseline.model,actual:afterLegacy.model});
  verify('creating a legacy API on the same Pool cannot turn a new automatic task into pending manual scope',
    newAutomatic.quote.auto_charge===true&&newAutomatic.quote.quote_status==='ready'&&newAutomatic.quote.price_version===first.quote.price_version,
    {expected:{auto_charge:true,quote_status:'ready',price_version:first.quote.price_version},actual:newAutomatic.quote});
  const legacyBaseline=await catalog(legacy);
  assert.equal(legacyBaseline.model,'pay_as_you_go');assert.equal(legacyBaseline.enabled,false);
  const secondAutomatic=create(true),legacyAfterAutomatic=await catalog(legacy),originalRestored=await catalog(automatic);
  verify('creating an automatic API on the same Pool cannot advertise its tariff in the existing legacy API',
    legacyAfterAutomatic.model===legacyBaseline.model&&legacyAfterAutomatic.enabled===legacyBaseline.enabled,
    {expected:{model:legacyBaseline.model,enabled:legacyBaseline.enabled},actual:{model:legacyAfterAutomatic.model,enabled:legacyAfterAutomatic.enabled}});
  verify('creating a later API does not require the original automatic API to be rebuilt',originalRestored.model===baseline.model,{actual:originalRestored.model});
  await secondAutomatic.close();
  const legacyAfterClose=await catalog(legacy);
  verify('closing the other API cannot leave the legacy API with an automatic tariff',legacyAfterClose.model===legacyBaseline.model,
    {expected:legacyBaseline.model,actual:legacyAfterClose.model});
  for(let round=0;round<4;round++){
    const group=randomUUID(),samples=await Promise.all([automatic,legacy].map(app=>send(app,'GET',`/__synthetic/policy-context?group=${group}`).then(ok)));
    const independent=samples.every((sample,index)=>{
      const enabled=index===0,price=enabled?AUTOMATIC_PRICE_VERSION:OUTCOME_PRICE_VERSION;
      return sample.before===enabled&&sample.initial===enabled&&sample.initialPrice===price&&sample.restored===enabled&&sample.restoredPrice===price&&sample.after===enabled;
    });
    const pins=samples.every(sample=>sample.pinned.enabled===true&&sample.pinned.price===LEGACY_AUTOMATIC_PRICE_VERSION&&sample.pinned.pin===LEGACY_AUTOMATIC_PRICE_VERSION
      &&sample.manual.enabled===false&&sample.manual.price===OUTCOME_PRICE_VERSION&&sample.restoredPin===null);
    verify(`overlapping automatic/legacy requests retain separate Pool and client contexts, round ${round+1}`,independent,{samples});
    verify(`explicit accepted-contract client overrides and historical tariff pins win then restore, round ${round+1}`,pins,{samples});
  }
  const facts=(await pool.query(`SELECT
    (SELECT count(*)::int FROM bb_runs WHERE owner_user_id=$1) runs,
    (SELECT count(*)::int FROM bb_credit_events WHERE owner_user_id=$1) credit_events,
    (SELECT count(*)::int FROM bb_model_call_attempts WHERE owner_user_id=$1) model_calls`,[owner])).rows[0];
  verify('the configuration probe performs no payment, charge, task or model call',facts.runs===0&&facts.credit_events===0&&facts.model_calls===0,{facts});
}catch(error){failure={name:error.name,message:error.message};}
finally{
  const closed=await Promise.allSettled(apps.map(app=>app.close()));
  for(const result of closed)if(result.status==='rejected')failure??={name:'ApiCleanupError',message:String(result.reason)};
  try{await pool.end();if(created){assert.match(database,/^bb_policy_conflict_[a-f0-9]{32}$/);await maintenance.query(`DROP DATABASE "${database}"`);}}
  catch(error){failure??={name:'DatabaseCleanupError',message:String(error)};}
  finally{await maintenance.end();}
  await mkdir(runtime,{recursive:true});
  const path=join(runtime,`billing-policy-conflict-${startedAt.replaceAll(':','-')}-${attempt}.json`);
  const result={startedAt,attempt,owner,database,migrations:migrations.length,samePool:true,synthetic:true,
    limitation:'Multiple API instances intentionally share one Pool. This does not establish a defect in the ordinary one-API-per-process deployment.',
    checks,observations,...(failure?{error:failure}:{}),passed:!failure&&checks.every(check=>check.passed)};
  await writeFile(path,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({evidence:path,passed:result.passed,checks:checks.length,failed:checks.filter(check=>!check.passed).map(check=>check.name),...(failure?{error:failure}:{})},null,2));
  if(!result.passed)process.exitCode=1;
}
