// Real full main bundle + TCP HTTP/session/CSRF + owned PostgreSQL clone + actual
// production worker + private disk Word downloads. Supplier and credit lot are synthetic.
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,stat,unlink,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Pool} from 'pg';
import type {FastifyRequest,FastifyReply} from 'fastify';
import {createServer} from '../../api/dist/server.js';
import {isolatedTestDatabase} from '../../api/dist/test-database.js';
import {digest,uid,type PrivateBlobs} from '../../api/dist/data.js';
import {productionWordFixture,productionWordRunner,productionWordConfig,type Kind} from '../../worker/dist/run-supplement-production-test-fixture.js';

export type ProductionBrowser=Awaited<ReturnType<typeof startProductionSupplementBrowser>>;
export async function startProductionSupplementBrowser(kind:Kind){
  const template=process.env.BB_TEST_DATABASE_URL;assert.ok(template,'Set the dedicated migrated local template URL');
  const local=new URL(template),templateName=decodeURIComponent(local.pathname.slice(1));
  assert.ok(['127.0.0.1','localhost'].includes(local.hostname)&&local.port==='15542'&&templateName==='bb_prod_supplement02_20261027',
    'Only the dedicated 15542 production-supplement template is allowed');
  const connection=await isolatedTestDatabase(undefined,`production-browser-${kind}`);assert.ok(connection);
  const clone=new URL(connection),cloneName=decodeURIComponent(clone.pathname.slice(1)),prefix=`${templateName.slice(0,40)}_t${process.pid}_`;
  assert.ok(clone.hostname===local.hostname&&clone.port==='15542'&&clone.username===local.username&&cloneName.startsWith(prefix)&&
    cloneName!==templateName&&/^[a-zA-Z0-9_]+$/.test(cloneName)&&/^[a-f0-9]{8}$/.test(cloneName.slice(prefix.length)),'Owned clone required');
  const artifactRoot=resolve(process.env.BB_SUPPLEMENT_PRODUCTION_BROWSER_EVIDENCE_DIR??'../../.local/production-supplement-20261027/web-real-production',kind);
  const workRoot=join(artifactRoot,`worker-work-${process.pid}`),bytesRoot=join(artifactRoot,`private-bytes-${process.pid}`);
  await mkdir(workRoot,{recursive:true});await mkdir(bytesRoot,{recursive:true});
  const marker=join(artifactRoot,'synthetic-provider-calls.jsonl');
  const python=process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON;assert.ok(python,'Explicit Word Python runtime required');
  const baseConfig=productionWordConfig(workRoot,marker,python,resolve(process.cwd(),'../..'));
  const config={...baseConfig,command:[...baseConfig.command,'--reflect-material-markers']};
  const f=await productionWordFixture(connection,kind,config);
  const pathFor=(key:string)=>join(bytesRoot,digest(key));
  for(const [key,bytes] of f.objects)await writeFile(pathFor(key),bytes,{mode:0o600});
  const get=async(key:string)=>readFile(pathFor(key));
  const getIfExists=async(key:string)=>{try{return await get(key);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
  const blobs:PrivateBlobs={
    async put(key,bytes,media){await writeFile(pathFor(key),bytes,{mode:0o600});await f.blobs.put(key,bytes,media);},get,getIfExists,
    async getIfExistsBounded(key,max){try{if((await stat(pathFor(key))).size>max)throw Error('Private byte limit exceeded');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}return get(key);},
    async exists(key){return (await getIfExists(key))!==null;},
    async delete(key){try{await unlink(pathFor(key));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await f.blobs.delete(key);},
  };
  const baseURL='http://127.0.0.1:5199',app=createServer({pool:f.pool,blobs,allowedOrigin:baseURL,enableRunRuntime:true,enablePaidAuthoring:true,enablePaidReview:true});
  const activeHttp=new Map<string,{method:string;url:string;started_at:string}>();
  app.addHook('onRequest',async(request:FastifyRequest)=>{activeHttp.set(request.id,{method:request.method,url:request.url,started_at:new Date().toISOString()});});
  app.addHook('onResponse',async(request:FastifyRequest)=>{activeHttp.delete(request.id);});
  app.addHook('onRequestAbort',async(request:FastifyRequest)=>{activeHttp.delete(request.id);});
  const dist=resolve(process.cwd(),'dist');
  const html=await readFile(join(dist,'index.html')),favicon=await readFile(join(dist,'favicon.svg'));
  const assets=new Map<string,Buffer>();for(const name of await readdir(join(dist,'assets')))assets.set('/assets/'+name,await readFile(join(dist,'assets',name)));
  app.get('/',async(_request:FastifyRequest,reply:FastifyReply)=>reply.type('text/html; charset=utf-8').send(html));
  app.get('/assets/*',async(request:FastifyRequest,reply:FastifyReply)=>{const path=new URL(request.url,baseURL).pathname,bytes=assets.get(path);if(!bytes)return reply.code(404).send();return reply.type(path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'application/octet-stream').send(bytes);});
  app.get('/favicon.ico',async(_request:FastifyRequest,reply:FastifyReply)=>reply.code(204).send());
  app.get('/favicon.svg',async(_request:FastifyRequest,reply:FastifyReply)=>reply.type('image/svg+xml').send(favicon));
  await app.listen({host:'127.0.0.1',port:5199});
  const access=uid(),csrf=uid();
  await f.pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,[uid(),f.owner,digest(access),digest(uid()),digest(csrf)]);
  const headers={cookie:`bb_session=${access}; bb_csrf=${csrf}`,'x-bb-csrf':csrf,origin:baseURL};
  const request=async(method:string,path:string,body?:unknown)=>{
    const response=await fetch(baseURL+path,{method,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();assert.ok(response.ok,`${method} ${path}: ${response.status} ${text}`);return text?JSON.parse(text):null;
  };
  const execute=productionWordRunner({...f,blobs,config});
  const calls=async()=>{try{return (await readFile(marker,'utf8')).trim().split('\n').filter(Boolean).map(row=>JSON.parse(row));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}};
  const evidence=async()=>{
    const result:Record<string,unknown>={};
    for(const table of ['bb_runs','bb_jobs','bb_run_execution_versions','bb_run_execution_heads','bb_input_revisions','bb_run_supplement_drafts',
      'bb_run_supplement_quotes','bb_run_supplement_quote_confirmations','bb_run_supplement_adoptions','bb_run_billing_segments','bb_run_execution_billing_bindings',
      'bb_credit_reservations','bb_credit_events','bb_run_billing_progress','bb_model_call_attempts','bb_model_call_execution_bindings','bb_provider_result_refs',
      'bb_snapshot_refs','bb_artifact_versions','bb_run_execution_deliveries','bb_run_execution_delivery_artifacts','bb_run_events','bb_outbox'])
      result[table]=(await f.pool.query(`SELECT t.* FROM ${table} t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text`,[f.owner])).rows;
    return {...result,provider_calls:await calls()};
  };
  let closed=false;
  return {...f,blobs,baseURL,artifactRoot,bytesRoot,workRoot,marker,python,config,access,csrf,headers,request,execute,calls,evidence,cloneName,
    async close(closeState={business_evidence_complete:false,browser_at_blank:false,browser_context_closed:false}){if(closed)return;closed=true;
      const maintenance=new URL(clone);maintenance.pathname='/postgres';const cleanup=new Pool({connectionString:maintenance.toString(),max:1});
      const phases:Array<Record<string,unknown>>=[];
      const phase=async(name:string)=>{
        const activity=(await cleanup.query(`SELECT pid,state,wait_event_type,wait_event,backend_xid,backend_xmin,xact_start,query_start,query
          FROM pg_stat_activity WHERE datname=$1 ORDER BY pid`,[cloneName])).rows;
        const locks=(await cleanup.query(`SELECT locktype,database,relation,transactionid,pid,mode,granted
          FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=$1)
          OR pid IN(SELECT pid FROM pg_stat_activity WHERE datname=$1) ORDER BY pid,locktype,mode`,[cloneName])).rows;
        const sockets=await new Promise<number|null>(resolve=>app.server.getConnections((error:Error|null,count:number)=>resolve(error?null:count)));
        const row={phase:name,at:new Date().toISOString(),...closeState,http_connections:sockets,active_http:[...activeHttp.values()],
          pool:{total:f.pool.totalCount,idle:f.pool.idleCount,waiting:f.pool.waitingCount},pg_activity:activity,pg_locks:locks};
        phases.push(row);await writeFile(join(artifactRoot,'owned-cleanup-phases.json'),JSON.stringify(phases,null,2));return row;
      };
      try{
        await phase('before_app_close');
        try{
          const closing=app.close();let timer:ReturnType<typeof setTimeout>|undefined;
          const didClose=await Promise.race([closing.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),2000);})]);
          if(timer)clearTimeout(timer);
          if(!didClose){
            const pending=await phase('app_close_pending_2s');
            assert.ok(closeState.business_evidence_complete&&closeState.browser_at_blank&&closeState.browser_context_closed,'Only completed evidence and a closed blank browser can close owned idle HTTP sockets');
            assert.equal(activeHttp.size,0,'Never interrupt an unfinished HTTP request to pass cleanup');
            assert.equal(f.pool.waitingCount,0,'Never hide waiting business queries during cleanup');
            assert.ok(pending.pg_activity.every(row=>row.state==='idle'),'Never interrupt active or uncommitted database work');
            app.server.closeIdleConnections();app.server.closeAllConnections();await phase('owned_idle_http_connections_closed');
            await closing;
          }
          await phase('after_app_close');
        }finally{await phase('before_fixture_cleanup');await f.cleanup();await phase('after_fixture_cleanup');}
        await phase('before_owned_drop');await cleanup.query(`DROP DATABASE IF EXISTS "${cloneName}"`);await phase('after_owned_drop');
        const remaining=(await cleanup.query('SELECT datname FROM pg_database WHERE datname=$1',[cloneName])).rows;
        await writeFile(join(artifactRoot,'owned-cleanup.json'),JSON.stringify({clone_name:cloneName,clone_remaining:remaining,http_app_closed:true},null,2));
        assert.equal(remaining.length,0,'Owned clone cleanup must finish');
      }finally{await cleanup.end();}
    }};
}
