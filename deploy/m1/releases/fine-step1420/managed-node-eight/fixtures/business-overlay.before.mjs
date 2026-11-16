import {readFile, mkdir, lstat, open, rename, chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {join, dirname} from 'node:path';
import {requireThat, sha256} from './policy.mjs';

const ROOT = '/opt/bondbuddy/business-overlays';
const forbidden = new Set(['runtime.js','queue.js','codex-adapter.js','model-call-budget.js','durable-probe-journal.js']);
const eightRuntime = new Set(['apps/worker/dist/runtime.js','apps/worker/dist/model-call-budget.js']);
const safePath = (path, eight=false) => typeof path === 'string' &&
  /^(?:apps\/(?:api|worker)|packages\/contracts)\/dist\/[a-z][a-z0-9-]*\.js$/.test(path) &&
  (!forbidden.has(path.split('/').at(-1)) || eight && eightRuntime.has(path));

export function validateBusinessOverlay(value, pin) {
  const eight=value?.version==='shared-business-eight-v1', count=eight?25:19;
  requireThat((eight || value?.version === 'shared-business-four-v1') && value.sha256 === pin && /^[a-f0-9]{64}$/.test(pin) &&
    Number.isInteger(value.bytes) && value.bytes > 0 && value.bytes <= 262144 &&
    Array.isArray(value.files) && value.files.length === count && new Set(value.files.map(f=>f.path)).size === count &&
    value.files.every(f=>safePath(f.path,eight) && /^[a-f0-9]{64}$/.test(f.sha256) &&
      Number.isInteger(f.bytes) && f.bytes > 0 && f.bytes <= 262144), 'BUSINESS_OVERLAY_SCOPE');
  // The bearer URL travels only inside the existing role-bound private envelope.
  let url; try { url = new URL(value.url); } catch { throw Error('BUSINESS_OVERLAY_URL'); }
  requireThat(url.protocol === 'https:' && /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) &&
    url.pathname.startsWith('/bondbuddy-private/') && !url.username && !url.password && !url.hash &&
    url.searchParams.get('sp') === 'r' && url.searchParams.get('sr') === 'b' &&
    Date.parse(url.searchParams.get('se')) > Date.now() + 60000, 'BUSINESS_OVERLAY_URL');
}

/** Read only regular USTAR members; never let tar create links or arbitrary paths. */
export function businessOverlayFiles(archive, descriptor) {
  requireThat(archive.length === descriptor.bytes && sha256(archive) === descriptor.sha256, 'BUSINESS_OVERLAY_ARCHIVE');
  const tar = gunzipSync(archive, {maxOutputLength: 2097152}), result = new Map();
  const eight=descriptor.version==='shared-business-eight-v1';
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512); offset += 512;
    if(h.every(b=>b===0))break;
    const string = (start,end) => h.subarray(start,end).toString().split('\0')[0];
    const path = string(0,100), sizeText = string(124,136).trim();
    requireThat(!string(345,500) && /^[0-7]+$/.test(sizeText) && (h[156]===0 || h[156]===48), 'BUSINESS_OVERLAY_MEMBER');
    const size = parseInt(sizeText,8);
    requireThat(size <= 262144 && offset + size <= tar.length && !result.has(path), 'BUSINESS_OVERLAY_MEMBER');
    requireThat(safePath(path,eight) || /^db\/migrations\/018(?:0_batch_four_way|6_shared_batch_capacity)\.sql$/.test(path) || eight && path==='db/migrations/0188_execution_node_eight_capacity.sql', 'BUSINESS_OVERLAY_PATH');
    result.set(path, Buffer.from(tar.subarray(offset,offset+size))); offset += Math.ceil(size/512)*512;
  }
  requireThat(result.size === (eight?28:21) && descriptor.files.every(f=>result.get(f.path)?.length === f.bytes &&
    sha256(result.get(f.path))===f.sha256), 'BUSINESS_OVERLAY_FILES');
  return new Map(descriptor.files.map(f=>[f.path,result.get(f.path)]));
}

