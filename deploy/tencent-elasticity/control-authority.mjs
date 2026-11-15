import net from 'node:net';
import {lstat,chown,chmod,unlink,readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {canonical,requireThat,nodeLaunchConfig,requireRetainedRequest} from './policy.mjs';
import {readPrivateJson,observationArchive} from './private-files.mjs';
import {TencentTransport,TencentCvm} from './tencent-cvm.mjs';
import {issueTransportCredentials,validateTransportIssuer} from './transport-issuer.mjs';
import {executionCloudCompletionMatches} from '@bondbuddy/contracts';

const isolatedDatabaseBinding={version:'execution-authority-database-v1',database_name:'bb1361_owned_isolated',system_identifier:'7705237779724353574',
  host:'127.0.0.1',port:15432,credentials_file:'/var/lib/bondbuddy/elastic-pg-mtls/issuer/pg-credentials.json'};

/** Deployment-owned authority.json selects the target, never an issue request. */
export function validateAuthorityDatabaseBinding(config,pg) {
  const binding=Object.hasOwn(config,'database_binding')?config.database_binding:isolatedDatabaseBinding;
  const keys=Object.keys(isolatedDatabaseBinding);
  requireThat(binding&&Object.keys(binding).length===keys.length&&Object.keys(binding).every(k=>keys.includes(k))&&
    binding.version===isolatedDatabaseBinding.version&&['bb1361_owned_isolated','bondbuddy'].includes(binding.database_name)&&
    /^[1-9][0-9]{0,19}$/.test(binding.system_identifier??'')&&binding.host===isolatedDatabaseBinding.host&&binding.port===isolatedDatabaseBinding.port&&
    binding.credentials_file===isolatedDatabaseBinding.credentials_file,'AUTHORITY_DATABASE_BINDING');
  requireThat(pg?.credential_ready===true&&pg.database_name===binding.database_name&&pg.system_identifier===binding.system_identifier&&
    pg.credentials_file===binding.credentials_file,'AUTHORITY_DATABASE_NOT_READY');
  return {...binding};
}

export function validateAuthorityDatabaseConnection(databaseUrl,binding) {
  try {
    const url=new URL(databaseUrl);
    requireThat(['postgres:','postgresql:'].includes(url.protocol)&&url.hostname===binding.host&&url.port===String(binding.port)&&
      !url.searchParams.has('host')&&!url.searchParams.has('port')&&decodeURIComponent(url.pathname.slice(1))===binding.database_name,'AUTHORITY_DATABASE_SCOPE');
  } catch { throw Error('AUTHORITY_DATABASE_SCOPE'); }
}

export function verifyAuthorityDatabaseIdentity(actual,binding) {
  requireThat(actual?.system_identifier===binding.system_identifier&&actual.name===binding.database_name,'AUTHORITY_DATABASE_DRIFT');
}

/** Exact registration read within the issuer's existing node SELECT scope. */
export async function readAuthorityRegisteredNodes(pool,identity) {
  requireThat(/^\d{1,20}$/.test(identity?.account_id??'')&&identity.region==='ap-beijing'&&/^ins-[a-z0-9]+$/.test(identity.instance_id??''),'AUTHORITY_REGISTRATION_SCOPE');
  const result=await pool.query(`SELECT account_id,region,instance_id,state,destroyed_at,source_sha256,image_sha256,launch_manifest_sha256,expected_services
    FROM bb_execution_nodes WHERE account_id=$1 AND region=$2 AND instance_id=$3`,[identity.account_id,identity.region,identity.instance_id]);
  return result.rows.map(r=>({identity:{account_id:r.account_id,region:r.region,instance_id:r.instance_id},state:r.state,destroyed_at:r.destroyed_at,
    source_sha256:r.source_sha256.trim(),image_sha256:r.image_sha256.trim(),launch_manifest_sha256:r.launch_manifest_sha256.trim(),expected_services:r.expected_services}));
}

/** The local root authority owns source credentials and the CA. Callers send
 * IDs only; PG and exact cloud readback supply all signing authorization. */
export function createControlAuthority({config,control,expenseLedger,cloud,credentialsProvider,verifyDatabase,now=Date.now,sign=issueTransportCredentials}){
  const issuer=config.issuer;
  let active=null;
  async function execute(request,guard){
    guard();
    const checked=async start=>{guard();const result=await start();guard();return result;};
    requireThat(request&&['execution-pg-issuer-v1','execution-control-credentials-v1'].includes(request.version),'AUTHORITY_PROTOCOL');
    if(request.version==='execution-control-credentials-v1'){
      requireThat(Object.keys(request).every(k=>['version','account_id','role_id'].includes(k))&&
        request.account_id===config.account_id&&request.role_id===config.control_role_id,'AUTHORITY_CREDENTIAL_SCOPE');
      const credentials=await checked(()=>credentialsProvider.get());
      requireThat(credentials.token&&credentials.expiresAt>now()+60000,'AUTHORITY_SHORT_EXPIRED');
      return {version:request.version,account_id:config.account_id,role_id:config.control_role_id,credentials};
    }
    requireThat(['status','issue'].includes(request.action)&&Object.keys(request).every(k=>['version','action','operation_id','identity'].includes(k)),'AUTHORITY_ISSUER_ACTION');
    await checked(()=>verifyDatabase());await checked(()=>validateTransportIssuer(issuer,{now}));
    if(request.action==='status'){await checked(()=>credentialsProvider.get());return {version:request.version,ready:true,ca_sha256:issuer.ca_sha256};}
    requireThat(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(request.operation_id??''),'AUTHORITY_OPERATION_ID');
    const operation=await checked(()=>control.loadOperation(request.operation_id));
    const verifyPgBinding=async()=>{
    const current=await checked(()=>control.loadOperation(request.operation_id)),snapshot=await checked(()=>expenseLedger());
    requireThat(canonical(current)===canonical(operation),'AUTHORITY_OPERATION_CHANGED');
    const launchConfig=nodeLaunchConfig(config.pool,operation?.identity?.instance_id);
    requireRetainedRequest(config.pool,operation?.identity?.instance_id,operation?.request);
    requireThat(operation?.state==='completed'&&['run','start'].includes(operation.action)&&operation.provider_request_id&&
      canonical(operation.identity)===canonical(request.identity)&&operation.identity.account_id===config.account_id&&operation.identity.region===config.region&&
      operation.request.source_sha256===launchConfig.source_sha256&&operation.request.image_sha256===launchConfig.image_sha256,'AUTHORITY_OPERATION_SCOPE');
    const node=snapshot.nodes.find(n=>canonical(n.identity)===canonical(operation.identity));
    requireThat(node&&['starting','ready','draining'].includes(node.state)&&node.cloud_start_operation_id===operation.operation_id&&
      node.launch_manifest_sha256===operation.request.launch_manifest_sha256&&snapshot.nodes.filter(n=>n.state!=='destroyed').length<=2,'AUTHORITY_NODE_SCOPE');
    };
    const verifyBinding=async()=>{
    await verifyPgBinding();
    const observed=await checked(()=>operation.action==='run'?cloud.describeRun(operation):cloud.describe(operation.identity.instance_id));
    requireThat(executionCloudCompletionMatches(operation,observed),'AUTHORITY_CLOUD_COMPLETION');
    // Cloud I/O may straddle a Stop or new epoch. PG is authoritative at the
    // last boundary before delivery, after the final cloud read has settled.
    await verifyPgBinding();
    };
    await verifyBinding();
    const transport_credentials=await checked(()=>sign(operation.identity,issuer,{now,operation}));
    // A Stop or newer epoch during signing invalidates the result before any
    // caller can install or publish it. Never return a late signed response.
    await verifyBinding();
    return {version:request.version,operation_id:operation.operation_id,provider_request_id:operation.provider_request_id,transport_credentials};
  }
  return {async handle(request,{deadline=now()+20000,isConnected=()=>true}={}){
    requireThat(!active,'AUTHORITY_BUSY');let expired=false,timer;
    const guard=()=>requireThat(!expired&&now()<deadline&&isConnected(),'AUTHORITY_REQUEST_EXPIRED');
    const operation=Promise.resolve().then(()=>execute(request,guard));
    const record={};active=record;
    const cutoff=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('AUTHORITY_REQUEST_EXPIRED'));},Math.max(0,Math.min(20000,deadline-now())));});
    operation.finally(()=>{clearTimeout(timer);if(active===record)active=null;}).catch(()=>{});
    return Promise.race([operation,cutoff]);
  }};
}

