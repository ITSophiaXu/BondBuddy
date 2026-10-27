// Real PG interleaving over synthetic files and credits. The query proxy only
// schedules a pause after a completed SELECT; every query runs against PG.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { isolatedTestDatabase } from './test-database.js';
import { digest, transaction, uid } from './data.js';
import { grantCredits } from './billing.js';
import { quoteM4, readM4CreditCharge, reserveM4 } from './m4-billing.js';
import { inputManifestHash } from './production-rule-pin.js';
import { createRunSupplementFilePreparationFixture } from './run-supplement-file-preparation-test-fixture.js';

const connection=await isolatedTestDatabase(undefined,'supplement-billing-snapshot');
const ok=(response:{statusCode:number;body:string;json():any})=>{assert.equal(response.statusCode,200,response.body);return response.json();};

test('M4 polling sees one execution fee when production adoption commits between fee and progress reads',
  {skip:!connection,timeout:120000},async()=>{
    const f=await createRunSupplementFilePreparationFixture(connection!,'m4',{beforeClaim:async({pool,owner,projectId,runId,manifest})=>{
      await transaction(pool,async db=>{
        await db.query('SELECT id FROM bb_projects WHERE id=$1 FOR UPDATE',[projectId]);
        const run=(await db.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
        await db.query('SELECT id FROM bb_jobs WHERE run_id=$1 FOR UPDATE',[runId]);
        await grantCredits(db,{owner,points:50000,key:uid(),source:'existing_grant',expiresAt:null,actor:'synthetic',reason:'Isolated snapshot interleaving wallet'});
        const hash=inputManifestHash(manifest),quote=await quoteM4(db,owner,manifest.topic_id,manifest.billing_task,hash,manifest);
        await reserveM4(db,owner,run,quote.quote.quote_id,manifest.topic_id,hash);
      });
    }});
    let release=()=>{},observed=false;
    const released=new Promise<void>(resolve=>{release=resolve;});
    let entered=()=>{};const atFee=new Promise<void>(resolve=>{entered=resolve;});
    let reading:ReturnType<typeof readM4CreditCharge>|undefined;
    try{
      const access=uid(),csrf=uid(),origin='http://bondbuddy.test';
      await f.pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
        VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,[uid(),f.owner,digest(access),digest(uid()),digest(csrf)]);
      const send=(method:'GET'|'POST',url:string,payload?:any)=>f.app.inject({method,url,payload,
        headers:{origin,cookie:`bb_session=${access}; bb_csrf=${csrf}`,'x-bb-csrf':csrf}});
      const base=`/api/v1/runs/${f.runId}`,quote=ok(await send('POST',base+'/supplement-quotes',{
        request_id:uid(),supplement_revision:f.saved.revision,saved_request_id:f.saved.request_id,
        candidate_input_hash:f.saved.input_preview.candidate_input_hash}));
      const confirmation=ok(await send('POST',base+`/supplement-quotes/${quote.quote.quote_id}/confirm`,{
        request_id:uid(),quote_hash:quote.quote.quote_hash}));
      const old=await readM4CreditCharge(f.pool,f.owner,f.runId);
      assert.ok(old.quote);assert.ok(old.progress);assert.ok(old.progress.charged_points>0);
      const intercept=async(args:any[],query:(...args:any[])=>Promise<any>)=>{
        const result=await query(...args),sql=typeof args[0]==='string'?args[0]:args[0]?.text;
        if(!observed&&sql?.includes('FROM bb_run_execution_billing_bindings b')){
          observed=true;entered();await released;
        }
        return result;
      };
      const monitored=new Proxy(f.pool,{
        get(target,property){
          if(property==='query')return (...args:any[])=>intercept(args,target.query.bind(target) as any);
          if(property==='connect')return async()=>{
            const client=await target.connect(),query=client.query.bind(client),free=client.release.bind(client);
            client.query=((...args:any[])=>intercept(args,query as any)) as PoolClient['query'];
            client.release=(error?:Error|boolean)=>{client.query=query;client.release=free;free(error);};
            return client;
          };
          const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
        },
      }) as Pool;
      reading=readM4CreditCharge(monitored,f.owner,f.runId);
      await Promise.race([atFee,reading.then(()=>{throw Error('Reader did not reach the fee-selection barrier');})]);
      const adopted=ok(await send('POST',base+'/supplement-adoptions',{request_id:uid(),quote_id:quote.quote.quote_id,
        quote_hash:quote.quote.quote_hash,confirmation_id:confirmation.confirmation.confirmation_id})).adoption;
      release();
      const during=await reading;
      assert.equal(during.quote?.quote_id,old.quote.quote_id);
      assert.equal(during.state,old.state);
      assert.equal(during.progress?.charged_points,old.progress.charged_points,'The original quote cannot contain the new execution meter');
      const after=await readM4CreditCharge(f.pool,f.owner,f.runId);
      assert.equal(after.quote?.quote_id,adopted.quote_id);assert.notEqual(after.quote?.quote_id,old.quote.quote_id);
      assert.equal(after.state,'held');assert.equal(after.progress?.charged_points,0);
      assert.equal(after.quote?.points,adopted.additional_points);
      ok(await send('POST',base+'/cancel',{reason:'Private concurrency fixture cleanup'}));
    }finally{release();await reading?.catch(()=>undefined);await f.cleanup();}
  });
