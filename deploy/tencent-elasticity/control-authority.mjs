import net from 'node:net';
import {lstat,chown,chmod,unlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {canonical,requireThat} from './policy.mjs';
import {readPrivateJson,observationArchive} from './private-files.mjs';
import {TencentTransport,TencentCvm} from './tencent-cvm.mjs';
import {issueTransportCredentials,validateTransportIssuer} from './transport-issuer.mjs';

/** The local root authority owns source credentials and the CA. Callers send
 * IDs only; PG and exact cloud readback supply all signing authorization. */
export function createControlAuthority({config,control,expenseLedger,cloud,credentialsProvider,verifyDatabase,now=Date.now}){
  const issuer=config.issuer;
  return {async handle(request){
    requireThat(request&&['execution-pg-issuer-v1','execution-control-credentials-v1'].includes(request.version),'AUTHORITY_PROTOCOL');
    if(request.version==='execution-control-credentials-v1'){
      requireThat(Object.keys(request).every(k=>['version','account_id','role_id'].includes(k))&&
        request.account_id===config.account_id&&request.role_id===config.control_role_id,'AUTHORITY_CREDENTIAL_SCOPE');
      const credentials=await credentialsProvider.get();
      requireThat(credentials.token&&credentials.expiresAt>now()+60000,'AUTHORITY_SHORT_EXPIRED');
      return {version:request.version,account_id:config.account_id,role_id:config.control_role_id,credentials};
    }
    requireThat(['status','issue'].includes(request.action)&&Object.keys(request).every(k=>['version','action','operation_id','identity'].includes(k)),'AUTHORITY_ISSUER_ACTION');
    await verifyDatabase();await validateTransportIssuer(issuer,{now});
    if(request.action==='status'){await credentialsProvider.get();return {version:request.version,ready:true,ca_sha256:issuer.ca_sha256};}
    requireThat(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(request.operation_id??''),'AUTHORITY_OPERATION_ID');
    const operation=await control.loadOperation(request.operation_id),snapshot=await expenseLedger();
    requireThat(operation?.state==='completed'&&['run','start'].includes(operation.action)&&operation.provider_request_id&&
      canonical(operation.identity)===canonical(request.identity)&&operation.identity.account_id===config.account_id&&operation.identity.region===config.region&&
      operation.request.source_sha256===config.pool.source_sha256&&operation.request.image_sha256===config.pool.image_sha256,'AUTHORITY_OPERATION_SCOPE');
    const node=snapshot.nodes.find(n=>canonical(n.identity)===canonical(operation.identity));
    requireThat(node&&['starting','ready','draining'].includes(node.state)&&node.cloud_start_operation_id===operation.operation_id&&
      node.launch_manifest_sha256===operation.request.launch_manifest_sha256&&snapshot.nodes.filter(n=>n.state!=='destroyed').length<=2,'AUTHORITY_NODE_SCOPE');
    const observed=await cloud.describe(operation.identity.instance_id);
    requireThat(observed.instance_state==='RUNNING'&&observed.latest_operation_state==='SUCCESS'&&
      observed.latest_operation===(operation.action==='run'?'RunInstances':'StartInstances')&&observed.latest_operation_request_id===operation.provider_request_id,
      'AUTHORITY_CLOUD_COMPLETION');
    const transport_credentials=await issueTransportCredentials(operation.identity,issuer,{now,operation});
    return {version:request.version,operation_id:operation.operation_id,provider_request_id:operation.provider_request_id,transport_credentials};
  }};
}

export async function serveControlAuthority(authority,path='/run/bondbuddy/elastic-control/issuer.sock'){
  requireThat(process.getuid()===0&&path==='/run/bondbuddy/elastic-control/issuer.sock','AUTHORITY_ROOT_REQUIRED');
  const parent=await lstat('/run/bondbuddy/elastic-control');
  requireThat(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===0&&parent.gid===1000&&(parent.mode&0o777)===0o750,'AUTHORITY_DIRECTORY');
  try{const s=await lstat(path);requireThat(s.isSocket()&&s.uid===0&&s.gid===1000&&(s.mode&0o777)===0o660,'AUTHORITY_SOCKET_DRIFT');
    const alive=await new Promise(resolve=>{const c=net.connect(path);c.once('connect',()=>{c.destroy();resolve(true);});c.once('error',e=>resolve(e.code!=='ECONNREFUSED'));});
    requireThat(!alive,'AUTHORITY_ALREADY_ACTIVE');await unlink(path);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const server=net.createServer(socket=>{let bytes=0,text='',handling=false;socket.setTimeout(20000,()=>socket.destroy());socket.on('error',()=>{});
    socket.on('data',async chunk=>{if(handling)return;bytes+=chunk.length;if(bytes>8192){socket.destroy();return;}text+=chunk.toString();
      if(!text.endsWith('\n'))return;handling=true;socket.pause();
      try{socket.end(canonical(await authority.handle(JSON.parse(text)))+'\n');}catch{socket.end('{"status":"blocked"}\n');}
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
  requireThat(pg.credential_ready===true&&pg.database_name==='bb1361_owned_isolated'&&pg.system_identifier==='7705237779724353574'&&
    pg.credentials_file==='/var/lib/bondbuddy/elastic-pg-mtls/issuer/pg-credentials.json','AUTHORITY_DATABASE_NOT_READY');
  const db=await readPrivateJson(pg.credentials_file),url=new URL(db.database_url);
  requireThat(url.hostname==='127.0.0.1'&&url.port==='15432'&&decodeURIComponent(url.pathname.slice(1))===pg.database_name,'AUTHORITY_DATABASE_SCOPE');
  const {Pool}=await import('pg'),{executionCapacityControl,executionCloudExpenseLedger}=await import('@bondbuddy/api/execution-capacity');
  const {createControlCredentialProvider}=await import('./control-credentials.mjs');
  const pool=new Pool({connectionString:db.database_url,max:2,connectionTimeoutMillis:5000,query_timeout:10000});
  const verifyDatabase=async()=>{const r=(await pool.query('SELECT system_identifier::text,current_database() AS name FROM pg_control_system()')).rows[0];
    requireThat(r.system_identifier===pg.system_identifier&&r.name===pg.database_name,'AUTHORITY_DATABASE_DRIFT');};
  const credentialsProvider=createControlCredentialProvider(config.credentials);
  const cloud=new TencentCvm({config:config.pool,transport:new TencentTransport({region:config.region,credentials:()=>credentialsProvider.get()}),archive:observationArchive(config.observation_directory)});
  await verifyDatabase();const server=await serveControlAuthority(createControlAuthority({config,control:executionCapacityControl(pool),expenseLedger:()=>executionCloudExpenseLedger(pool),cloud,credentialsProvider,verifyDatabase}));
  const shutdown=()=>{server.close(()=>pool.end());};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{await main();}catch{process.stderr.write('Control authority failed closed.\n');process.exitCode=1;}
