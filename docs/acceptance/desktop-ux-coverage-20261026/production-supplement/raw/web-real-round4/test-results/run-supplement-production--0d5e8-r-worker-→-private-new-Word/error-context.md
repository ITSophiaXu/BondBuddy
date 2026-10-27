# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: run-supplement-production-real-main.spec.ts >> real desktop review: saved Word work → browser B1 quote/consent/adoption → real successor worker → private new Word
- Location: tests\run-supplement-production-real-main.spec.ts:31:56

# Error details

```
AssertionError: GET /api/v1/artifacts/word-996705ec6a570ef2a1d9eebda74890f1c97d22b8591493f42c9dba2b148fd25e: 404 {"code":"NOT_FOUND","message":"Resource does not exist","retryable":false,"field_errors":[],"correlation_id":"9ea18be9-1fb3-4550-b780-4235efebadfa"}
```

# Test source

```ts
  1  | // Real full main bundle + TCP HTTP/session/CSRF + owned PostgreSQL clone + actual
  2  | // production worker + private disk Word downloads. Supplier and credit lot are synthetic.
  3  | import assert from 'node:assert/strict';
  4  | import {mkdir,readFile,readdir,stat,unlink,writeFile} from 'node:fs/promises';
  5  | import {resolve,join} from 'node:path';
  6  | import {Pool} from 'pg';
  7  | import type {FastifyRequest,FastifyReply} from 'fastify';
  8  | import {createServer} from '../../api/dist/server.js';
  9  | import {isolatedTestDatabase} from '../../api/dist/test-database.js';
  10 | import {digest,uid,type PrivateBlobs} from '../../api/dist/data.js';
  11 | import {productionWordFixture,productionWordRunner,productionWordConfig,type Kind} from '../../worker/dist/run-supplement-production-test-fixture.js';
  12 | 
  13 | export type ProductionBrowser=Awaited<ReturnType<typeof startProductionSupplementBrowser>>;
  14 | export async function startProductionSupplementBrowser(kind:Kind){
  15 |   const template=process.env.BB_TEST_DATABASE_URL;assert.ok(template,'Set the dedicated migrated local template URL');
  16 |   const local=new URL(template),templateName=decodeURIComponent(local.pathname.slice(1));
  17 |   assert.ok(['127.0.0.1','localhost'].includes(local.hostname)&&local.port==='15542'&&templateName==='bb_prod_supplement02_20261027',
  18 |     'Only the dedicated 15542 production-supplement template is allowed');
  19 |   const connection=await isolatedTestDatabase(undefined,`production-browser-${kind}`);assert.ok(connection);
  20 |   const clone=new URL(connection),cloneName=decodeURIComponent(clone.pathname.slice(1)),prefix=`${templateName.slice(0,40)}_t${process.pid}_`;
  21 |   assert.ok(clone.hostname===local.hostname&&clone.port==='15542'&&clone.username===local.username&&cloneName.startsWith(prefix)&&
  22 |     cloneName!==templateName&&/^[a-zA-Z0-9_]+$/.test(cloneName)&&/^[a-f0-9]{8}$/.test(cloneName.slice(prefix.length)),'Owned clone required');
  23 |   const artifactRoot=resolve(process.env.BB_SUPPLEMENT_PRODUCTION_BROWSER_EVIDENCE_DIR??'../../.local/production-supplement-20261027/web-real-production',kind);
  24 |   const workRoot=join(artifactRoot,`worker-work-${process.pid}`),bytesRoot=join(artifactRoot,`private-bytes-${process.pid}`);
  25 |   await mkdir(workRoot,{recursive:true});await mkdir(bytesRoot,{recursive:true});
  26 |   const marker=join(artifactRoot,'synthetic-provider-calls.jsonl');
  27 |   const python=process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON;assert.ok(python,'Explicit Word Python runtime required');
  28 |   const baseConfig=productionWordConfig(workRoot,marker,python,resolve(process.cwd(),'../..'));
  29 |   const config={...baseConfig,command:[...baseConfig.command,'--reflect-material-markers']};
  30 |   const f=await productionWordFixture(connection,kind,config);
  31 |   const pathFor=(key:string)=>join(bytesRoot,digest(key));
  32 |   for(const [key,bytes] of f.objects)await writeFile(pathFor(key),bytes,{mode:0o600});
  33 |   const get=async(key:string)=>readFile(pathFor(key));
  34 |   const getIfExists=async(key:string)=>{try{return await get(key);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
  35 |   const blobs:PrivateBlobs={
  36 |     async put(key,bytes,media){await writeFile(pathFor(key),bytes,{mode:0o600});await f.blobs.put(key,bytes,media);},get,getIfExists,
  37 |     async getIfExistsBounded(key,max){try{if((await stat(pathFor(key))).size>max)throw Error('Private byte limit exceeded');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}return get(key);},
  38 |     async exists(key){return (await getIfExists(key))!==null;},
  39 |     async delete(key){try{await unlink(pathFor(key));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await f.blobs.delete(key);},
  40 |   };
  41 |   const baseURL='http://127.0.0.1:5199',app=createServer({pool:f.pool,blobs,allowedOrigin:baseURL,enableRunRuntime:true});
  42 |   const dist=resolve(process.cwd(),'dist');
  43 |   const html=await readFile(join(dist,'index.html')),favicon=await readFile(join(dist,'favicon.svg'));
  44 |   const assets=new Map<string,Buffer>();for(const name of await readdir(join(dist,'assets')))assets.set('/assets/'+name,await readFile(join(dist,'assets',name)));
  45 |   app.get('/',async(_request:FastifyRequest,reply:FastifyReply)=>reply.type('text/html; charset=utf-8').send(html));
  46 |   app.get('/assets/*',async(request:FastifyRequest,reply:FastifyReply)=>{const path=new URL(request.url,baseURL).pathname,bytes=assets.get(path);if(!bytes)return reply.code(404).send();return reply.type(path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'application/octet-stream').send(bytes);});
  47 |   app.get('/favicon.ico',async(_request:FastifyRequest,reply:FastifyReply)=>reply.code(204).send());
  48 |   app.get('/favicon.svg',async(_request:FastifyRequest,reply:FastifyReply)=>reply.type('image/svg+xml').send(favicon));
  49 |   await app.listen({host:'127.0.0.1',port:5199});
  50 |   const access=uid(),csrf=uid();
  51 |   await f.pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
  52 |     VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,[uid(),f.owner,digest(access),digest(uid()),digest(csrf)]);
  53 |   const headers={cookie:`bb_session=${access}; bb_csrf=${csrf}`,'x-bb-csrf':csrf,origin:baseURL};
  54 |   const request=async(method:string,path:string,body?:unknown)=>{
  55 |     const response=await fetch(baseURL+path,{method,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
> 56 |     const text=await response.text();assert.ok(response.ok,`${method} ${path}: ${response.status} ${text}`);return text?JSON.parse(text):null;
     |                                             ^ AssertionError: GET /api/v1/artifacts/word-996705ec6a570ef2a1d9eebda74890f1c97d22b8591493f42c9dba2b148fd25e: 404 {"code":"NOT_FOUND","message":"Resource does not exist","retryable":false,"field_errors":[],"correlation_id":"9ea18be9-1fb3-4550-b780-4235efebadfa"}
  57 |   };
  58 |   const execute=productionWordRunner({...f,blobs,config});
  59 |   const calls=async()=>{try{return (await readFile(marker,'utf8')).trim().split('\n').filter(Boolean).map(row=>JSON.parse(row));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}};
  60 |   const evidence=async()=>{
  61 |     const result:Record<string,unknown>={};
  62 |     for(const table of ['bb_runs','bb_jobs','bb_run_execution_versions','bb_run_execution_heads','bb_input_revisions','bb_run_supplement_drafts',
  63 |       'bb_run_supplement_quotes','bb_run_supplement_quote_confirmations','bb_run_supplement_adoptions','bb_run_billing_segments','bb_run_execution_billing_bindings',
  64 |       'bb_credit_reservations','bb_credit_events','bb_run_billing_progress','bb_model_call_attempts','bb_model_call_execution_bindings','bb_provider_result_refs',
  65 |       'bb_snapshot_refs','bb_artifact_versions','bb_run_execution_deliveries','bb_run_execution_delivery_artifacts','bb_run_events','bb_outbox'])
  66 |       result[table]=(await f.pool.query(`SELECT t.* FROM ${table} t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text`,[f.owner])).rows;
  67 |     return {...result,provider_calls:await calls()};
  68 |   };
  69 |   let closed=false;
  70 |   return {...f,blobs,baseURL,artifactRoot,bytesRoot,workRoot,marker,python,config,access,csrf,headers,request,execute,calls,evidence,cloneName,
  71 |     async close(){if(closed)return;closed=true;try{await app.close();}finally{await f.cleanup();}
  72 |       const maintenance=new URL(clone);maintenance.pathname='/postgres';const cleanup=new Pool({connectionString:maintenance.toString(),max:1});
  73 |       try{await cleanup.query(`DROP DATABASE IF EXISTS "${cloneName}"`);
  74 |         const remaining=(await cleanup.query('SELECT datname FROM pg_database WHERE datname=$1',[cloneName])).rows;
  75 |         await writeFile(join(artifactRoot,'owned-cleanup.json'),JSON.stringify({clone_name:cloneName,clone_remaining:remaining,http_app_closed:true},null,2));
  76 |         assert.equal(remaining.length,0,'Owned clone cleanup must finish');
  77 |       }finally{await cleanup.end();}
  78 |     }};
  79 | }
  80 | 
```