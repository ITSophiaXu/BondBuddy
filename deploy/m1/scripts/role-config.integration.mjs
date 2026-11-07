// Synthetic lifecycle/network checks only. No application build, model call or business task.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
const root=resolve(import.meta.dirname,'../../..'), temp=mkdtempSync(join(root,'.role-integration-'));
chmodSync(temp,0o700);
const main=`bb911-main-${process.pid}`, execution=`bb911-exec-${process.pid}`, edge=`bb911-edge-${process.pid}`;
const sshImage=`bb911-synthetic-ssh:${process.pid}`, sshContainer=`bb911-sshd-${process.pid}`;
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const run=(cmd,args,options={})=>execFileSync(cmd,args,{cwd:root,encoding:'utf8',stdio:['pipe','pipe','pipe'],...options});
const docker=(...args)=>run('docker',args);
const source=run('git',['rev-parse','HEAD']).trim();
const password='synthetic:@/#?%$&=+!', pgImage=docker('image','inspect','postgres:16','--format','{{.Id}}').trim();
const runtime=docker('image','inspect','bondbuddy-m1-api:729a5aa71612','--format','{{.Id}}').trim();
const alternate=docker('image','inspect','bondbuddy-m1-worker:729a5aa71612','--format','{{.Id}}').trim();
const buildBase=JSON.parse(docker('image','inspect','redis:7-alpine','--format','{{json .RepoDigests}}'))[0];
assert.ok(buildBase?.startsWith('redis@sha256:'),'cached pinned SSH fixture base is required');
let checks=0;const pass=text=>{checks++;console.log(`PASS ${text}`);};
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const pgPort=await port(), sshPort=await port();
for(const name of ['payments','templates','main-state','execution-state'])mkdirSync(join(temp,name),{mode:0o700});
const env={BB_IMAGE_TAG:'synthetic',BB_DEPLOY_SCRIPT_SHA:source,POSTGRES_PASSWORD:`'${password}'`,BB_MAIN_DATABASE_URL:`postgresql://bondbuddy:${encodeURIComponent(password)}@postgres:5432/bondbuddy`,
 BB_EXECUTION_DATABASE_URL:`postgresql://bondbuddy:${encodeURIComponent(password)}@pg-tunnel:5432/bondbuddy`,BB_PARSE_ROLE:'main',BB_PG_FORWARD_PORT:String(pgPort),
 BB_PUBLIC_ORIGIN:'https://bondbuddy.test',BB_TERMS_VERSION:'synthetic',BB_TRIAL_SOURCE_SALT:'synthetic',AZURE_STORAGE_CONNECTION_STRING:'synthetic-no-blob',
 BB_PARSE_CACHE_OCR_VERSION:'synthetic',BB_PARSE_CACHE_BASIS_VERSION:'synthetic',BB_PAYMENT_SECRETS_DIR:join(temp,'payments'),BB_FILE_TEMPLATE_HOST_DIR:join(temp,'templates'),
 BB_INTEGRITY_MODE:'disabled',BB_PG_SSH_HOST:'synthetic.test',BB_PG_SSH_USER:'tunnel',BB_PG_SSH_KEY_FILE:join(temp,'client'),BB_PG_SSH_KNOWN_HOSTS_FILE:join(temp,'known_hosts'),BB_SYNTHETIC_APP_IMAGE:runtime};
