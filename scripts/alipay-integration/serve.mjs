import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';
import {createServer as createVite} from 'vite';
import {config,repo,ports,baseURL,apiURL,databaseURL,terms,username,password,cleanEnvironment} from './config.mjs';
import {assertDatabase} from './database.mjs';

const launchId=process.env.BB_LOCAL_ALIPAY_LAUNCH,stopToken=process.env.BB_LOCAL_ALIPAY_STOP;
if(!/^[a-f0-9]{48}$/.test(launchId??'')||!/^[a-f0-9]{64}$/.test(stopToken??''))throw Error('Use alipay-integration/start.mjs');
const env=cleanEnvironment();for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);
const pool=new Pool({connectionString:databaseURL,max:8,idleTimeoutMillis:0,connectionTimeoutMillis:10000});
await assertDatabase(pool,config());
const {createServer}=await import('../../apps/api/dist/server.js');
const {paymentProvidersFromEnv}=await import('../../apps/api/dist/payment-provider-config.js');
const configured=paymentProvidersFromEnv(env);
if(configured.status!=='ready'||configured.providers.length!==1||configured.providers[0].name!=='alipay')throw Error('Verified Alipay sandbox configuration is required');
// Real product routes, real sessions, real PostgreSQL and the unmodified signed
// Alipay adapter. No fake success, balance grants, worker or cloud storage.
const app=createServer({pool,enableSubscriptionBilling:true,paymentProviders:configured.providers,allowedOrigin:baseURL,auth:{termsVersion:terms}});
const allowedHosts=new Set([`localhost:${ports.web}`,`127.0.0.1:${ports.web}`,`127.0.0.1:${ports.api}`,`localhost:${ports.api}`]);
const local=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address??'');
app.addHook('onRequest',async(request,reply)=>{
  if(!local(request.socket.remoteAddress)||!allowedHosts.has(request.headers.host??''))return reply.code(403).send({code:'LOCAL_ONLY'});
});
// Only route templates and bounded error codes; no URLs, query strings, cookies,
// signed checkout forms, raw gateway responses or payment credentials in logs.
app.addHook('onError',async(request,_reply,error)=>console.error(JSON.stringify({route:request.routeOptions.url,code:/^[A-Z0-9_]{1,80}$/.test(error.code??'')?error.code:'UNRESOLVED'})));
let ready=false,stopping=false,vite;
app.get('/__alipay-test/status',async()=>({ready,sandbox:true,realProductApi:true,realPostgres:true,modelWorker:false,publicNotifications:false,launch_id:launchId}));
async function shutdown(){if(stopping)return;stopping=true;ready=false;await vite?.close();await app.close();await pool.end();process.exit(0);}
app.post('/__alipay-test/control/stop',async(request,reply)=>{
  const token=request.headers['x-local-control'];
  if(request.headers.origin!==baseURL||typeof token!=='string'||token.length!==stopToken.length||!timingSafeEqual(Buffer.from(token),Buffer.from(stopToken)))return reply.code(403).send({code:'LOCAL_ONLY'});
  reply.send({stopping:true});setTimeout(()=>void shutdown(),100);
});
const banner='<style>body{padding-bottom:64px!important;box-sizing:border-box}</style><div style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;padding:12px;background:#fff1a6;color:#302600;text-align:center;font:14px/1.4 system-ui">本地支付宝沙箱 · 仅测试支付与积分 · 使用沙箱资金，不扣真实资金 · 文稿任务未启用</div>';
try{
  await app.listen({host:'127.0.0.1',port:ports.api});
  if(!(await pool.query('SELECT 1 FROM bb_users WHERE username=$1',[username])).rowCount){
    const r=await app.inject({method:'POST',url:'/api/v1/auth/register',remoteAddress:'127.0.0.1',headers:{host:`localhost:${ports.web}`,origin:baseURL,'content-type':'application/json'},payload:{username,password,accepted_terms_version:terms}});
    if(r.statusCode!==201)throw Error('Local account registration failed: '+r.statusCode);
    const {subscriptionAccount}=await import('../../apps/api/dist/subscriptions.js');
    if((await subscriptionAccount(pool,r.json().user_id)).available_points!=='0')throw Error('New local account must have zero points');
  }
  vite=await createVite({root:join(repo,'apps/web'),configFile:join(repo,'apps/web/vite.config.ts'),plugins:[{
    name:'alipay-local-acceptance',transformIndexHtml:html=>html.replace('</body>',banner+'</body>'),
    configureServer(server){server.middlewares.use(async(req,res,next)=>{
      if(!local(req.socket.remoteAddress)||!allowedHosts.has(req.headers.host??'')){res.statusCode=403;res.end('Local acceptance only');return;}
      if((req.url??'').split('?',1)[0]==='/payment/alipay/return.html'){
        res.setHeader('content-type','text/html; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');
        res.end((await readFile(join(repo,'apps/web/public/payment/alipay/return.html'),'utf8')).replace('</html>',banner+'</html>'));return;
      }next();
    });}
  }],server:{host:'127.0.0.1',port:ports.web,strictPort:true,allowedHosts:['localhost','127.0.0.1'],proxy:{'/api/v1':{target:apiURL},'/__alipay-test/status':{target:apiURL}}}});
  await vite.listen();ready=true;console.log(JSON.stringify({ready:true,url:baseURL+'/#/account',sandbox:true,modelWorker:false}));
}catch(error){console.error(JSON.stringify({event:'local_start_failed',message:error.message}));await vite?.close();await app.close();await pool.end();process.exit(1);}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
