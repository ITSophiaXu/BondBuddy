import {readFileSync} from 'node:fs';
import {gzipSync, gunzipSync, brotliCompressSync, constants as zlibConstants} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {open, rename, unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {canonical, requireThat, sha256} from './policy.mjs';
import {INTEGRITY_TRANSPORT_SECTION} from './private-egress.mjs';

/** Install only public, pinned code. Private Blob capability arrives after enrollment. */
function businessBootstrap(config) {
  if(!config.business_overlay_sha256)return '';
  requireThat(/^[a-f0-9]{64}$/.test(config.business_overlay_sha256),'BUSINESS_OVERLAY_PIN');
  const files=Object.fromEntries(['node-adapter.mjs','business-overlay.mjs','authoring-workspace.mjs'].map(name=>{
    const bytes=readFileSync(new URL(name,import.meta.url));
    return [name,{content:bytes.toString('utf8'),sha256:sha256(bytes)}];
  }));
  const compose=readFileSync(new URL('compose.yaml',import.meta.url));
  const integrityProfile=readFileSync(new URL('../m1/security/integrity-browser-seccomp.json',import.meta.url));
  const genericProfile=readFileSync(new URL('../m1/security/codex-seccomp.json',import.meta.url));
  const egress=readFileSync(new URL('private-egress.mjs',import.meta.url),'utf8');
  const addition=egress.match(/\/\/ Separate from the model proxy[^\n]*\nexport const INTEGRITY_TRANSPORT_SECTION=[^\n]*\n/)[0];
  const before=egress.replace(addition,'').replace('+INTEGRITY_TRANSPORT_SECTION;',';');
  const egressPatch={before_sha256:sha256(before),after_sha256:sha256(egress),addition};
  const integrityRule=JSON.parse(integrityProfile).syscalls.at(-1);
  const payload=gzipSync(JSON.stringify({egress_patch:egressPatch,generic_profile_sha256:sha256(genericProfile),integrity_profile_sha256:sha256(integrityProfile),integrity_rule:integrityRule,integrity_section:INTEGRITY_TRANSPORT_SECTION,pin:config.business_overlay_sha256,files,compose:{content:compose.toString('utf8'),sha256:sha256(compose)}}),{level:9,mtime:0}).toString('base64');
  return `python3 - <<'BB_BUSINESS_CODE'\nimport os,json,gzip,base64,hashlib,stat\nfrom pathlib import Path\nassert os.geteuid()==0\np=json.loads(gzip.decompress(base64.b64decode('${payload}')))\nh=lambda b:hashlib.sha256(b).hexdigest()\ndef regular(f):\n s=f.lstat();assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_mode&0o022==0;return f.read_bytes()\ndef save(f,b):\n t=f.with_name(f.name+'.business-install');fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\n with os.fdopen(fd,'wb') as o:o.write(b);o.flush();os.fsync(o.fileno())\n os.replace(t,f)\nbc=Path('/etc/bondbuddy/elastic-bootstrap.json');nc=Path('/etc/bondbuddy/elastic-node.json')\nbefore=regular(bc);b=json.loads(before);nodebefore=regular(nc);n=json.loads(nodebefore)\na=Path(b['adapter_path']);assert str(a).startswith('/opt/bondbuddy/') and a.name=='node-adapter.mjs'\nparent=a.parent\nfor d in [parent,*parent.parents]:\n s=d.lstat();assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and s.st_mode&0o022==0\nactual=regular(a);assert h(actual)==b['adapter_sha256'] and h(actual) in ['a09b07af13014a9b45bfa35209a5ad7262b4985590df087c985d6bce3e5e1c65','ce6d04c3fc8bba9cfe710a5006cfb8eb2b91447a1623e6d442041be9bbb8e248','432e7a88730d65c3497b9f027a5f49d240d53491bbe43e5071445f8d078e228b',p['files']['node-adapter.mjs']['sha256']]\nfor f,v in [(a,actual),(bc,before),(nc,nodebefore)]:\n backup=f.with_name(f.name+'.before-integrity1477')\n if not backup.exists():\n  fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\n  with os.fdopen(fd,'wb') as o:o.write(v);o.flush();os.fsync(o.fileno())\nfor name,item in p['files'].items():\n raw=item['content'].encode();assert h(raw)==item['sha256'];f=parent/name\n if f.exists():\n  prior=regular(f);backup=f.with_name(f.name+'.before-integrity1477')\n  if not backup.exists():\n   fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\n   with os.fdopen(fd,'wb') as o:o.write(prior);o.flush();os.fsync(o.fileno())\n save(f,raw)\ncf=Path(n['compose_file']);oldcompose=regular(cf)\nassert h(oldcompose)==n['compose_sha256'] and h(oldcompose) in ['3e383c3bc57b784acb6a9761e1b4fc53d6e4666f7b7221f4c6d761dd899da489','e2945a653787183d3f1f295580248116b8f5bc6fdc86e93427fa2469fdfaee2f','9f015499d74869af5e94c5b75233e0e339f6df97e70e9e1ecc2d88d54bfc14bd','3c604483ef133e97c6edd3b2b1b222490b269906129b9ec2debf98e677ec4ed4',p['compose']['sha256']]\ncb=cf.with_name(cf.name+'.before-integrity1477')\nif not cb.exists():\n fd=os.open(cb,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\n with os.fdopen(fd,'wb') as o:o.write(oldcompose);o.flush();os.fsync(o.fileno())\nraw=p['compose']['content'].encode();assert h(raw)==p['compose']['sha256'];save(cf,raw)\nep=p['egress_patch'];ef=parent/'private-egress.mjs';eb=regular(ef)\nif h(eb)!=ep['after_sha256']:\n assert h(eb)==ep['before_sha256']\n updated=eb.decode().replace('export function renderPrivateTransportConfig',ep['addition']+'export function renderPrivateTransportConfig').replace('proxy.remote_port,proxy.sni);','proxy.remote_port,proxy.sni)+INTEGRITY_TRANSPORT_SECTION;').encode()\n assert h(updated)==ep['after_sha256'];save(ef,updated)\n# Restore the browser deployment contract for both fresh and retained nodes.\nsf=cf.parent.parent/'m1'/'security'/'integrity-browser-seccomp.json'\noldsf=Path(n['seccomp_file']);assert oldsf.parent==sf.parent and oldsf.name in ['codex-seccomp.json',sf.name]\nassert h(regular(oldsf))==n['seccomp_sha256']\ngeneric=regular(sf.parent/'codex-seccomp.json');assert h(generic)==p['generic_profile_sha256']\nprofile=json.loads(generic);profile['syscalls'].append(p['integrity_rule'])\nsfraw=(json.dumps(profile,indent=2)+'\\n').encode();assert h(sfraw)==p['integrity_profile_sha256']\nif sf.exists():assert regular(sf)==sfraw\nelse:save(sf,sfraw)\nn['seccomp_file']=str(sf);n['seccomp_sha256']=h(sfraw)\npg=n['private_pg'];tf=Path(pg['config_file']);transport=regular(tf)\nassert h(transport)==pg['config_sha256'] and str(tf).startswith('/etc/bondbuddy/')\nextra=p['integrity_section'].encode()\nif b'[execution-integrity]' not in transport:\n backup=tf.with_name(tf.name+'.before-integrity1477')\n if not backup.exists():\n  fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\n  with os.fdopen(fd,'wb') as o:o.write(transport);o.flush();os.fsync(o.fileno())\n transport+=extra;save(tf,transport)\nelse:assert transport.endswith(extra)\npg['config_sha256']=h(transport)\nn['compose_sha256']=p['compose']['sha256']\nn['business_overlay_sha256']=p['pin'];b['adapter_sha256']=p['files']['node-adapter.mjs']['sha256']\nassert regular(nc)==nodebefore and regular(bc)==before\nsave(nc,json.dumps(n,separators=(',',':')).encode());save(bc,json.dumps(b,separators=(',',':')).encode())\nBB_BUSINESS_CODE\n`;
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

function compactBusinessBootstrap(script, publicJson) {
  if(!script)return '';
  const prefix="python3 - <<'BB_BUSINESS_CODE'\n", suffix='BB_BUSINESS_CODE\n';
  requireThat(script.startsWith(prefix)&&script.endsWith(suffix),'BUSINESS_BOOTSTRAP_ENCODING');
  const program=script.slice(prefix.length,-suffix.length);
  const line=/^p=json\.loads\(gzip\.decompress\(base64\.b64decode\('([A-Za-z0-9+/=]+)'\)\)\)$/m;
  const match=program.match(line);requireThat(match,'BUSINESS_BOOTSTRAP_ENCODING');
  const payload=gunzipSync(Buffer.from(match[1],'base64'),{maxOutputLength:131072}).toString('utf8');
  requireThat(!payload.includes("'''"),'BUSINESS_BOOTSTRAP_ENCODING');
  // Keep the public manifest in the same compression stream as the installer.
  // Its repeated hashes and keys otherwise consume the cloud's 16 KiB limit.
  const setup=`import subprocess\nsubprocess.run(['install','-d','-m','700','/etc/bondbuddy'],check=True)\nfrom pathlib import Path\nPath('/etc/bondbuddy/elastic-public.json').write_bytes(${JSON.stringify(publicJson)}.encode())\n`;
  const decoded=setup+program.replace(line,()=>`p=json.loads(r'''${payload}''')`)+
    "subprocess.run(['systemctl','start','bondbuddy-execution-bootstrap.service'],check=True)\n";
  requireThat(Buffer.byteLength(decoded)<=131072,'BUSINESS_BOOTSTRAP_ENCODING');
  const encoded=encodeBootstrap85(brotliCompressSync(decoded,{params:{[zlibConstants.BROTLI_PARAM_QUALITY]:11}}));
  const decoder="process.stdout.write(require('zlib').brotliDecompressSync(require('fs').readFileSync(0),{maxOutputLength:131072}))";
  return `${prefix}import base64,subprocess\nexec(subprocess.check_output(['/usr/bin/node','-e',${JSON.stringify(decoder)}],input=base64.b85decode('${encoded}'),timeout=30))\n${suffix}`;
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
  if(config.business_overlay_sha256)return `#!/bin/sh\nset -eu\numask 077\n${compactBusinessBootstrap(businessBootstrap(config),publicJson)}`;
  return `#!/bin/sh\nset -eu\numask 077\ninstall -d -m 700 /etc/bondbuddy\nprintf '%s' '${publicJson}' > /etc/bondbuddy/elastic-public.json\nsystemctl start bondbuddy-execution-bootstrap.service\n`;
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