export async function serveControlAuthority(authority,path='/run/bondbuddy/elastic-control/issuer.sock'){
  requireThat(process.getuid()===0&&path==='/run/bondbuddy/elastic-control/issuer.sock','AUTHORITY_ROOT_REQUIRED');
  const parent=await lstat('/run/bondbuddy/elastic-control');
  requireThat(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===0&&parent.gid===1000&&(parent.mode&0o777)===0o750&&
    (await readdir('/run/bondbuddy/elastic-control')).every(name=>name==='issuer.sock'),'AUTHORITY_DIRECTORY');
  try{const s=await lstat(path);requireThat(s.isSocket()&&s.uid===0&&s.gid===1000&&(s.mode&0o777)===0o660,'AUTHORITY_SOCKET_DRIFT');
    const alive=await new Promise(resolve=>{const c=net.connect(path);c.once('connect',()=>{c.destroy();resolve(true);});c.once('error',e=>resolve(e.code!=='ECONNREFUSED'));});
    requireThat(!alive,'AUTHORITY_ALREADY_ACTIVE');await unlink(path);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const server=net.createServer(socket=>{let bytes=0,text='',handling=false;const deadline=Date.now()+20000;
    const timer=setTimeout(()=>socket.destroy(),20000);socket.once('close',()=>clearTimeout(timer));socket.on('error',()=>{});
    socket.on('data',async chunk=>{if(handling)return;bytes+=chunk.length;if(bytes>8192){socket.destroy();return;}text+=chunk.toString();
      if(!text.endsWith('\n'))return;handling=true;socket.pause();
      try{const result=await authority.handle(JSON.parse(text),{deadline,isConnected:()=>!socket.destroyed});if(!socket.destroyed)socket.end(canonical(result)+'\n');}
      catch{if(!socket.destroyed)socket.end('{"status":"blocked"}\n');}
    });
  });server.maxConnections=16;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});await chown(path,0,1000);await chmod(path,0o660);
  return server;
}

