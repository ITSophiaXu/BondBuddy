// Local channel simulator on the production server. Never an alternative API or worker.
import {Pool} from 'pg';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createProductionServer} from '../../apps/api/dist/server.js';
import {session} from '../../apps/api/dist/auth.js';
import {Problem} from '../../apps/api/dist/data.js';
import {clearSpoolDirectory} from '../../apps/api/dist/upload-spool.js';
import {subscriptionAccount} from '../../apps/api/dist/subscriptions.js';
import {installLocalProviderState,syntheticPaymentProvider} from '../billing-functional/provider.mjs';
import {installPaymentControls,paymentState} from '../billing-functional/payment-controls.mjs';

const id=process.env.BB_LOCAL_PRELAUNCH_INSTANCE,database=process.env.BB_LOCAL_PRELAUNCH_DATABASE;
const origin=process.env.BB_ALLOWED_ORIGIN;
if(process.env.BB_DEPLOYMENT_TIER!=='local'||!/^[-a-f0-9]{36}$/.test(id??'')||
  !/^bb_billing_functional_[a-f0-9]{16}$/.test(database??'')||!/^http:\/\/localhost:\d+$/.test(origin??''))
  throw Error('Start only through the isolated local-prelaunch launcher');
const connection=new URL(process.env.DATABASE_URL);
if(connection.hostname!=='postgres'||connection.pathname!=='/'+database)throw Error('Local database identity mismatch');
const saved={id,database},pool=new Pool({connectionString:connection.href,max:8});
const loadedBootHashes=Object.fromEntries(await Promise.all(['api-entry.mjs','../billing-functional/provider.mjs','../billing-functional/payment-controls.mjs'].map(async name=>
  [name,createHash('sha256').update(await readFile(new URL(name,import.meta.url))).digest('hex')])));
try {
  const actual=(await pool.query('SELECT current_database() AS database')).rows[0];
  if(actual.database!==database)throw Error('Wrong local database');
  await pool.query('CREATE TABLE IF NOT EXISTS bb_local_billing_instance(instance_id text PRIMARY KEY)');
  await pool.query('INSERT INTO bb_local_billing_instance(instance_id) SELECT $1 WHERE NOT EXISTS(SELECT 1 FROM bb_local_billing_instance)',[id]);
  const markers=(await pool.query('SELECT instance_id FROM bb_local_billing_instance')).rows;
  if(markers.length!==1||markers[0].instance_id!==id)throw Error('Local database marker mismatch');
  await installLocalProviderState(pool,saved);
}catch(error){await pool.end();throw error;}

const provider=syntheticPaymentProvider(pool,saved);
const app=createProductionServer({pool,paymentProviders:[provider]});
const auth={pool,allowedOrigin:origin,termsVersion:process.env.BB_TERMS_VERSION};
async function owner(request){
  if(request.headers.origin!==origin||!request.headers['content-type']?.startsWith('application/json'))
    throw new Problem(403,'CSRF_DENIED','Local JSON request and exact Origin required');
  const user=(await session(request,auth,true)).userId;
  const expected=request.headers['x-bb-test-owner'];
  if(expected!==undefined&&expected!==user)throw new Problem(403,'CSRF_DENIED','测试账号已变化，请核对当前订单。');
  return user;
}
async function product(request,method,url,payload){
  const response=await app.inject({method,url,payload,remoteAddress:'127.0.0.1',headers:{
    host:new URL(origin).host,origin,cookie:request.headers.cookie??'',
    'x-bb-csrf':request.headers['x-bb-csrf']??'','content-type':'application/json'}});
  const data=response.json();
  if(response.statusCode>=400)throw new Problem(response.statusCode,data.code??'DATA_UNAVAILABLE',data.message??'Product request failed');
  return data;
}
async function state(user){
  const account=(await pool.query('SELECT username FROM bb_users WHERE id=$1',[user])).rows[0];
  return {synthetic:true,synthetic_payment:true,real_worker:true,owner_user_id:user,username:account.username,
    account:await subscriptionAccount(pool,user),...await paymentState(pool,user,saved)};
}
let pending=Promise.resolve();
const serial=work=>{const next=pending.then(work);pending=next.catch(()=>{});return next;};
installPaymentControls(app,{pool,saved,provider,owner,serial,product,state,origin});
app.post('/__billing-test/api/state',{schema:{body:{type:'object',additionalProperties:false}}},async request=>state(await owner(request)));
app.get('/__prelaunch/status',async()=>({instance_id:id,production_server:true,synthetic_payment:true,model_results_synthetic:false,release_sha:process.env.BB_RELEASE_SHA,loaded_boot_hashes:loadedBootHashes}));
for(const [route,file,type] of [
  ['/__prelaunch/checkout','cashier.html','text/html; charset=utf-8'],
  ['/__prelaunch/checkout.js','../billing-functional/checkout.js','text/javascript; charset=utf-8'],
  ['/__prelaunch/billing-client.js','../billing-functional/billing-client.js','text/javascript; charset=utf-8'],
  ['/__prelaunch/browser-entry.js','browser-entry.js','text/javascript; charset=utf-8'],
  ['/__prelaunch/local.css','local.css','text/css; charset=utf-8']])
  app.get(route,async(_request,reply)=>reply.header('cache-control','no-store').type(type).send(await readFile(new URL(file,import.meta.url),'utf8')));

await clearSpoolDirectory();
let closing=false;
const shutdown=()=>{if(closing)return;closing=true;void app.close().then(()=>pool.end()).catch(()=>{process.exitCode=1;});};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
await app.listen({host:'0.0.0.0',port:Number(process.env.PORT??3000)});
console.log(JSON.stringify({service:'local-prelaunch-api',instance_id:id,production_server:true,synthetic_payment:true}));