export function businessOverlayCompose(base, directory, files) {
  const boundary = base.indexOf('\n  review:');
  requireThat(base.startsWith('# Standalone execution nodes only:') && boundary > 0, 'BUSINESS_OVERLAY_COMPOSE');
  const authoring = base.slice(0,boundary), marker = '    volumes:\n';
  requireThat(authoring.split(marker).length===2, 'BUSINESS_OVERLAY_COMPOSE');
  const mounts = files.map(f=>`      - ${directory}/${f.path}:/app/${f.path}:ro\n`).join('');
  const common=new Set(['apps/worker/dist/runtime.js','apps/worker/dist/model-call-budget.js','apps/api/dist/execution-capacity.js',
    'apps/api/dist/batch-admission.js','packages/contracts/dist/workpaper-entry.js',
    'packages/contracts/dist/execution-capacity.js','packages/contracts/dist/index.js','packages/contracts/dist/workpaper-progressive.js']);
  const reviewMounts=files.filter(f=>common.has(f.path)).map(f=>`      - ${directory}/${f.path}:/app/${f.path}:ro\n`).join('');
  const review=base.slice(boundary);
  requireThat(review.split(marker).length===2,'BUSINESS_OVERLAY_COMPOSE');
  // The legacy descriptor never changes review; the eight-slot revision binds its common runtime closure.
  return authoring.replace(marker,marker+mounts)+(files.some(f=>f.path==='apps/worker/dist/runtime.js')?review.replace(marker,marker+reviewMounts):review);
}

async function directory(path) {
  const parent = dirname(path); if(parent !== '/opt')await directory(parent);
  let created=false;
  try {await mkdir(path,{mode:0o755});created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
  if(created)await chmod(path,0o755); // systemd/cloud-init commonly use umask 0077.
  const st=await lstat(path);
  requireThat(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===0&&(st.mode&0o777)===0o755,'BUSINESS_OVERLAY_DIRECTORY');
}
async function file(path, expected) {
  const st=await lstat(path);
  requireThat(st.isFile()&&!st.isSymbolicLink()&&st.uid===0&&(st.mode&0o777)===0o644&&st.size===expected.bytes&&
    sha256(await readFile(path))===expected.sha256,'BUSINESS_OVERLAY_INSTALLED');
}
async function write(path, bytes) {
  const f=await open(path, constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);
  try {await f.chmod(0o644);await f.writeFile(bytes);await f.sync();} finally {await f.close();}
}
export async function installBusinessOverlay(descriptor, config, {fetchImpl=fetch}={}) {
  if(!config.business_overlay_sha256)return null;
  requireThat(process.getuid()===0,'BUSINESS_OVERLAY_ROOT');
  validateBusinessOverlay(descriptor,config.business_overlay_sha256);
  const base=await readFile(config.compose_file,'utf8');
  requireThat(sha256(base)===config.compose_sha256,'NODE_COMPOSE_CHANGED');
  await directory(ROOT);
  const target=join(ROOT,descriptor.sha256), compose=businessOverlayCompose(base,target,descriptor.files);
  // Keep the original Compose directory so relative seccomp/profile paths retain their meaning.
  const composeFile=join(dirname(config.compose_file),`compose.business-${descriptor.sha256}.yaml`);
  let installed=false;
  try {await lstat(target);installed=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!installed){
    let archive;
    try {
      const response=await fetchImpl(descriptor.url,{redirect:'error',signal:AbortSignal.timeout(30000)});
      requireThat(response.ok,'BUSINESS_OVERLAY_FETCH');
      const chunks=[];let size=0;
      for await(const b of response.body){size+=b.length;requireThat(size<=descriptor.bytes,'BUSINESS_OVERLAY_FETCH');chunks.push(b);}
      archive=Buffer.concat(chunks);
    } catch {throw Error('BUSINESS_OVERLAY_FETCH');} // URL never enters errors or process argv.
    const files=businessOverlayFiles(archive,descriptor), stage=join(ROOT,`.${randomUUID()}`);
    await directory(stage);
    for(const [path,bytes] of files){await directory(dirname(join(stage,path)));await write(join(stage,path),bytes);}
    await rename(stage,target);
    const f=await open(ROOT,constants.O_RDONLY|constants.O_DIRECTORY);try{await f.sync();}finally{await f.close();}
  }
  await directory(target);
  for(const entry of descriptor.files)await file(join(target,entry.path),entry);
  try {await lstat(composeFile);}catch(e){if(e.code!=='ENOENT')throw e;await write(composeFile,Buffer.from(compose));}
  await file(composeFile,{bytes:Buffer.byteLength(compose),sha256:sha256(compose)});
  return {compose_file:composeFile,compose_sha256:sha256(compose)};
}
