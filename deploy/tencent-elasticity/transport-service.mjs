import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,lstat,chmod,chown,unlink,readdir} from 'node:fs/promises';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import {readPrivateJson} from './private-files.mjs';
import {readRoleCredentials} from './bootstrap.mjs';
import {TencentTransport} from './tencent-cvm.mjs';
import {installPrivateTransport} from './private-transport.mjs';
import {createTransportRefresher,selectTransportRenewalVersion} from './transport-refresher.mjs';
import {createStunnelReloadController} from './stunnel-reload.mjs';
import {acquireControlTick} from './control-tick-bound.mjs';
import {requireThat,sha256} from './policy.mjs';
import {nodeCloudCompletionMatches,readNodeSlotInstance,readNodeSecretVersions} from './enrollment.mjs';
import {selectExecutionNodeConfig} from './node-adapter.mjs';
const exec=promisify(execFile);

/** The existing transport service supervises stunnel and the root-only refresh
 * socket. There is no independent scheduler or consumer. */
export async function serveTransport(config){
  requireThat(process.getuid()===0,'TRANSPORT_ROOT_REQUIRED');
  const state=await readPrivateJson('/etc/bondbuddy/transport/state.json'),pg=config.private_pg;
  requireThat(state.identity.account_id===config.account_id&&state.identity.region===config.region&&
    sha256(await readFile(pg.config_file))===pg.config_sha256,'TRANSPORT_SERVICE_SCOPE');
  const socketPath='/run/bondbuddy/transport-socket/transport.sock';
  const parent=await lstat('/run/bondbuddy/transport-socket');
  requireThat(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===0&&parent.gid===1000&&(parent.mode&0o777)===0o750&&
    (await readdir('/run/bondbuddy/transport-socket')).every(name=>name==='transport.sock'),'TRANSPORT_SOCKET_DIRECTORY');
  try{const s=await lstat(socketPath);requireThat(s.isSocket()&&s.uid===0,'TRANSPORT_SOCKET_DRIFT');
    // A connectable socket belongs to an active service; never unlink it.
    const alive=await new Promise(resolve=>{const c=net.connect(socketPath);c.once('connect',()=>{c.destroy();resolve(true);});c.once('error',e=>resolve(e.code!=='ECONNREFUSED'));});
    requireThat(!alive,'TRANSPORT_SERVICE_ALREADY_ACTIVE');await unlink(socketPath);
  }catch(e){if(e.code!=='ENOENT')throw e;}
  const child=spawn('/usr/bin/stunnel',[pg.config_file],{stdio:['ignore','ignore','pipe']});
  const nativeReload=createStunnelReloadController(child);
  try{await nativeReload.ready();}catch(error){child.kill('SIGTERM');throw error;}
  const cloud=new TencentTransport({region:config.region,credentials:()=>readRoleCredentials(config.role_name)});
  const readActive=async()=>({version:'execution-pg-mtls-v1',...state.identity,ca_pem:await readFile(pg.ca_file,'utf8'),cert_pem:await readFile(pg.cert_file,'utf8'),key_pem:await readFile(pg.key_file,'utf8')});
  const refresh=createTransportRefresher({config,state,readActive,
    reserveBroker:()=>acquireControlTick(`${pg.credential_directory}/ssm-broker`),
    broker:async()=>{
      const caller=await cloud.call('sts','GetCallerIdentity',{});requireThat(String(caller.AccountId)===config.account_id&&String(caller.UserId).startsWith(`${config.role_id}:`),'TRANSPORT_ROLE_DRIFT');
      const i=await readNodeSlotInstance(config,state.identity.instance_id,(...args)=>cloud.call(...args));
      requireThat(nodeCloudCompletionMatches(state,i),'TRANSPORT_CLOUD_DRIFT');
      const values=await readNodeSecretVersions(config,(...args)=>cloud.call(...args));
      requireThat(nodeCloudCompletionMatches(state,await readNodeSlotInstance(config,state.identity.instance_id,(...args)=>cloud.call(...args))),'TRANSPORT_CLOUD_DRIFT');
      return selectTransportRenewalVersion(values,state,config,await readActive());
    },
    install:c=>installPrivateTransport(pg.credential_directory,c,{...state.identity,operation_id:state.operation_id,provider_request_id:state.provider_request_id,ca_sha256:pg.ca_sha256}),
    reload:nativeReload.reload,
    probe:async()=>{
      for(const service of config.services){
        const envFile=`/run/bondbuddy/service/${service.service_id}.env`;
        const stat=await lstat(envFile);requireThat(stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===1000&&(stat.mode&0o777)===0o600,'TRANSPORT_PROBE_ENV');
        const urls=(await readFile(envFile,'utf8')).split('\n').filter(line=>line.startsWith('DATABASE_URL='));
        requireThat(urls.length===1,'TRANSPORT_PROBE_ENV');const expectedUrl=new URL(urls[0].slice('DATABASE_URL='.length));
        const program="const{Pool}=await import('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000,query_timeout:5000});try{console.log(JSON.stringify((await p.query('SELECT system_identifier::text,current_database() AS database_name,current_user AS role_name FROM pg_control_system()')).rows[0]))}finally{await p.end()}";
        const {stdout:id}=await exec('/usr/bin/docker',['create','--pull','never','--network',config.execution_network,'--memory','128m','--pids-limit','64','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--env-file',envFile,'--entrypoint','node',config.images[service.service_id],'--input-type=module','-e',program],{timeout:5000,maxBuffer:4096});
        requireThat(/^[a-f0-9]{12,64}$/.test(id.trim()),'TRANSPORT_PROBE_ID');
        try{const r=await exec('/usr/bin/docker',['start','-a',id.trim()],{timeout:10000,maxBuffer:4096});const observed=JSON.parse(r.stdout);
          requireThat(observed.system_identifier===pg.system_identifier&&observed.database_name===decodeURIComponent(expectedUrl.pathname.slice(1))&&
            observed.role_name===decodeURIComponent(expectedUrl.username),'TRANSPORT_PROBE_IDENTITY');}
        finally{const r=await exec('/usr/bin/docker',['inspect','--format','{{.State.Running}}',id.trim()],{timeout:5000});if(r.stdout.trim()==='false')await exec('/usr/bin/docker',['rm',id.trim()],{timeout:5000});}
      }
    }});
  const server=net.createServer(socket=>{let bytes=0,text='';socket.setTimeout(20000,()=>socket.destroy());
    socket.on('error',()=>{});socket.on('data',async chunk=>{bytes+=chunk.length;if(bytes>4096){socket.destroy();return;}text+=chunk.toString();
      if(!text.endsWith('\n'))return;socket.pause();try{socket.end(JSON.stringify(await refresh.refresh(JSON.parse(text)))+'\n');}catch{socket.destroy();}});
  });server.maxConnections=16;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});await chown(socketPath,0,1000);await chmod(socketPath,0o660);
  let shuttingDown=false;
  child.once('error',()=>{server.close();process.exitCode=1;});
  child.once('close',()=>{server.close();process.exitCode=shuttingDown?0:1;});
  const shutdown=()=>{shuttingDown=true;server.close();child.kill('SIGTERM');};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
  return {server,child};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{
  await serveTransport(selectExecutionNodeConfig(await readPrivateJson('/etc/bondbuddy/elastic-node.json'),await readPrivateJson('/etc/bondbuddy/elastic-public.json')));
}catch{process.stderr.write('Private transport failed closed.\n');process.exitCode=1;}
