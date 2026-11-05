import {readFile,writeFile,mkdir,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';
import {createServer as createVite} from 'vite';
import {config,runtime,repo,directory,ports,baseURL,apiURL,pgBase,terms,cleanEnvironment} from './config.mjs';
import {installLocalProviderState,syntheticPaymentProvider} from './provider.mjs';
import {localSubscriptionState,advanceLocalSubscription,setLocalNextChargeOutcome} from './subscription-controls.mjs';
import {installPaymentControls,paymentState} from './payment-controls.mjs';

const launchId=process.env.BB_FUNCTIONAL_LAUNCH,stopToken=process.env.BB_FUNCTIONAL_STOP;
if(!/^[a-f0-9]{48}$/.test(launchId??'')||!/^[a-f0-9]{64}$/.test(stopToken??''))throw Error('Start through billing-functional/start.mjs');
// Drop all ambient provider/model/cloud variables before loading the real app.
const env=cleanEnvironment();for(const name of Object.keys(process.env))if(!(name in env))delete process.env[name];Object.assign(process.env,env);
const saved=config(),pool=new Pool({connectionString:pgBase+saved.database,max:8,idleTimeoutMillis:0,connectionTimeoutMillis:10000});
// Billing context is scoped by Pool identity; keep the two real configurations
// independent even though they use the same marker-verified local ledger.
const dynamicPool=new Pool({connectionString:pgBase+saved.database,max:4,idleTimeoutMillis:0,connectionTimeoutMillis:10000});
await pool.query('SELECT 1');
const marker=(await pool.query('SELECT instance_id FROM bb_local_billing_instance')).rows[0];if(marker?.instance_id!==saved.id)throw Error('Wrong isolated database marker');
const {createServer}=await import('../../apps/api/dist/server.js');
const {session}=await import('../../apps/api/dist/auth.js');
const {Problem,digest,uid}=await import('../../apps/api/dist/data.js');
const {subscriptionAccount,processDueSubscriptionRenewals,processDueSubscriptionCreditReleases}=await import('../../apps/api/dist/subscriptions.js');
const {claim,finish,releaseLease,checkpointStage,pauseAtCheckpoint,resumePausedRun}=await import('../../apps/api/dist/queue.js');
const {readAuthoringProgress}=await import('../../apps/api/dist/authoring-progress.js');
const {syntheticReviewPair}=await import('../../apps/api/dist/review-delivery-test-fixture.js');
const {makeSyntheticDocxFixture}=await import('../../apps/api/dist/docx-fixtures.js');
const {auditCredits}=await import('../../apps/api/dist/billing-ops.js');
const {publishPrices}=await import('../../apps/api/dist/billing.js');
const {INITIAL_FIXED_PRICES}=await import('../../packages/contracts/dist/index.js');

const blobDir=join(runtime,'blobs');await mkdir(blobDir,{recursive:true});
const blobPath=key=>join(blobDir,createHash('sha256').update(key).digest('hex'));
const get=async key=>readFile(blobPath(key));
const getIfExists=async key=>{try{return await get(key);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const blobs={put:async(key,bytes)=>writeFile(blobPath(key),bytes),get,getIfExists,
  getIfExistsBounded:async(key,limit)=>{try{if((await stat(blobPath(key))).size>limit)throw new Problem(413,'UPLOAD_TOO_LARGE','Synthetic object exceeds limit');return await get(key);}catch(error){if(error.code==='ENOENT')return null;throw error;}},
  exists:async key=>(await getIfExists(key))!==null,delete:async key=>{try{await unlink(blobPath(key));}catch(error){if(error.code!=='ENOENT')throw error;}}};
await installLocalProviderState(pool,saved);
await pool.query("ALTER TABLE bb_local_billing_reviews ADD COLUMN IF NOT EXISTS test_mode text NOT NULL DEFAULT 'commerce' CHECK(test_mode IN ('commerce','dynamic'))");
// A labelled legacy-policy fixture, separate from the migrated commercial
// tariffs. No commercial price, quote, contract or wallet is overwritten.
await publishPrices(pool,{id:'synthetic-functional-dynamic-v1',prices:{...INITIAL_FIXED_PRICES,full_review:27195,differential_review:14900,review_revision:14900},
  effectiveAt:'2026-01-01T00:00:00Z',actor:'local-synthetic-fixture',reason:'Isolated dynamic-policy acceptance only; not a commercial tariff'});
const provider=syntheticPaymentProvider(pool,saved);
// Enable the actual queued-run controls (including cancellation and release).
// This flag does not start a worker; generated outputs still need explicit simulation.
const app=createServer({pool,blobs,enableSubscriptionBilling:true,enablePaidReview:true,enableSyntheticQueue:true,paymentProviders:[provider],allowedOrigin:baseURL,auth:{termsVersion:terms}});
// Commercial subscription mode correctly keeps on_delivery charging. Exercise
// the existing dynamic policy through a second real configuration, accessible
// only by the authenticated local control handler; it has no listening socket.
const dynamicApp=createServer({pool:dynamicPool,blobs,enableSubscriptionBilling:false,enableOutcomePricing:false,enablePaidReview:true,enableSyntheticQueue:true,
  allowedOrigin:baseURL,auth:{termsVersion:terms}});
app.addHook('onError',async(request,_reply,error)=>console.error(JSON.stringify({path:request.routeOptions.url,code:error.code,message:error.message})));
let ready=false,stopping=false,vite;
const allowedHosts=new Set([`localhost:${ports.web}`,`127.0.0.1:${ports.web}`,`127.0.0.1:${ports.api}`,`localhost:${ports.api}`]);
const local=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address??'');
app.addHook('onRequest',async(request,reply)=>{
  if(!local(request.socket.remoteAddress)||!allowedHosts.has(request.headers.host??''))return reply.code(403).send({code:'LOCAL_ONLY',message:'Local functional environment only'});
});
const auth={pool,allowedOrigin:baseURL,termsVersion:terms};
async function owner(request){
  if(request.headers.origin!==baseURL||!request.headers['content-type']?.startsWith('application/json'))throw new Problem(403,'CSRF_DENIED','Local JSON request and exact Origin required');
  const user=(await session(request,auth,true)).userId,expected=request.headers['x-bb-test-owner'];
  // Bind a browser retry to the identity that originally displayed the action.
  // A cookie can change before a cross-tab notification reaches the client.
  if(expected!==undefined&&expected!==user)throw new Problem(403,'CSRF_DENIED','账号会话已变化，原测试操作不能在新账号下执行。');
  return user;
}
async function product(request,method,url,payload,target=app){
  const response=await target.inject({method,url,payload,remoteAddress:'127.0.0.1',headers:{host:`localhost:${ports.web}`,origin:baseURL,cookie:request.headers.cookie??'','x-bb-csrf':request.headers['x-bb-csrf']??'','content-type':'application/json'}});
  const body=response.json();if(response.statusCode>=400)throw new Problem(response.statusCode,body.code??'DATA_UNAVAILABLE',body.message??'Product request failed');return body;
}
const idBody={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',pattern:'^[a-f0-9-]{36}$'}}};
const emptyBody={type:'object',additionalProperties:false};
async function intent(owner,id){const row=(await pool.query('SELECT * FROM bb_local_billing_reviews WHERE id=$1 AND owner_user_id=$2',[id,owner])).rows[0];if(!row)throw new Problem(404,'NOT_FOUND','Synthetic review not found');return row;}
async function resumeFundedReviews(user){
  // The real runtime normally sweeps credit-paused jobs. This local harness has
  // no model worker, so run the same trusted resume operation for its own
  // registered test tasks only. It never grants funds or overrides user pause.
  const rows=(await pool.query(`SELECT r.id FROM bb_local_billing_reviews t
    JOIN bb_runs r ON r.id=t.run_id AND r.owner_user_id=t.owner_user_id
    WHERE t.owner_user_id=$1 AND r.state='paused' AND r.stage='credits_exhausted'`,[user])).rows;
  for(const row of rows)await resumePausedRun(pool,user,row.id,'credits_recharged');
}
async function state(owner){
  await resumeFundedReviews(owner);
  const account=await subscriptionAccount(pool,owner),user=(await pool.query('SELECT username FROM bb_users WHERE id=$1',[owner])).rows[0];
  const tasks=(await pool.query(`SELECT t.id,t.project_id,t.quote,t.request,t.test_mode,t.run_id,r.state,r.stage AS pause_reason,t.created_at,
    h.state AS charge_state,h.billing_policy,h.points AS reserved_points,h.charged_points AS gross_charged_points,j.checkpoint
    FROM bb_local_billing_reviews t LEFT JOIN bb_runs r ON r.id=t.run_id LEFT JOIN bb_credit_reservations h ON h.run_id=t.run_id LEFT JOIN bb_jobs j ON j.run_id=t.run_id
    WHERE t.owner_user_id=$1 ORDER BY t.created_at DESC LIMIT 20`,[owner])).rows;
  for(const task of tasks){
    task.progress=task.run_id?await readAuthoringProgress(pool,owner,task.run_id):null;
    task.charged_points=task.progress?.charged_points??task.gross_charged_points??'0';
    task.checkpoint_stages=Object.keys(task.checkpoint?.stages??{});delete task.checkpoint;
  }
  return {synthetic:true,owner_user_id:owner,username:user.username,account,tasks,...await paymentState(pool,owner,saved),subscription_test:await localSubscriptionState(pool,owner)};
}
// Serialize test actions in this one local process. Product APIs still perform
// their normal database transactions, session checks and idempotency rules.
let chain=Promise.resolve();const serial=work=>{const next=chain.then(work);chain=next.catch(()=>{});return next;};
installPaymentControls(app,{pool,saved,provider,owner,serial,product,state});
app.get('/__billing-test/status',async()=>({ready,synthetic:true,launch_id:launchId}));
app.post('/__billing-test/api/state',{schema:{body:emptyBody}},async request=>state(await owner(request)));
app.post('/__billing-test/api/subscription/advance',{schema:{body:{...idBody,properties:{...idBody.properties,
  replay_only:{type:'boolean'},expected_event:{type:'object',additionalProperties:false,required:['at','event_kind'],properties:{at:{type:'string',format:'date-time'},event_kind:{type:'string',enum:['release','renewal']}}}}}}},async request=>{
  const user=await owner(request);return serial(async()=>{
    let action;
    // Unupdated tabs may still send only {id}; absence of an event pin permits
    // recovery of that ID only, never authorization to advance today's event.
    try{action=await advanceLocalSubscription(pool,user,request.body.id,{processDueSubscriptionRenewals,processDueSubscriptionCreditReleases,providers:[provider],expectedEvent:request.body.expected_event,replayOnly:request.body.replay_only===true||request.body.expected_event===undefined});}
    catch(error){if(error instanceof Problem)throw error;throw new Problem(409,'INPUT_REVISION_CONFLICT',error.message);}
    return {...await state(user),subscription_action:action,...(action.event_changed?{action_notice:action.replay_only?'未找到原操作记录，未推进订阅事件；请核实下一事件。':'原事件已变化/已由其他标签完成，请核实下一事件。'}:{})};
  });
});
app.post('/__billing-test/api/subscription/outcome',{schema:{body:{type:'object',additionalProperties:false,required:['outcome'],properties:{outcome:{type:'string',enum:['paid','pending','failed']}}}}},async request=>{
  const user=await owner(request);return serial(async()=>{await setLocalNextChargeOutcome(pool,user,request.body.outcome);return state(user);});
});
app.post('/__billing-test/api/review/prepare',{schema:{body:{...idBody,properties:{...idBody.properties,mode:{type:'string',enum:['commerce','dynamic']}}}}},async request=>{
  const user=await owner(request),id=request.body.id,mode=request.body.mode??'commerce';
  return serial(async()=>{
    const old=(await pool.query('SELECT test_mode FROM bb_local_billing_reviews WHERE id=$1 AND owner_user_id=$2',[id,user])).rows[0];
    if(old){if(old.test_mode!==mode)throw new Problem(409,'IDEMPOTENCY_CONFLICT','The original test mode is locked');return state(user);}
    const created=await product(request,'POST','/api/v1/projects',{kind:'review',name:'【合成测试】全面复核计费',issuer_name:null,market:null,offering:null}),project=created.project_id;
    const upload=uid(),material=uid(),source=makeSyntheticDocxFixture({text:'Synthetic billing test source. No real bond content or model execution.'}),sha=digest(source),key='synthetic-source/'+material;
    await blobs.put(key,source);
    const client=await pool.connect();try{await client.query('BEGIN');
      await client.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'synthetic-billing-source.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$4,$5,'historical',$6,now()+interval '1 day','completed')`,[upload,user,project,source.length,sha,key]);
      await client.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','synthetic-billing-source.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$5,$6,$7,'persisted')`,[material,user,project,upload,source.length,sha,key]);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const pin={material_id:material,material_version:1,sha256:sha},base=`/api/v1/projects/${project}`;
    await product(request,'PUT',base+'/review-draft',{kind:'input',expected_version:0,input:{source_material_ref:pin,material_versions:[pin],requirements:[],as_of:null}});
    const input={execution_request_id:uid(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
    const quoted=await product(request,'POST',base+'/review-executions/quote',input,mode==='dynamic'?dynamicApp:app);
    if(!quoted.enabled||!quoted.quote||mode==='commerce'&&(!quoted.quote.auto_charge||quoted.quote.quote_status!=='ready'))throw new Problem(503,'BILLING_NOT_READY','Review quote is not executable');
    await pool.query('INSERT INTO bb_local_billing_reviews(id,owner_user_id,project_id,request,quote,test_mode) VALUES($1,$2,$3,$4,$5,$6)',[id,user,project,{...input,quote_id:quoted.quote.quote_id},quoted.quote,mode]);
    return state(user);
  });
});
app.post('/__billing-test/api/review/start',{schema:{body:idBody}},async request=>{
  const user=await owner(request);return serial(async()=>{const saved=await intent(user,request.body.id);
    const run=await product(request,'POST',`/api/v1/projects/${saved.project_id}/review-executions`,saved.request,saved.test_mode==='dynamic'?dynamicApp:app);
    await pool.query('UPDATE bb_local_billing_reviews SET run_id=$3 WHERE id=$1 AND owner_user_id=$2',[saved.id,user,run.run_id]);return state(user);});
});
async function claimReview(user,saved){
  // A product payment refresh can have credited after the control response.
  // Check the trusted resume condition again rather than require an extra
  // manual test-panel refresh before the next simulated worker operation.
  await resumeFundedReviews(user);
  const next=(await pool.query(`SELECT r.id,r.owner_user_id FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id
    WHERE (j.state='queued' OR (j.state='running' AND j.lease_until<now())) AND r.state NOT IN ('cancelled','failed','succeeded','test_completed','rejected')
    AND j.job_type='review' ORDER BY j.created_at LIMIT 1`)).rows[0];
  if(next?.id!==saved.run_id||next.owner_user_id!==user)throw new Problem(409,'INPUT_REVISION_CONFLICT','An earlier or unavailable task prevents this local simulation; no other task was completed');
  const lease=await claim(pool,120,{runKinds:['review']});
  if(!lease||lease.runId!==saved.run_id||lease.owner!==user){if(lease)await releaseLease(pool,lease,'local_test_unrelated_guard');throw new Problem(409,'INPUT_REVISION_CONFLICT','Queue changed; no other task was completed');}
  return lease;
}
app.post('/__billing-test/api/review/progress',{schema:{body:{...idBody,required:['id','stage'],properties:{...idBody.properties,stage:{type:'string',enum:['input_lock','model_generation']}}}}},async request=>{
  const user=await owner(request);return serial(async()=>{
    const saved=await intent(user,request.body.id);if(!saved.run_id)throw new Problem(409,'INPUT_REVISION_CONFLICT','Start the synthetic task first');
    if(saved.test_mode!=='dynamic')throw new Problem(409,'INPUT_REVISION_CONFLICT','Progress debits belong to the separate dynamic-policy test');
    const prior=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2',[saved.run_id,user])).rows[0]?.checkpoint?.stages??{};
    const stage=request.body.stage;
    if(prior[stage])return state(user);
    if(stage==='model_generation'&&!prior.input_lock)throw new Problem(409,'INPUT_REVISION_CONFLICT','Save the input checkpoint before simulated processing');
    const lease=await claimReview(user,saved);
    try{
      await checkpointStage(pool,lease,stage,{synthetic:true,source:'local_billing_test',logical_call_id:saved.id+':'+stage});
      if(!await pauseAtCheckpoint(pool,lease))await releaseLease(pool,lease,'local_test_checkpoint');
    }catch(error){try{await releaseLease(pool,lease,'local_test_progress_retry');}catch{}throw error;}
    if(!(await auditCredits(pool)).consistent)throw new Problem(503,'DATA_UNAVAILABLE','Wallet audit requires investigation');
    return state(user);
  });
});
app.post('/__billing-test/api/review/finish',{schema:{body:{...idBody,required:['id','outcome'],properties:{...idBody.properties,outcome:{type:'string',enum:['succeeded','failed']}}}}},async request=>{
  const user=await owner(request);return serial(async()=>{const saved=await intent(user,request.body.id);if(!saved.run_id)throw new Problem(409,'INPUT_REVISION_CONFLICT','Start the synthetic task first');
    const run=(await pool.query('SELECT state FROM bb_runs WHERE id=$1 AND owner_user_id=$2',[saved.run_id,user])).rows[0];
    if(['succeeded','failed'].includes(run?.state)){if(run.state!==request.body.outcome)throw new Problem(409,'ALREADY_TERMINAL','The task already finished with a different outcome');return state(user);}
    const lease=await claimReview(user,saved);
    try{
      if(request.body.outcome==='succeeded'){
        // A saved pair can wait for its remaining price. Resume settlement from
        // the immutable checkpoint instead of generating another pair.
        const pair=lease.checkpoint?.stages?.word_delivery_pair;
        const artifact=pair?{artifactId:pair.revision_artifact_id,artifactVersion:1}:await syntheticReviewPair(pool,lease,blobs);
        await finish(pool,lease,'succeeded',{artifactId:artifact.artifactId,artifactVersion:artifact.artifactVersion,blobs});
      }
      else await finish(pool,lease,'failed',{errorCode:'SYNTHETIC_TEST_FAILURE',failedStage:'synthetic_local_test'});
    }catch(error){try{await releaseLease(pool,lease,'local_test_delivery_retry');}catch{}throw error;}
    const audit=await auditCredits(pool);if(!audit.consistent)throw new Problem(503,'DATA_UNAVAILABLE','Wallet audit requires investigation');return state(user);
  });
});
async function shutdown(){if(stopping)return;stopping=true;ready=false;await vite?.close();await dynamicApp.close();await app.close();await dynamicPool.end();await pool.end();process.exit(0);}
app.post('/__billing-test/control/stop',async(request,reply)=>{
  const token=request.headers['x-local-control'];
  if(request.headers.origin!==baseURL||typeof token!=='string'||token.length!==stopToken.length||!timingSafeEqual(Buffer.from(token),Buffer.from(stopToken)))return reply.code(403).send({code:'LOCAL_ONLY'});
  reply.send({stopping:true});setTimeout(()=>void shutdown(),100);
});
try{
  await app.listen({host:'127.0.0.1',port:ports.api});
  if(!(await pool.query("SELECT 1 FROM bb_users WHERE username='billing_tester'")).rowCount){
    const response=await app.inject({method:'POST',url:'/api/v1/auth/register',remoteAddress:'127.0.0.1',headers:{host:`localhost:${ports.web}`,origin:baseURL,'content-type':'application/json'},payload:{username:'billing_tester',password:'Local-Test-2026!',accepted_terms_version:terms}});
    if(response.statusCode!==201)throw Error('Local user registration failed: '+response.body);
    // Registration creates identity/session only. No grant or wallet mutation.
    const account=await subscriptionAccount(pool,response.json().user_id);if(account.available_points!=='0')throw Error('New user must start with zero points');
  }
  const banner='<style>:root{--bb-billing-banner-height:90px}body{padding-bottom:calc(var(--bb-billing-banner-height) + 16px)!important;box-sizing:border-box}body .sidebar{height:calc(100dvh - var(--bb-billing-banner-height))!important;max-height:calc(100dvh - var(--bb-billing-banner-height));bottom:var(--bb-billing-banner-height)!important}body .ba-dock{bottom:calc(20px + var(--bb-billing-banner-height))}body .billing-task-notice{bottom:calc(24px + var(--bb-billing-banner-height))}#billing-functional-banner{max-height:90px;overflow:auto}</style><div id="billing-functional-banner" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;padding:12px;background:#fff1a6;color:#302600;text-align:center;font:14px/1.4 system-ui">模拟支付环境 · 不扣真钱、不调用模型 · 在模拟收银台确认支付后到账，刷新本身不会付款，无需扫码。 <a href="/__billing-test" style="color:#302600;text-decoration:underline">打开计费测试台</a></div>';
  vite=await createVite({root:join(repo,'apps/web'),configFile:join(repo,'apps/web/vite.config.ts'),plugins:[{
    name:'billing-functional-only',transformIndexHtml:html=>html.replace('</body>',banner+'<script type="module" src="/__billing-test/authorization.js"></script><script type="module" src="/__billing-test/payment-entry.js"></script></body>'),
    configureServer(server){server.middlewares.use(async(req,res,next)=>{
      if(!local(req.socket.remoteAddress)||!allowedHosts.has(req.headers.host??'')){res.statusCode=403;res.end('Local functional environment only');return;}
      const path=(req.url??'').split('?',1)[0];
      if(path==='/__billing-test'||path==='/__billing-test/'){res.setHeader('content-type','text/html; charset=utf-8');res.setHeader('cache-control','no-store');res.end(await readFile(join(directory,'panel.html'),'utf8'));return;}
      if(path==='/__billing-test/checkout'||path==='/__billing-test/checkout/'){res.setHeader('content-type','text/html; charset=utf-8');res.setHeader('cache-control','no-store');res.end(await readFile(join(directory,'checkout.html'),'utf8'));return;}
      const localScripts=new Set(['panel.js','authorization.js','payment-entry.js','checkout.js','billing-client.js']);
      const name=path.startsWith('/__billing-test/')?path.slice('/__billing-test/'.length):'';
      if(localScripts.has(name)){res.setHeader('content-type','text/javascript; charset=utf-8');res.setHeader('cache-control','no-store');res.end(await readFile(join(directory,name),'utf8'));return;}next();
    });}
  }],server:{host:'127.0.0.1',port:ports.web,strictPort:true,allowedHosts:['localhost','127.0.0.1'],proxy:{'/api/v1':{target:apiURL},'/__billing-test/api':{target:apiURL}}}});
  await vite.listen();ready=true;console.log(JSON.stringify({ready:true,synthetic:true,url:baseURL+'/__billing-test',database:saved.database,launchId}));
}catch(error){console.error(error);await vite?.close();await dynamicApp.close();await app.close();await dynamicPool.end();await pool.end();process.exit(1);}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