async function main(){
  requireThat(process.getuid()===0,'AUTHORITY_ROOT_REQUIRED');
  const config=await readPrivateJson('/var/lib/bondbuddy/elastic-pg-mtls/authority.json');
  requireThat(config.account_id==='100006372392'&&config.region==='ap-beijing'&&config.control_role_id==='4611686018450406472'&&
    config.credentials.sourceCredentialsFile==='/etc/bondbuddy/execution-control/source-credentials.json'&&
    !config.issuer.authority_socket&&config.issuer.ca_file==='/var/lib/bondbuddy/elastic-pg-mtls/issuer/ca.pem'&&
    config.issuer.signing_key_file==='/var/lib/bondbuddy/elastic-pg-mtls/issuer/ca.key','AUTHORITY_CONFIG_SCOPE');
  const pg=await readPrivateJson('/var/lib/bondbuddy/elastic-pg-mtls/issuer/pg-identity.json');
  const databaseBinding=validateAuthorityDatabaseBinding(config,pg);
  const db=await readPrivateJson(databaseBinding.credentials_file);
  validateAuthorityDatabaseConnection(db.database_url,databaseBinding);
  const {Pool}=await import('pg'),{executionCapacityControl,executionCloudExpenseLedger}=await import('@bondbuddy/api/execution-capacity');
  const {createControlCredentialProvider}=await import('./control-credentials.mjs');
  const pool=new Pool({connectionString:db.database_url,max:2,connectionTimeoutMillis:5000,query_timeout:10000});
  const verifyDatabase=async()=>{const r=(await pool.query('SELECT system_identifier::text,current_database() AS name FROM pg_control_system()')).rows[0];
    verifyAuthorityDatabaseIdentity(r,databaseBinding);};
  const credentialsProvider=createControlCredentialProvider(config.credentials);
  const control=executionCapacityControl(pool);
  const cloud=new TencentCvm({config:config.pool,control,readRegisteredNodes:identity=>readAuthorityRegisteredNodes(pool,identity),
    transport:new TencentTransport({region:config.region,credentials:()=>credentialsProvider.get()}),archive:observationArchive(config.observation_directory)});
  await verifyDatabase();const server=await serveControlAuthority(createControlAuthority({config,control,expenseLedger:()=>executionCloudExpenseLedger(pool),cloud,credentialsProvider,verifyDatabase}));
  const shutdown=()=>{server.close(()=>pool.end());};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{await main();}catch{process.stderr.write('Control authority failed closed.\n');process.exitCode=1;}
