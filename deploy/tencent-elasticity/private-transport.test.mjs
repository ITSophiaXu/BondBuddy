import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,lstat,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import {once} from 'node:events';
import {installPrivateTransport,ensurePrivateExecutionNetwork} from './private-transport.mjs';
import {sha256} from './policy.mjs';
const exec=promisify(execFile);
const identity={account_id:'123456',region:'ap-beijing',instance_id:'ins-a1',epoch:'a3432123-84b5-4f11-8b51-94a29eac1234'};
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'bb-mtls-'));t.after(()=>rm(dir,{recursive:true}));
  await exec('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','2','-subj','/CN=synthetic-pg-ca','-keyout',join(dir,'ca.key'),'-out',join(dir,'ca.pem')]);
  for(const [name,cn,usage] of [['client',`${identity.instance_id}:${identity.epoch}`,'clientAuth'],['server','localhost','serverAuth']]) {
    await exec('openssl',['req','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj',`/CN=${cn}`,'-keyout',join(dir,`${name}.key`),'-out',join(dir,`${name}.csr`)]);
    await writeFile(join(dir,`${name}.ext`),`extendedKeyUsage=${usage}\n${name==='server'?'subjectAltName=DNS:localhost\n':''}`);
    await exec('openssl',['x509','-req','-in',join(dir,`${name}.csr`),'-CA',join(dir,'ca.pem'),'-CAkey',join(dir,'ca.key'),'-CAcreateserial','-days','1','-extfile',join(dir,`${name}.ext`),'-out',join(dir,`${name}.pem`)]);
  }
  const credentials={version:'execution-pg-mtls-v1',...identity,ca_pem:await readFile(join(dir,'ca.pem'),'utf8'),cert_pem:await readFile(join(dir,'client.pem'),'utf8'),key_pem:await readFile(join(dir,'client.key'),'utf8')};
  return {dir,credentials,expected:{...identity,ca_sha256:sha256(credentials.ca_pem)}};
}
test('newly issued node/epoch mTLS credentials are private; different identity, CA and symlink fail closed',async t=>{
  const {dir,credentials,expected}=await fixture(t),target=join(dir,'private');
  const files=await installPrivateTransport(target,credentials,expected);
  assert.equal((await lstat(target)).mode&0o777,0o700);
  for(const file of Object.values(files))assert.equal((await lstat(file)).mode&0o777,0o600);
  await assert.rejects(installPrivateTransport(target,{...credentials,epoch:'old'},expected),/PG_CREDENTIAL_IDENTITY/);
  await assert.rejects(installPrivateTransport(target,credentials,{...expected,ca_sha256:'0'.repeat(64)}),/PG_CA_PIN/);
  await symlink(target,join(dir,'link'));await assert.rejects(installPrivateTransport(join(dir,'link'),credentials,expected),/PG_PRIVATE_DIRECTORY/);
  await rm(files.key_file);await symlink(join(dir,'client.key'),files.key_file);
  await assert.rejects(installPrivateTransport(target,credentials,expected),/PG_PRIVATE_FILE/);
});
test('private execution network is idempotent and refuses existing unreviewed bridge or uncertain inventory',async()=>{
  const config={execution_network:'synthetic-execution',execution_network_subnet:'172.28.61.0/24',private_pg:{local_host:'172.28.61.1'}};
  const row={Name:config.execution_network,Driver:'bridge',Internal:true,Labels:{'bondbuddy.execution.network':'v1'},IPAM:{Config:[{Subnet:config.execution_network_subnet,Gateway:config.private_pg.local_host}]}};
  let exists=false,creates=0;
  const docker=async a=>{if(a[1]==='inspect'){if(!exists)throw Error('not found');return JSON.stringify([row]);}if(a[1]==='ls')return 'bridge\nnone';if(a[1]==='create'){exists=true;creates++;return 'synthetic';}throw Error('unexpected');};
  await ensurePrivateExecutionNetwork(config,docker);await ensurePrivateExecutionNetwork(config,docker);assert.equal(creates,1);
  await assert.rejects(ensurePrivateExecutionNetwork(config,async()=>JSON.stringify([{...row,Internal:false}])),/NODE_NETWORK_DRIFT/);
  await assert.rejects(ensurePrivateExecutionNetwork(config,async a=>{if(a[1]==='inspect')throw Error();return config.execution_network;}),/NODE_NETWORK_OBSERVATION_UNKNOWN/);
});
test('issued private files drive actual stunnel mTLS and a real isolated PostgreSQL identity query',
 {skip:!process.env.BB_TEST_DATABASE_URL||!process.env.BB_TEST_STUNNEL_BINARY,timeout:20000},async t=>{
  const {isolatedTestDatabase}=await import('../../apps/api/dist/test-database.js');
  const {Pool}=await import('pg');const connection=await isolatedTestDatabase(undefined,'private-mtls');
  const {dir,credentials,expected}=await fixture(t),files=await installPrivateTransport(join(dir,'private'),credentials,expected);
  const url=new URL(connection),upstreamHost=url.hostname,upstreamPort=Number(url.port),sockets=new Set();
  const server=tls.createServer({key:await readFile(join(dir,'server.key')),cert:await readFile(join(dir,'server.pem')),
    ca:credentials.ca_pem,requestCert:true,rejectUnauthorized:true},s=>{
    assert.equal(s.authorized,true);const upstream=net.connect(upstreamPort,upstreamHost);sockets.add(s);sockets.add(upstream);
    s.on('error',()=>{});upstream.on('error',()=>s.destroy());s.pipe(upstream).pipe(s);
  });server.on('tlsClientError',()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
  let child,closed,direct,through;
  t.after(async()=>{await through?.end();await direct?.end();if(child?.exitCode===null)child.kill('SIGTERM');if(closed)await closed;for(const s of sockets)s.destroy();server.close();});
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const conf=join(dir,'stunnel.conf');await writeFile(conf,`foreground = yes\npid =\ndebug = err\noutput = /dev/null\n[pg]\nclient = yes\naccept = 127.0.0.1:${port}\nconnect = 127.0.0.1:${server.address().port}\nverifyChain = yes\ncheckHost = localhost\nsni = localhost\nCAfile = ${files.ca_file}\ncert = ${files.cert_file}\nkey = ${files.key_file}\n`,{mode:0o600});
  child=spawn(process.env.BB_TEST_STUNNEL_BINARY,[conf],{stdio:'ignore'});closed=once(child,'close');
  const started=Date.now();for(;;){try{await new Promise((r,j)=>{const s=net.connect(port,'127.0.0.1');s.on('connect',()=>{s.destroy();r();});s.on('error',j);});break;}catch{assert.ok(Date.now()-started<3000);await new Promise(r=>setTimeout(r,25));}}
  direct=new Pool({connectionString:connection,max:1});
  const expectedId=(await direct.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0].system_identifier;
  url.hostname='127.0.0.1';url.port=String(port);through=new Pool({connectionString:url.toString(),ssl:false,max:1,connectionTimeoutMillis:5000});
  const result=(await through.query('SELECT system_identifier::text,current_database(),current_user FROM pg_control_system()')).rows[0];
  assert.equal(result.system_identifier,expectedId);assert.equal(result.current_database,decodeURIComponent(url.pathname.slice(1)));assert.ok(result.current_user);
});