const values={};
function writeEnv(role){writeFileSync(join(temp,`${role}.env`),Object.entries(values[role]).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});}
function compose(role,...args){return run('bash',['deploy/m1/scripts/role-compose.sh',role,...args],{env:{...process.env,BB_ENV_FILE:join(temp,`${role}.env`),BB_STATE_DIR:join(temp,`${role}-state`),BB_IMAGE_TAG:'synthetic'}});}
function attempt(role,args,extra={}){return spawnSync('bash',['deploy/m1/scripts/role-compose.sh',role,...args],{cwd:root,env:{...process.env,BB_ENV_FILE:join(temp,`${role}.env`),BB_STATE_DIR:join(temp,`${role}-state`),BB_IMAGE_TAG:'synthetic',...extra},encoding:'utf8'});}
function sql(query){return docker('run','--rm','--network','host','-e',`PGPASSWORD=${password}`,pgImage,'psql','-h','127.0.0.1','-p',String(pgPort),'-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1','-Atc',query).trim();}
function probe(role,mode,expected=0){const r=spawnSync('bash',['deploy/m1/scripts/role-compose.sh',role,'probe',mode],{
 cwd:root,env:{...process.env,BB_ENV_FILE:join(temp,`${role}.env`),BB_STATE_DIR:join(temp,`${role}-state`),BB_IMAGE_TAG:'synthetic'},encoding:'utf8'});
 assert.equal(r.status,expected,`synthetic ${role} ${mode} probe: ${r.stderr}`);assert.doesNotMatch(r.stdout+r.stderr,/postgresql:\/\//);}
try {
 docker('network','create',edge);
 const gateway=JSON.parse(docker('network','inspect',edge))[0].IPAM.Config[0].Gateway;
 run('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(temp,'client')]);run('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(temp,'host')]);
 writeFileSync(join(temp,'authorized_keys'),`restrict,port-forwarding,permitopen="127.0.0.1:${pgPort}",command="/bin/false" ${readFileSync(join(temp,'client.pub'),'utf8')}`,{mode:0o600});
 writeFileSync(join(temp,'known_hosts'),`[${gateway}]:${sshPort} ${readFileSync(join(temp,'host.pub'),'utf8')}`,{mode:0o600});
 writeFileSync(join(temp,'sshd_config'),`Port ${sshPort}\nListenAddress ${gateway}\nHostKey /test/host\nPidFile /run/sshd.pid\nAuthorizedKeysFile /test/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers tunnel\nAllowTcpForwarding local\nPermitOpen 127.0.0.1:${pgPort}\nPermitTTY no\nX11Forwarding no\nAllowAgentForwarding no\n`,{mode:0o600});
 // Only a small synthetic SSH fixture is built, from a cached, pinned base.
 writeFileSync(join(temp,'Dockerfile'),`FROM ${buildBase}\nUSER root\nRUN apk add --no-cache openssh-server openssh-client && adduser -D -u 1000 -G users tunnel && passwd -d tunnel\n`);
 docker('build','--network','host','-q','-t',sshImage,temp);
 docker('run','-d','--name',sshContainer,'--network','host','--read-only','--tmpfs','/run','--mount',`type=bind,src=${temp},dst=/test,readonly`,'--entrypoint','/bin/sh',sshImage,'-c','mkdir -p /run/sshd && exec /usr/sbin/sshd -D -e -f /test/sshd_config');
 writeFileSync(join(temp,'main.yaml'),`services:
  postgres:
    image: ${pgImage}
    command: ['postgres', '-c', 'cluster_name=bb911-synthetic']
    networks: [backend, pgbridge]
  api:
    image: \${BB_SYNTHETIC_APP_IMAGE:?synthetic image required}
    command: ['node', '-e', 'setInterval(()=>{},1000)']
    healthcheck: !override {disable: true}
networks:
  pgbridge:
    driver: bridge
    driver_opts:
      com.docker.network.bridge.enable_ip_masquerade: 'false'
`);
 writeFileSync(join(temp,'execution.yaml'),`services:
  pg-tunnel:
    image: ${sshImage}
    user: '1000:1000'
    entrypoint: ['ssh']
    command: ['-NT', '-L', '0.0.0.0:5432:127.0.0.1:${pgPort}', '-p', '${sshPort}', '-i', '/run/pg-ssh/key', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/run/pg-ssh/known_hosts', '-o', 'ExitOnForwardFailure=yes', 'tunnel@${gateway}']
    networks: !override [backend, edge]
    healthcheck: !override {test: ['CMD-SHELL', 'nc -z 127.0.0.1 5432'], interval: 2s, retries: 15}
  worker:
    image: ${runtime}
    security_opt: !override [no-new-privileges:true]
networks:
  edge:
    external: true
    name: ${edge}
`);
 for(const role of ['main','execution']){const file=join(temp,`${role}.yaml`);values[role]={...env,BB_DEPLOY_ROLE:role,BB_ROLE_STATE_DIR:join(temp,`${role}-state`),COMPOSE_PROJECT_NAME:role==='main'?main:execution,BB_ROLE_OVERRIDE_FILE:file,BB_ROLE_OVERRIDE_SHA256:hash(file)};writeEnv(role);}
 compose('main','up','-d','--wait','postgres');
 writeFileSync(join(temp,'main-state/current'),'synthetic\n');
 assert.equal(sql('SELECT 1'),'1');pass('ordinary main up automatically uses override; authenticated loopback PG SQL succeeds');
 const cfg=JSON.parse(compose('main','config','--format','json')), pg=compose('main','ps','-q','postgres').trim();
 const pgBefore=JSON.parse(docker('inspect',pg))[0], volume=pgBefore.Mounts.find(m=>m.Destination==='/var/lib/postgresql/data').Name;
 assert.equal(cfg.networks.backend.internal,true);assert.equal(cfg.networks.pgbridge.driver_opts['com.docker.network.bridge.enable_ip_masquerade'],'false');
 assert.equal(pgBefore.HostConfig.PortBindings['5432/tcp'][0].HostIp,'127.0.0.1');
 const net=JSON.parse(docker('network','inspect',`${main}_pgbridge`))[0];assert.equal(net.Options['com.docker.network.bridge.enable_ip_masquerade'],'false');assert.equal(Object.keys(net.Containers).length,1);
 pass('real PG bridge is dedicated, masquerade is disabled, business backend remains internal');
 const hostIp=Object.values(networkInterfaces()).flat().find(v=>v.family==='IPv4'&&!v.internal&&!v.address.startsWith('172.')&&v.address!=='127.0.0.1')?.address;
 assert.ok(hostIp,'an external host interface is required for negative PG probe');
 const reachable=await new Promise(r=>{const s=createConnection({host:hostIp,port:pgPort});s.setTimeout(2000);s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));s.once('timeout',()=>{s.destroy();r(false);});});
 assert.equal(reachable,false);pass('host non-loopback interface cannot reach published PG port');
 sql("CREATE TABLE synthetic_marker (value text); INSERT INTO synthetic_marker VALUES ('same-volume'); CREATE TABLE bb_schema_migrations(filename text); CREATE TABLE bb_jobs(state text); CREATE TABLE bb_review_messages(lease_token text)");
 sql('INSERT INTO bb_schema_migrations VALUES '+readdirSync(join(root,'db/migrations')).filter(n=>/^\d+.*\.sql$/.test(n)).map(n=>`('${n.replaceAll("'","''")}')`).join(','));
 probe('main','schema');pass('current role-probe reads authenticated SQL and synthetic migration state through ordinary entry');
 compose('execution','up','-d','--no-deps','--wait','pg-tunnel');writeFileSync(join(temp,'execution-state/current'),'synthetic\n');probe('execution','schema');
 pass('internal execution container reaches the sole PG through restricted SSH and verified host key');
 const execCfg=JSON.parse(compose('execution','config','--format','json'));assert.equal(execCfg.services['worker-parse'],undefined);assert.equal(execCfg.services.postgres,undefined);assert.equal(execCfg.services.migrate,undefined);
 assert.equal(attempt('execution',['up','-d','worker-parse']).status,2);pass('inactive execution parser is absent from ordinary selection and explicit startup is refused');
 compose('main','up','-d','--no-deps','--force-recreate','--wait','postgres');
 assert.equal(sql('SELECT value FROM synthetic_marker'),'same-volume');
 const pgAfter=JSON.parse(docker('inspect',compose('main','ps','-q','postgres').trim()))[0];assert.equal(pgAfter.Mounts.find(m=>m.Destination==='/var/lib/postgresql/data').Name,volume);
 probe('execution','connect');pass('ordinary PG rebuild retains override, loopback SQL, protected SSH connectivity and exact pgdata volume');
 const pgId=pgAfter.Id;
 for(const image of [runtime,alternate,runtime]){values.main.BB_SYNTHETIC_APP_IMAGE=image;writeEnv('main');compose('main','up','-d','--no-deps','--force-recreate','api');assert.equal(JSON.parse(docker('inspect',compose('main','ps','-q','api').trim()))[0].Image,image);assert.equal(compose('main','ps','-q','postgres').trim(),pgId);assert.equal(sql('SELECT value FROM synthetic_marker'),'same-volume');}
 pass('synthetic application switch and rollback verify actual image IDs without recreating PG or changing its data/volume');
 sql("INSERT INTO bb_jobs VALUES ('running')");probe('execution','idle',76);sql('TRUNCATE bb_jobs');probe('execution','idle');pass('real read-only SQL gate refuses in-flight synthetic jobs and passes after drain');
 const original=readFileSync(join(temp,'main.env'));
 delete values.main.BB_ROLE_OVERRIDE_FILE;delete values.main.BB_ROLE_OVERRIDE_SHA256;writeEnv('main');assert.equal(attempt('main',['up','-d','postgres']).status,2);writeFileSync(join(temp,'main.env'),original);values.main.BB_ROLE_OVERRIDE_FILE=join(temp,'main.yaml');values.main.BB_ROLE_OVERRIDE_SHA256=hash(join(temp,'main.yaml'));
 writeFileSync(join(temp,'main.yaml'),readFileSync(join(temp,'main.yaml'),'utf8')+'\n# drift\n');assert.equal(attempt('main',['up','-d','postgres']).status,2);
 // Restore exact bytes for cleanup; no binding is deleted or silently reset.
 writeFileSync(join(temp,'main.yaml'),readFileSync(join(temp,'main.yaml'),'utf8').replace('\n# drift\n',''));assert.equal(hash(join(temp,'main.yaml')),values.main.BB_ROLE_OVERRIDE_SHA256);
 assert.equal(attempt('main',['-f','alternate.yaml','up']).status,2);assert.equal(attempt('main',['up'],{COMPOSE_FILE:'alternate.yaml'}).status,2);
 assert.equal(sql('SELECT value FROM synthetic_marker'),'same-volume');pass('omitted/drifting coverage and old override channels fail closed while live synthetic PG remains intact');
 compose('main','stop','postgres');probe('execution','connect',77);pass('SQL probe fails when PG is stopped even while SSH listener survives');
 console.log(`checks=${checks} script_commit=${source} (synthetic only; no production adoption)`);
} finally {
 for(const role of ['execution','main'])if(values[role])try{compose(role,'down','--volumes','--remove-orphans');}catch{console.error(`synthetic ${role} cleanup failed`);process.exitCode=1;}
 try{docker('rm','-f',sshContainer);}catch{}
 try{docker('network','rm',edge);}catch{}
 try{docker('image','rm',sshImage);}catch{}
 rmSync(temp,{recursive:true,force:true});
}
