import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, chown, writeFile, chmod, readFile, lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readPrivateJson} from './private-files.mjs';
import {createSsmEnrollmentBroker} from './enrollment.mjs';
import {requireThat, canonical, sha256} from './policy.mjs';

const exec = promisify(execFile);
async function docker(args) {
  const {stdout} = await exec('/usr/bin/docker', args, {timeout: 20000, maxBuffer: 65536});
  return stdout.trim();
}
async function metadataValue(path) {
  const r = await fetch(`http://metadata.tencentyun.com/latest/meta-data/${path}`, {redirect: 'error', signal: AbortSignal.timeout(5000)});
  requireThat(r.ok && Number(r.headers.get('content-length') ?? 0) <= 1024, 'NODE_METADATA_BOUND');
  const text = await r.text(); requireThat(text.length <= 1024, 'NODE_METADATA_BOUND'); return text.trim();
}
export function createNodeAdapter(config, {runDocker=docker, readMetadata=metadataValue, enrollmentBroker, checkUnit}={}) {
requireThat(config.runtime_uid === 1000 && /^[a-f0-9]{64}$/.test(config.image_sha256) && config.compose_file.startsWith('/opt/bondbuddy/'), 'NODE_ADAPTER_CONFIG');
const launched=new Map();
async function metadata() {
  const [instance_id, region] = await Promise.all([readMetadata('instance-id'), readMetadata('placement/region')]);
  requireThat(/^ins-[a-z0-9]+$/.test(instance_id) && region === config.region, 'NODE_METADATA_SCOPE');
  return {account_id: config.account_id, instance_id, region}; // account is from controlled config, independently checked by STS
}
const ssmBroker = enrollmentBroker ?? createSsmEnrollmentBroker({config});
let enrollment;
const broker = {async enroll(hint) {
  enrollment = await ssmBroker.enroll(hint);
  return enrollment;
}};

const runtime = {
  async verifyArtifacts(e) {
    requireThat(canonical(e.services) === canonical(config.services) &&
      sha256(canonical(config.images)) === e.image_sha256, 'NODE_IMAGE_BUNDLE');
    requireThat(sha256(await import('node:fs/promises').then(fs => fs.readFile(config.compose_file))) === config.compose_sha256, 'NODE_COMPOSE_CHANGED');
    for (const service of e.services) {
      const image = config.images[service.service_id];
      requireThat(/^[-A-Za-z0-9._/:]+@sha256:[a-f0-9]{64}$/.test(image), 'NODE_IMAGE_DIGEST_REQUIRED');
      const inspected = await runDocker(['image', 'inspect', '--format', '{{json .RepoDigests}}', image]);
      requireThat(JSON.parse(inspected).includes(image), 'NODE_IMAGE_NOT_INSTALLED'); // no implicit pull
    }
    await mkdir('/run/bondbuddy/enrollment', {recursive: true, mode: 0o700});
    requireThat((await lstat('/run/bondbuddy/enrollment')).isDirectory() && !(await lstat('/run/bondbuddy/enrollment')).isSymbolicLink(),'NODE_PRIVATE_DIRECTORY');
    await chown('/run/bondbuddy/enrollment', 1000, 1000);await chmod('/run/bondbuddy/enrollment',0o700);
    await mkdir('/run/bondbuddy/service', {recursive: true, mode: 0o700});
    requireThat((await lstat('/run/bondbuddy/service')).isDirectory() && !(await lstat('/run/bondbuddy/service')).isSymbolicLink(),'NODE_PRIVATE_DIRECTORY');
    await chown('/run/bondbuddy/service',1000,1000);await chmod('/run/bondbuddy/service',0o700);
    requireThat(config.seccomp_sha256===sha256(await readFile(config.seccomp_file)) && config.apparmor_sha256===sha256(await readFile(config.apparmor_file)),'NODE_SECURITY_PROFILE_DRIFT');
    const profiles=await readFile('/sys/kernel/security/apparmor/profiles','utf8');
    requireThat(profiles.split('\n').includes('bondbuddy-codex-v1 (enforce)'),'NODE_SECURITY_PROFILE_NOT_LOADED');
    const pg=config.private_pg;
    requireThat(pg?.config_file?.startsWith('/etc/bondbuddy/') && sha256(await readFile(pg.config_file))===pg.config_sha256 &&
      pg.unit_name==='bondbuddy-execution-pg.service' && /^[A-Za-z0-9.-]+$/.test(pg.sni) && /^\d+$/.test(pg.system_identifier),'NODE_PRIVATE_PG_REQUIRED');
    const active=checkUnit?await checkUnit(pg.unit_name):(await exec('/usr/bin/systemctl',['is-active',pg.unit_name],{timeout:5000})).stdout.trim();
    requireThat(active==='active','NODE_PRIVATE_PG_TRANSPORT_NOT_ACTIVE');
    // The reviewed stunnel client config binds endpoint/SNI/CA/mTLS identity;
    // a route or CCN attachment on its own is never a readiness receipt.
    const transportText=await readFile(pg.config_file,'utf8');
    for(const line of ['client = yes','verifyChain = yes',`checkHost = ${pg.sni}`,`sni = ${pg.sni}`,`CAfile = ${pg.ca_file}`,`cert = ${pg.cert_file}`,`key = ${pg.key_file}`,
      `connect = ${pg.remote_host}:${pg.remote_port}`,`accept = ${pg.local_host}:${pg.local_port}`])
      requireThat(transportText.split('\n').map(x=>x.trim()).includes(line),'NODE_PRIVATE_PG_CONFIG_DRIFT');
    for(const file of [pg.ca_file,pg.cert_file,pg.key_file]){const st=await lstat(file);requireThat(st.isFile()&&!st.isSymbolicLink()&&(st.mode&0o777)===0o600,'NODE_PRIVATE_PG_CREDENTIAL_MODE');}

  },
  async startService(service, envelopePath) {
    // Compose overrides all scheduling/identity options. Arbitrary user shell
    // configuration and personal authentication variables are forbidden.
    const environment = enrollment.service_environments?.[service.service_id];
    requireThat(environment && Object.entries(environment).every(([k, v]) => /^[A-Z][A-Z0-9_]*$/.test(k) &&
      !/^(?:GIT|GH_|GITHUB|PASEO|SSH_|HOME$|CODEX_HOME$|PATH$|LD_|NODE_OPTIONS$|BB_EXECUTION_)/.test(k) &&
      typeof v === 'string' && !/[\r\n\0]/.test(v)), 'NODE_SERVICE_ENV_INVALID');
    const envFile = `/run/bondbuddy/service/${service.service_id}.env`;
    await writeFile(envFile, Object.entries(environment).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', {mode: 0o600});
    await chmod(envFile, 0o600); await chown(envFile,1000,1000);await chown(envelopePath, 1000, 1000);
    const url=new URL(environment.DATABASE_URL);
    requireThat(url.hostname===config.private_pg.local_host && Number(url.port||5432)===config.private_pg.local_port,'NODE_PG_ENDPOINT_DRIFT');
    requireThat(/^[a-zA-Z0-9_-]{1,64}$/.test(config.execution_network),'NODE_CONTROLLED_NETWORK_REQUIRED');
    const checkProgram="const {Pool}=await import('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000,query_timeout:10000});try{const r=(await p.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0];console.log(JSON.stringify(r));}finally{await p.end()}";
    const probeId=await runDocker(['create','--pull','never','--network',config.execution_network,'--memory','128m','--pids-limit','64',
      '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--env-file',envFile,
      '--entrypoint','node',config.images[service.service_id],'--input-type=module','-e',checkProgram]);
    requireThat(/^[a-f0-9]{12,64}$/.test(probeId),'NODE_PG_PREFLIGHT_ID');
    launched.set(probeId,{id:probeId,service_id:'pg-preflight'});
    try {
      const actual=JSON.parse(await runDocker(['start','-a',probeId]));
      requireThat(actual.system_identifier===config.private_pg.system_identifier,'NODE_PG_IDENTITY_MISMATCH');
    } finally {
      if(await runDocker(['inspect','--format','{{.State.Running}}',probeId])==='false'){
        await runDocker(['rm',probeId]);launched.delete(probeId);
      }
    }

    const composeEnv = '/run/bondbuddy/service/compose.env';
    const values = {BB_ELASTIC_IMAGE: config.images.authoring, BB_ELASTIC_REVIEW_IMAGE: config.images.review,BB_ELASTIC_NETWORK:config.execution_network,
      BB_ELASTIC_SERVICE_ENV: envFile, BB_ELASTIC_REGISTRATION_DIR: '/run/bondbuddy/enrollment'};
    await writeFile(composeEnv, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n'), {mode: 0o600});
    const args = ['compose', '--project-name', 'bondbuddy-execution', '--env-file', composeEnv, '-f', config.compose_file];
    try{await runDocker([...args,'up','--no-deps','--pull','never','-d',service.service_id]);}finally{
      // Even if the client lost the up response, discover the exact service ID
      // before returning. Failed/partial boot cannot leave an untracked claimant.
      const observed=await runDocker([...args,'ps','-a','-q',service.service_id]);
      if(/^[a-f0-9]{12,64}$/.test(observed))launched.set(observed,{id:observed,service_id:service.service_id});
    }
    const id = await runDocker([...args, 'ps', '-q', service.service_id]);
    requireThat(/^[a-f0-9]{12,64}$/.test(id), 'NODE_CONTAINER_ID');
    return {id, service_id: service.service_id};
  },
  async verifyAllReady(contexts) {
    requireThat(contexts.length === config.services.length && enrollment.identity, 'NODE_SERVICES_INCOMPLETE');
    // No supplier probe. The runtime's own preflight and PG expected-session
    // registration must prove every service ready under the exact epoch.
    const i = enrollment.identity;
    const sql = 'SELECT n.state,n.epoch,n.source_sha256,n.image_sha256,(pg_control_system()).system_identifier::text AS system_identifier FROM bb_execution_nodes n WHERE n.account_id=$1 AND n.region=$2 AND n.instance_id=$3';
    const program = `const {Pool}=await import('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000,query_timeout:10000});try{const r=(await p.query(${JSON.stringify(sql)},${JSON.stringify([i.account_id,i.region,i.instance_id])})).rows[0];console.log(JSON.stringify(r));}finally{await p.end()}`;
    const result = JSON.parse(await runDocker(['exec', contexts[0].id, 'node', '--input-type=module', '-e', program]));
    requireThat(result?.state === 'ready' && result.epoch === i.epoch && result.source_sha256 === enrollment.source_sha256 &&
      result.image_sha256 === enrollment.image_sha256 && result.system_identifier===config.private_pg.system_identifier, 'NODE_PG_READY_NOT_PROVEN');
  },
  async disableClaims(contexts) {
    for (const c of new Map([...contexts,...launched.values()].map(c=>[c.id,c])).values()){
      const running=await runDocker(['inspect','--format','{{.State.Running}}',c.id]);
      if(running==='true')await runDocker(['kill','--signal=SIGTERM',c.id]);
    }
    // No docker stop deadline, hard kill, TTL reclamation or fallback restart.
    // Managed runtime handles graceful drain and keeps lease heartbeats.
  }
};

return {metadata,broker,runtime};
}
export async function createConfiguredNodeAdapter(){return createNodeAdapter(await readPrivateJson('/etc/bondbuddy/elastic-node.json'));}
