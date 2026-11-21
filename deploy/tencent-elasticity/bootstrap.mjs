import {readFileSync} from 'node:fs';
import {gzipSync, gunzipSync, brotliCompressSync, constants as zlibConstants} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {open, rename, unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {canonical, requireThat, sha256} from './policy.mjs';
import {INTEGRITY_TRANSPORT_SECTION} from './private-egress.mjs';

/** Install only public, pinned code. Private Blob capability arrives after enrollment. */
function businessBootstrap(config) {
  if(config.business_overlay_sha256)requireThat(/^[a-f0-9]{64}$/.test(config.business_overlay_sha256),'BUSINESS_OVERLAY_PIN');
  const files=Object.fromEntries(['node-adapter.mjs','business-overlay.mjs','authoring-workspace.mjs','task-cgroups.mjs','task-cgroup-broker.py','task-cgroup-broker.profile','task-runner.py','task-chromium'].map(name=>{
    const bytes=readFileSync(new URL(name,import.meta.url));
    return [name,{source:`/app/deploy/tencent-elasticity/${name}`,sha256:sha256(bytes)}];
  }));
  const compose=readFileSync(new URL('compose.yaml',import.meta.url));
  const integrityProfile=readFileSync(new URL('../m1/security/integrity-browser-seccomp.json',import.meta.url));
  const genericProfile=readFileSync(new URL('../m1/security/codex-seccomp.json',import.meta.url));
  const egress=readFileSync(new URL('private-egress.mjs',import.meta.url),'utf8');
  const addition=egress.match(/\/\/ Separate from the model proxy[^\n]*\nexport const INTEGRITY_TRANSPORT_SECTION=[^\n]*\n/)[0];
  const before=egress.replace(addition,'').replace('+INTEGRITY_TRANSPORT_SECTION;',';');
  const egressPatch={before_sha256:sha256(before),after_sha256:sha256(egress),addition};
  const integrityRule=JSON.parse(integrityProfile).syscalls.at(-1);
  const workerProfile=readFileSync(new URL('../m1/security/codex-apparmor.profile',import.meta.url));
  files['codex-apparmor.profile']={source:'/app/deploy/m1/security/codex-apparmor.profile',sha256:sha256(workerProfile)};
  const payload=gzipSync(JSON.stringify({egress_patch:egressPatch,generic_profile_sha256:sha256(genericProfile),integrity_profile_sha256:sha256(integrityProfile),integrity_rule:integrityRule,integrity_section:INTEGRITY_TRANSPORT_SECTION,pin:config.business_overlay_sha256,files,compose:{source:'/app/deploy/tencent-elasticity/compose.yaml',sha256:sha256(compose)}}),{level:9,mtime:0}).toString('base64');
  return `python3 - <<'BB_BUSINESS_CODE'
import os,json,gzip,base64,hashlib,stat,subprocess,re,tempfile
from pathlib import Path
assert os.geteuid()==0
p=json.loads(gzip.decompress(base64.b64decode('${payload}')))
h=lambda b:hashlib.sha256(b).hexdigest()
def regular(f):
 s=f.lstat();assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_mode&0o022==0;return f.read_bytes()
def save(f,b):
 t=f.with_name(f.name+'.business-install');fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as o:o.write(b);o.flush();os.fsync(o.fileno())
 os.replace(t,f)
def backup(f,raw):
 target=f.with_name(f.name+'.before-task-cgroups-v1')
 if not target.exists():
  fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as o:o.write(raw);o.flush();os.fsync(o.fileno())
bc=Path('/etc/bondbuddy/elastic-bootstrap.json');nc=Path('/etc/bondbuddy/elastic-node.json')
before=regular(bc);b=json.loads(before);nodebefore=regular(nc);n=json.loads(nodebefore)
a=Path(b['adapter_path']);assert str(a).startswith('/opt/bondbuddy/') and a.name=='node-adapter.mjs'
parent=a.parent
for d in [parent,*parent.parents]:
 s=d.lstat();assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and s.st_mode&0o022==0
actual=regular(a)
assert h(actual)==b['adapter_sha256'] and h(actual) in ['a09b07af13014a9b45bfa35209a5ad7262b4985590df087c985d6bce3e5e1c65','ce6d04c3fc8bba9cfe710a5006cfb8eb2b91447a1623e6d442041be9bbb8e248','432e7a88730d65c3497b9f027a5f49d240d53491bbe43e5071445f8d078e228b',p['files']['node-adapter.mjs']['sha256']]
running=subprocess.run(['/usr/bin/docker','ps','--filter','label=com.docker.compose.project=bondbuddy-execution','--format','{{.ID}}'],capture_output=True,text=True,check=True,timeout=10)
assert not running.stdout.strip(), 'Drain and stop execution services before updating their launch boundary.'
for service in ['authoring','review']:
 status=subprocess.run(['/usr/bin/systemctl','is-active','bondbuddy-task-cgroups-'+service+'.service'],capture_output=True,text=True,timeout=10)
 assert status.stdout.strip() in ['inactive','failed'], 'Drain and stop existing brokers before replacing their boundary.'
image=n['images']['authoring']
assert isinstance(image,str) and re.fullmatch(r'(sha256:[a-f0-9]{64}|[-A-Za-z0-9._/:]+@sha256:[a-f0-9]{64})',image)
container=subprocess.check_output(['/usr/bin/docker','create','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','/usr/bin/true',image],text=True,timeout=30).strip()
assert re.fullmatch(r'[a-f0-9]{64}',container)
try:
 with tempfile.TemporaryDirectory(prefix='bondbuddy-task-bootstrap-') as temporary:
  for name,item in [*p['files'].items(),('compose.yaml',p['compose'])]:
   target=Path(temporary)/name
   subprocess.run(['/usr/bin/docker','cp',container+':'+item['source'],str(target)],check=True,timeout=30)
   info=target.lstat();assert stat.S_ISREG(info.st_mode) and info.st_uid==0
   target.chmod(0o600);raw=regular(target);assert h(raw)==item['sha256']
   item['content']=raw.decode()
finally:
 subprocess.run(['/usr/bin/docker','rm',container],check=True,timeout=30)
cf=Path(n['compose_file']);oldcompose=regular(cf)
assert h(oldcompose)==n['compose_sha256'] and h(oldcompose) in ['3e383c3bc57b784acb6a9761e1b4fc53d6e4666f7b7221f4c6d761dd899da489','e2945a653787183d3f1f295580248116b8f5bc6fdc86e93427fa2469fdfaee2f','9f015499d74869af5e94c5b75233e0e339f6df97e70e9e1ecc2d88d54bfc14bd','3c604483ef133e97c6edd3b2b1b222490b269906129b9ec2debf98e677ec4ed4',p['compose']['sha256']]
wf=Path(n['apparmor_file']);oldprofile=regular(wf)
assert wf==cf.parent.parent/'m1'/'security'/'codex-apparmor.profile'
assert h(oldprofile)==n['apparmor_sha256'] and h(oldprofile) in ['db6feaad5ff0f5b538fe4f101ecd5f9395b3b083efe25ce436624c2947f450ae',p['files']['codex-apparmor.profile']['sha256']]
for f,raw in [(a,actual),(bc,before),(nc,nodebefore),(cf,oldcompose),(wf,oldprofile)]:backup(f,raw)
for name,item in p['files'].items():
 raw=item['content'].encode();assert h(raw)==item['sha256']
 f=wf if name=='codex-apparmor.profile' else parent/name
 if f.exists():backup(f,regular(f))
 save(f,raw)
raw=p['compose']['content'].encode();assert h(raw)==p['compose']['sha256'];save(cf,raw)
n['apparmor_sha256']=p['files']['codex-apparmor.profile']['sha256']
if p.get('pin'):
 ep=p['egress_patch'];ef=parent/'private-egress.mjs';eb=regular(ef)
 if h(eb)!=ep['after_sha256']:
  assert h(eb)==ep['before_sha256']
  updated=eb.decode().replace('export function renderPrivateTransportConfig',ep['addition']+'export function renderPrivateTransportConfig').replace('proxy.remote_port,proxy.sni);','proxy.remote_port,proxy.sni)+INTEGRITY_TRANSPORT_SECTION;').encode()
  assert h(updated)==ep['after_sha256'];backup(ef,eb);save(ef,updated)
 sf=cf.parent.parent/'m1'/'security'/'integrity-browser-seccomp.json'
 oldsf=Path(n['seccomp_file']);assert oldsf.parent==sf.parent and oldsf.name in ['codex-seccomp.json',sf.name]
 assert h(regular(oldsf))==n['seccomp_sha256']
 generic=regular(sf.parent/'codex-seccomp.json');assert h(generic)==p['generic_profile_sha256']
 profile=json.loads(generic);profile['syscalls'].append(p['integrity_rule'])
 sfraw=(json.dumps(profile,indent=2)+'\\n').encode();assert h(sfraw)==p['integrity_profile_sha256']
 if sf.exists():assert regular(sf)==sfraw
 else:save(sf,sfraw)
 n['seccomp_file']=str(sf);n['seccomp_sha256']=h(sfraw)
 pg=n['private_pg'];tf=Path(pg['config_file']);transport=regular(tf)
 assert h(transport)==pg['config_sha256'] and str(tf).startswith('/etc/bondbuddy/')
 extra=p['integrity_section'].encode()
 if b'[execution-integrity]' not in transport:
  backup(tf,transport);transport+=extra;save(tf,transport)
 else:assert transport.endswith(extra)
 pg['config_sha256']=h(transport)
 n['business_overlay_sha256']=p['pin']
n['compose_sha256']=p['compose']['sha256'];b['adapter_sha256']=p['files']['node-adapter.mjs']['sha256']
assert regular(nc)==nodebefore and regular(bc)==before
save(nc,json.dumps(n,separators=(',',':')).encode());save(bc,json.dumps(b,separators=(',',':')).encode())
BB_BUSINESS_CODE
`;
}


/** Keep the same public Python installer and file bytes inside one bounded
 * Brotli stream. /usr/bin/node is already required by the image bootstrap unit. */
export function encodeBootstrap85(bytes) {
  const alphabet='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_\x60{|}~';
  let output='';
  for(let offset=0;offset<bytes.length;offset+=4) {
    const count=Math.min(4,bytes.length-offset);
    let value=0;for(let i=0;i<4;i++)value=value*256+(i<count?bytes[offset+i]:0);
    let block='';for(let i=0;i<5;i++){block=alphabet[value%85]+block;value=Math.floor(value/85);}
    output+=block.slice(0,count+1);
  }
  return output;
}

function compactBusinessBootstrap(script) {
  if(!script)return '';
  const prefix="python3 - <<'BB_BUSINESS_CODE'\n", suffix='BB_BUSINESS_CODE\n';
  requireThat(script.startsWith(prefix)&&script.endsWith(suffix),'BUSINESS_BOOTSTRAP_ENCODING');
  const program=script.slice(prefix.length,-suffix.length);
  const line=/^p=json\.loads\(gzip\.decompress\(base64\.b64decode\('([A-Za-z0-9+/=]+)'\)\)\)$/m;
  const match=program.match(line);requireThat(match,'BUSINESS_BOOTSTRAP_ENCODING');
  const payload=gunzipSync(Buffer.from(match[1],'base64'),{maxOutputLength:131072}).toString('utf8');
  requireThat(!payload.includes("'''"),'BUSINESS_BOOTSTRAP_ENCODING');
  const decoded=program.replace(line,()=>`p=json.loads(r'''${payload}''')`);
  requireThat(Buffer.byteLength(decoded)<=131072,'BUSINESS_BOOTSTRAP_ENCODING');
  const encoded=encodeBootstrap85(brotliCompressSync(decoded,{params:{[zlibConstants.BROTLI_PARAM_QUALITY]:11}}));
  const decoder='import {brotliDecompressSync} from "node:zlib";const chunks=[];for await(const b of process.stdin)chunks.push(b);process.stdout.write(brotliDecompressSync(Buffer.concat(chunks),{maxOutputLength:131072}));';
  return `${prefix}import base64,subprocess\nexec(compile(subprocess.run(['/usr/bin/node','--input-type=module','-e',${JSON.stringify(decoder)}],input=base64.b85decode('${encoded}'),stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=30).stdout,'bondbuddy-public-business-bootstrap','exec'))\n${suffix}`;
}

/** Public cloud-init only. All credentials are issued later to a role-bound node. */
export function bootstrapUserData(config, request, slot=0) {
  const manifest = {version: 'execution-bootstrap-v1', pool_tag: config.pool_tag,
    account_id:request.account_id,region:request.region,
    source_sha256: request.source_sha256, image_sha256: request.image_sha256,
    services: request.services};
  requireThat(request.services?.length >= 1 && request.services.length <= 2 &&
    request.services.every(s => ['authoring', 'review'].includes(s.service_id)), 'SERVICE_MANIFEST');
  requireThat(Number.isInteger(slot)&&slot>=0&&slot<2&&config.role_names?.length===2,'BOOTSTRAP_ROLE_SLOT');
  const descriptor=config.node_secrets?.[slot];
  requireThat(descriptor?.role_name===config.role_names[slot]&&/^\d{1,20}$/.test(descriptor.role_id??'')&&
    /^[A-Za-z0-9_-]{1,128}$/.test(descriptor.secret_name??''),'BOOTSTRAP_SLOT_BINDING');
  manifest.slot_binding={role_name:descriptor.role_name,role_id:descriptor.role_id,secret_name:descriptor.secret_name};
  const publicJson = canonical(manifest);
  requireThat(!/[\r\n']/.test(publicJson), 'PUBLIC_MANIFEST_ENCODING');
  // The reviewed image must already contain Docker, Node and this oneshot unit.
  // No personal SSH key, provider token, PG password or enrollment token here.
  return `#!/bin/sh\nset -eu\numask 077\ninstall -d -m 700 /etc/bondbuddy\nprintf '%s' '${publicJson}' > /etc/bondbuddy/elastic-public.json\n${compactBusinessBootstrap(businessBootstrap(config))}systemctl start bondbuddy-execution-bootstrap.service\n`;
}

/** Reproduce an existing instance's exact public creation bytes after a code update.
 * Pins are operator-owned and tied to the original immutable launch manifest. */
export function warmBootstrapUserData(config, request, slot, instanceId) {
  const pins=config.retained_warm_bootstraps??[];
  const keys=['instance_id','launch_manifest_sha256','user_data_sha256','user_data_base64'];
  requireThat(Array.isArray(pins)&&pins.length<=2&&new Set(pins.map(p=>p?.instance_id)).size===pins.length&&
    pins.every(p=>p&&Object.keys(p).length===keys.length&&Object.keys(p).every(k=>keys.includes(k))&&
      /^ins-[a-z0-9]+$/.test(p.instance_id??'')&&/^[a-f0-9]{64}$/.test(p.launch_manifest_sha256??'')&&
      /^[a-f0-9]{64}$/.test(p.user_data_sha256??'')&&typeof p.user_data_base64==='string'&&p.user_data_base64.length<=40000), 'WARM_BOOTSTRAP_PINS');
  const pin=pins.find(p=>p.instance_id===instanceId);
  if(!pin)return bootstrapUserData(config,request,slot);
  const bytes=Buffer.from(pin.user_data_base64,'base64');
  requireThat(pin.launch_manifest_sha256===request.launch_manifest_sha256&&bytes.toString('base64')===pin.user_data_base64&&
    sha256(bytes)===pin.user_data_sha256&&bytes.toString().startsWith('#!/bin/sh\n'), 'WARM_BOOTSTRAP_BINDING');
  return bytes.toString();
}

async function boundedJson(response) {
  requireThat(response.ok, 'BOOTSTRAP_HTTP');
  let size = 0; const chunks = [];
  for await (const b of response.body) { size += b.length; requireThat(size <= 65536, 'BOOTSTRAP_RESPONSE_BOUND'); chunks.push(b); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
/** IMDS role credentials are temporary API access, not proof of business identity. */
export async function readRoleCredentials(roleName, {fetchImpl = fetch, now = Date.now} = {}) {
  requireThat(/^[A-Za-z0-9_-]{1,60}$/.test(roleName), 'ROLE_NAME');
  const r = await fetchImpl(`http://metadata.tencentyun.com/latest/meta-data/cam/security-credentials/${roleName}`,
    {redirect: 'error', signal: AbortSignal.timeout(5000)});
  const data = await boundedJson(r), expiresAt = Number(data.ExpiredTime) * 1000;
  requireThat(data.TmpSecretId && data.TmpSecretKey && data.Token && expiresAt > now() + 60000, 'ROLE_CREDENTIAL_EXPIRED');
  return {secretId: data.TmpSecretId, secretKey: data.TmpSecretKey, token: data.Token, expiresAt};
}

/** The broker hook uses the node-specific role to read only that node's short
 * enrollment secret. That secret is pre-bound in PG after an exact Describe.
 * Metadata is merely an extra consistency check; never sufficient admission. */
export async function bootstrapNode({publicManifest, metadata, broker, runtime, writeEnvelope, now = Date.now, diagnostics}) {
  diagnostics?.stage('binding');
  requireThat(publicManifest.version === 'execution-bootstrap-v1', 'BOOTSTRAP_VERSION');
  diagnostics?.stage('enrollment');
  let enrollment;
  try { enrollment = await broker.enroll(metadata); }
  catch (error) {
    // The broker performs read-only calls. Only explicit waiting before any
    // runtime/transport/artifact side effect may restart the systemd entry.
    if (['NODE_ENROLLMENT_PENDING','NODE_ENROLLMENT_DEADLINE'].includes(error.message))
      error.bootstrapRetrySafe = true;
    throw error;
  }
  diagnostics?.stage('binding');
  requireThat(enrollment.verified === true && enrollment.expires_at > now() + 60000 &&
    /^\d{1,20}$/.test(enrollment.identity.account_id) && enrollment.identity.account_id === metadata.account_id &&
    /^[a-f0-9-]{36}$/.test(enrollment.identity.epoch) && /^[a-f0-9]{64}$/.test(enrollment.launch_manifest_sha256) &&
    enrollment.identity.instance_id === metadata.instance_id && enrollment.identity.region === metadata.region &&
    enrollment.source_sha256 === publicManifest.source_sha256 && enrollment.image_sha256 === publicManifest.image_sha256 &&
    canonical(enrollment.services) === canonical(publicManifest.services), 'ENROLLMENT_BINDING');
  requireThat(publicManifest.account_id===enrollment.identity.account_id && publicManifest.region===enrollment.identity.region,'PUBLIC_NODE_SCOPE');
  requireThat(enrollment.registration_token && enrollment.operation_completed === true, 'ENROLLMENT_UNPROVEN');
  diagnostics?.stage('artifact_verification');
  await runtime.verifyArtifacts(enrollment); // immutable image/source/sandbox/PG/Blob before any claim
  const contexts = [];
  try {
    for (const service of enrollment.services) {
      diagnostics?.stage('service_envelope',service.service_id);
      const context = {identity: enrollment.identity, session_id: randomUUID()};
      const path = await writeEnvelope(service.service_id, {context, service_id: service.service_id,
        source_sha256: enrollment.source_sha256, image_sha256: enrollment.image_sha256,
        launch_manifest_sha256: enrollment.launch_manifest_sha256, registration_token: enrollment.registration_token});
      diagnostics?.stage('service_start',service.service_id);
      contexts.push(await runtime.startService(service, path));
    }
    diagnostics?.stage('ready_verification');
    await runtime.verifyAllReady(contexts); // PG expected-services gate, not a local claimed ready flag
    return {identity: enrollment.identity, services: enrollment.services.map(s => s.service_id)};
  } catch (error) {
    await diagnostics?.capture(error,runtime.failureContainers);
    diagnostics?.stage('failure_cleanup');
    await runtime.disableClaims(contexts); // preserve leases/results and uncertainty; no TTL cleanup
    throw new Error('BOOTSTRAP_NOT_READY', {cause: error});
  }
}

export async function writePrivateEnvelope(directory, service, data) {
  requireThat(['authoring', 'review'].includes(service), 'SERVICE_ID');
  const tmp = `${directory}/.${service}-${randomUUID()}`, target = `${directory}/${service}.json`;
  let f;
  try {
    f = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await f.writeFile(canonical(data)); await f.sync(); await f.close(); f = null;
    await rename(tmp, target);
    return target;
  } finally { if (f) await f.close(); await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
