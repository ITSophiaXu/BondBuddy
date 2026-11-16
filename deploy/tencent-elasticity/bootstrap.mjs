import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {open, rename, unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {canonical, requireThat, sha256} from './policy.mjs';

/** Install only public, pinned code. Private Blob capability arrives after enrollment. */
function businessBootstrap(config) {
  if(!config.business_overlay_sha256)return '';
  requireThat(/^[a-f0-9]{64}$/.test(config.business_overlay_sha256),'BUSINESS_OVERLAY_PIN');
  const files=Object.fromEntries(['node-adapter.mjs','business-overlay.mjs'].map(name=>{
    const bytes=readFileSync(new URL(name,import.meta.url));
    return [name,{content:bytes.toString('utf8'),sha256:sha256(bytes)}];
  }));
  const payload=gzipSync(JSON.stringify({pin:config.business_overlay_sha256,files}),{level:9,mtime:0}).toString('base64');
  return `python3 - <<'BB_BUSINESS_CODE'\nimport os,json,gzip,base64,hashlib,stat\nfrom pathlib import Path\nassert os.geteuid()==0\np=json.loads(gzip.decompress(base64.b64decode('${payload}')))\nh=lambda b:hashlib.sha256(b).hexdigest()\ndef regular(f):\n s=f.lstat();assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_mode&0o022==0;return f.read_bytes()\ndef save(f,b):\n t=f.with_name(f.name+'.business-install');fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\n with os.fdopen(fd,'wb') as o:o.write(b);o.flush();os.fsync(o.fileno())\n os.replace(t,f)\nbc=Path('/etc/bondbuddy/elastic-bootstrap.json');nc=Path('/etc/bondbuddy/elastic-node.json')\nbefore=regular(bc);b=json.loads(before);nodebefore=regular(nc);n=json.loads(nodebefore)\na=Path(b['adapter_path']);assert str(a).startswith('/opt/bondbuddy/') and a.name=='node-adapter.mjs'\nparent=a.parent\nfor d in [parent,*parent.parents]:\n s=d.lstat();assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and s.st_mode&0o022==0\nactual=regular(a);assert h(actual)==b['adapter_sha256'] and h(actual) in ['a09b07af13014a9b45bfa35209a5ad7262b4985590df087c985d6bce3e5e1c65',p['files']['node-adapter.mjs']['sha256']]\nfor f,v in [(a,actual),(bc,before),(nc,nodebefore)]:\n backup=f.with_name(f.name+'.before-shared-business-four')\n if not backup.exists():\n  fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\n  with os.fdopen(fd,'wb') as o:o.write(v);o.flush();os.fsync(o.fileno())\nfor name,item in p['files'].items():\n raw=item['content'].encode();assert h(raw)==item['sha256'];f=parent/name\n if f.exists():regular(f)\n save(f,raw)\nn['business_overlay_sha256']=p['pin'];b['adapter_sha256']=p['files']['node-adapter.mjs']['sha256']\nassert regular(nc)==nodebefore and regular(bc)==before\nsave(nc,json.dumps(n,separators=(',',':')).encode());save(bc,json.dumps(b,separators=(',',':')).encode())\nBB_BUSINESS_CODE\n`;
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
  return `#!/bin/sh\nset -eu\numask 077\ninstall -d -m 700 /etc/bondbuddy\nprintf '%s' '${publicJson}' > /etc/bondbuddy/elastic-public.json\n${businessBootstrap(config)}systemctl start bondbuddy-execution-bootstrap.service\n`;
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
  const enrollment = await broker.enroll(metadata);
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
