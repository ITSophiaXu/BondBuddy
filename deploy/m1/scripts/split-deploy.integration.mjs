// Local Linux synthetic integration. Reuses an existing runtime image but mounts the exact built
// checkout and dependencies; no model, production endpoint, private assets or live credentials.
// BB_SPLIT_TEST_RUNTIME_IMAGE=<local image> node deploy/m1/scripts/split-deploy.integration.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root=resolve(import.meta.dirname,'../../..');
const runtime=process.env.BB_SPLIT_TEST_RUNTIME_IMAGE;
assert.ok(runtime,'set BB_SPLIT_TEST_RUNTIME_IMAGE to a verified local Node runtime image');
const temp=mkdtempSync(join(root,'.split-integration-'));chmodSync(temp,0o700);
const suffix=process.pid,main=`bb907-main-${suffix}`,execution=`bb907-exec-${suffix}`,edge=`bb907-ssh-${suffix}`;
const tunnelImage=`bb907-pg-tunnel:${suffix}`,serverImage=`bb907-sshd:${suffix}`;
const commands=[];
function run(cmd,args,options={}) {return execFileSync(cmd,args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe'],...options});}
function config(role,override,...args) {
 const project=role==='main'?main:execution;
 return ['compose','--project-directory',join(root,'deploy/m1'),'--env-file',join(temp,`${role}.env`),'-p',project,'-f',join(root,`deploy/m1/compose.${role}.yaml`),'-f',join(temp,override),...args];
}
function docker(role,override,...args) {return run('docker',config(role,override,...args),{env:{...process.env,POSTGRES_PASSWORD:role==='main'?'synthetic':'unused-no-local-database'}});}
const env={BB_IMAGE_TAG:'synthetic',POSTGRES_PASSWORD:'synthetic',BB_MAIN_DATABASE_URL:'postgresql://bondbuddy:synthetic@postgres:5432/bondbuddy',BB_PUBLIC_ORIGIN:'https://bondbuddy.test',BB_TERMS_VERSION:'synthetic',BB_TRIAL_SOURCE_SALT:'synthetic',
 AZURE_STORAGE_CONNECTION_STRING:'UseDevelopmentStorage=true',BB_PARSE_CACHE_OCR_VERSION:'synthetic',BB_PARSE_CACHE_BASIS_VERSION:'synthetic',BB_FILE_TEMPLATE_HOST_DIR:temp,BB_PAYMENT_SECRETS_DIR:temp,
 BB_PG_SSH_HOST:'sshd',BB_PG_SSH_PORT:'2222',BB_PG_SSH_USER:'tunnel',BB_PG_SSH_KEY_FILE:join(temp,'client'),BB_PG_SSH_KNOWN_HOSTS_FILE:join(temp,'known_hosts'),
 BB_CODEX_MODEL:'deepseek-flash',DEEPSEEK_API_KEY:'synthetic-not-a-key',BB_EXECUTION_DATABASE_URL:'postgresql://bondbuddy:synthetic@pg-tunnel:5432/bondbuddy',BB_BACKEND_SUBNET:'10.239.91.0/24',BB_WEB_IP:'10.239.91.10'};
for(const role of ['main','execution'])writeFileSync(join(temp,`${role}.env`),Object.entries({...env,BB_DEPLOY_ROLE:role}).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});
const mounted={image:runtime,volumes:[`${root}:/app`],working_dir:'/app',user:'1000:1000'};
writeFileSync(join(temp,'main.json'),JSON.stringify({services:{
 postgres:{command:['postgres','-c','cluster_name=bb907-synthetic'],ports:[]},
 migrate:{...mounted},
 sshd:{image:serverImage,user:'0:0',entrypoint:['/bin/sh','-c'],command:[`socat TCP-LISTEN:15432,bind=127.0.0.1,fork TCP:postgres:5432 & exec /usr/sbin/sshd -D -e -p 2222 -h /test/host -o AuthorizedKeysFile=/test/authorized_keys -o StrictModes=no -o PasswordAuthentication=no -o AllowTcpForwarding=local -o PermitOpen=127.0.0.1:15432 -o AllowAgentForwarding=no -o X11Forwarding=no -o PermitTTY=no`],volumes:[`${temp}:/test:ro`],networks:['backend','test-ssh']}
 },networks:{'test-ssh':{external:true,name:edge}}}));
// A different internal subnet proves there is no shared application/PG network between the roles.
writeFileSync(join(temp,'execution.yaml'),`services:
  pg-tunnel:
    image: ${tunnelImage}
    networks: !override [backend, edge]
  worker:
    image: ${runtime}
    user: '1000:1000'
    working_dir: /app
    security_opt: !override [no-new-privileges:true]
    volumes:
      - ${root}:/app
    environment:
      BB_PARSE_STAGING_DIR: /tmp/split-parse
      BB_PLATFORM_PROBE_ENABLED: '0'
    command: ['sh', '-c', 'mkdir -p /tmp/split-parse && chmod 700 /tmp/split-parse && exec node apps/worker/dist/runtime.js']
networks:
  backend:
    ipam: !override {config: [{subnet: 10.239.92.0/24}]}
  edge:
    external: true
    name: ${edge}
`);
try {
 run('docker',['image','inspect',runtime]);run('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(temp,'client')]);run('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(temp,'host')]);
 writeFileSync(join(temp,'authorized_keys'),`restrict,port-forwarding,permitopen="127.0.0.1:15432",command="/bin/false" ${readFileSync(join(temp,'client.pub'),'utf8')}`);
 writeFileSync(join(temp,'known_hosts'),`[sshd]:2222 ${readFileSync(join(temp,'host.pub'),'utf8')}`);
 run('docker',['build','--network','host','-q','-t',tunnelImage,join(root,'deploy/m1/pg-tunnel')]);
 writeFileSync(join(temp,'Dockerfile'),`FROM ${tunnelImage}\nUSER root\nRUN apk add --no-cache openssh-server socat && passwd -d tunnel\n`);
 run('docker',['build','--network','host','-q','-t',serverImage,temp]);
 run('docker',['network','create',edge]);
 docker('main','main.json','up','-d','--wait','postgres','sshd');
 docker('main','main.json','run','--rm','--no-deps','-T','migrate');
 console.log('PASS main-only migrations on isolated PG16');
 docker('execution','execution.yaml','up','-d','--wait','pg-tunnel');
 function check(mode,expected=0) {
  const r=spawnSync('docker',config('execution','execution.yaml','run','--rm','--no-deps','-T','worker','node','--input-type=module','-','execution',mode),{
   cwd:root,env:{...process.env,POSTGRES_PASSWORD:'unused-no-local-database'},input:readFileSync(join(root,'deploy/m1/scripts/role-probe.mjs')),encoding:'utf8'});
  assert.equal(r.status,expected,`role probe ${mode}: ${r.stdout} ${r.stderr}`);
  assert.doesNotMatch(r.stdout+r.stderr,/postgresql:\/\//); return r;
 }
 check('schema');console.log('PASS real execution container reaches sole PG via restricted SSH from internal network');
 docker('execution','execution.yaml','run','--rm','--no-deps','-T','worker','node','deploy/m1/scripts/split-queue-smoke.mjs');
 console.log('PASS real queue submission, claim, renewal and stale-token exclusion across SSH');
 docker('main','main.json','exec','-T','postgres','psql','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1','-c',"UPDATE bb_jobs SET state='running',lease_token='synthetic-token',lease_until=now()+interval '60 seconds'");
 check('idle',76);
 docker('main','main.json','exec','-T','postgres','psql','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1','-c',"UPDATE bb_jobs SET state='paused',lease_token=NULL,lease_until=NULL");
 console.log('PASS actual running-job gate refuses switching');
 // Start actual production runtime, observe its durable group heartbeat, then SIGTERM with no in-flight calls.
 docker('execution','execution.yaml','up','-d','--no-deps','worker');
 let heartbeat=false;
 for(let i=0;i<20;i++) {
  const result=docker('main','main.json','exec','-T','postgres','psql','-U','bondbuddy','-d','bondbuddy','-Atc',"SELECT count(*) FROM bb_worker_heartbeats WHERE worker_id LIKE 'authoring_%' AND stopped_at IS NULL");
  if(Number(result.trim())>0){heartbeat=true;break;}await new Promise(r=>setTimeout(r,500));
 }
 assert.ok(heartbeat,`runtime heartbeat through tunnel: ${docker('execution','execution.yaml','logs','--tail','20','worker')}`);
 docker('execution','execution.yaml','stop','worker');check('idle');console.log('PASS production runtime heartbeat and clean SIGTERM through SSH');
 // Dump/restore drill operates on a different database, never on a shared Blob account.
 const dump=run('docker',config('main','main.json','exec','-T','postgres','pg_dump','-U','bondbuddy','-d','bondbuddy','-Fc'),{encoding:null});
 docker('main','main.json','exec','-T','postgres','createdb','-U','bondbuddy','bb907_restore');
 run('docker',config('main','main.json','exec','-T','postgres','pg_restore','-U','bondbuddy','-d','bb907_restore','--no-owner','--exit-on-error'),{input:dump});
 const query="SELECT (SELECT count(*) FROM bb_jobs)||':'||(SELECT count(*) FROM bb_schema_migrations)";
 assert.equal(docker('main','main.json','exec','-T','postgres','psql','-U','bondbuddy','-d','bb907_restore','-Atc',query),docker('main','main.json','exec','-T','postgres','psql','-U','bondbuddy','-d','bondbuddy','-Atc',query));
 console.log('PASS once-only synthetic PG dump/restore with queue and migration counts preserved');
 docker('main','main.json','stop','postgres');check('idle',77);console.log('PASS PG unavailable blocks switching; listener health alone cannot pass');
 docker('execution','execution.yaml','stop','pg-tunnel');
 writeFileSync(join(temp,'known_hosts'),`[sshd]:2222 ${readFileSync(join(temp,'client.pub'),'utf8')}`);
 const wrong=spawnSync('docker',config('execution','execution.yaml','run','--rm','--no-deps','-T','pg-tunnel'),{env:{...process.env,POSTGRES_PASSWORD:'unused'},encoding:'utf8',timeout:20000});
 assert.notEqual(wrong.status,0);assert.match(wrong.stderr,/Host key verification failed|HOST IDENTIFICATION HAS CHANGED/);
 console.log('PASS changed SSH host key rejected');
} finally {
 for(const [role,file] of [['execution','execution.yaml'],['main','main.json']]) {
  try{docker(role,file,'down','--volumes','--remove-orphans');}catch{console.error(`cleanup failed for synthetic ${role} project`);process.exitCode=1;}
 }
 try{run('docker',['network','rm',edge]);}catch{}
 for(const image of [serverImage,tunnelImage])try{run('docker',['image','rm',image]);}catch{}
 rmSync(temp,{recursive:true,force:true});
}
