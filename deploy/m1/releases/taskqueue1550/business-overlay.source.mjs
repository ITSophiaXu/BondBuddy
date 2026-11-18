import {readFile, mkdir, lstat, open, rename, chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {join, dirname} from 'node:path';
import {requireThat, sha256} from './policy.mjs';

const ROOT = '/opt/bondbuddy/business-overlays';
const forbidden = new Set(['runtime.js','queue.js','codex-adapter.js','model-call-budget.js','durable-probe-journal.js']);
const eightRuntime = new Set(['apps/worker/dist/runtime.js','apps/worker/dist/model-call-budget.js']);
const recoveryVersion='shared-business-eight-recovery-v1';
const recoveryRuntime=new Set(['apps/api/dist/queue.js']);
const safePath = (path, eight=false,recovery=false) => typeof path === 'string' &&
  /^(?:apps\/(?:api|worker)|packages\/contracts)\/dist\/[a-z][a-z0-9-]*\.js$/.test(path) &&
  (!forbidden.has(path.split('/').at(-1)) || eight && eightRuntime.has(path) || recovery && recoveryRuntime.has(path));


const PERFORMANCE_VERSION = 'shared-business-eight-performance-v1';
const RECOVERY_PERFORMANCE_VERSION = 'shared-business-eight-performance-recovery-v1';
const PERMISSIONS_VERSION = 'shared-business-eight-permissions-v1';
const ENCRYPTED_VERSION = 'shared-business-eight-permissions-encrypted-v1';
const isPerformanceVersion = version => [TASK_QUEUE_VERSION,PERFORMANCE_VERSION, RECOVERY_PERFORMANCE_VERSION, PERMISSIONS_VERSION, ENCRYPTED_VERSION].includes(version);
const performancePaths = Object.freeze({"authoring":["apps/api/dist/batch-admission.js","apps/api/dist/data.js","apps/api/dist/execution-capacity.js","apps/api/dist/log-ops.js","apps/api/dist/m4-workspace.js","apps/api/dist/observability.js","apps/api/dist/performance-dispatch.js","apps/api/dist/performance-store.js","apps/api/dist/performance-trace.js","apps/api/dist/project-file-consistency.js","apps/api/dist/project-file-workspace.js","apps/api/dist/provider-results.js","apps/api/dist/queue.js","apps/api/dist/workpapers.js","apps/api/package.json","apps/worker/dist/bounded-items.js","apps/worker/dist/codex-adapter.js","apps/worker/dist/deferred-qa-journal.js","apps/worker/dist/file-authoring-repair.js","apps/worker/dist/file-authoring-stage.js","apps/worker/dist/historical-model-stage.js","apps/worker/dist/integrity-browser-boundary.js","apps/worker/dist/integrity-browser.js","apps/worker/dist/m4-document-stage.js","apps/worker/dist/m4-file-workspace.js","apps/worker/dist/model-call-budget.js","apps/worker/dist/model-performance.js","apps/worker/dist/performance-io.js","apps/worker/dist/project-file-tools.js","apps/worker/dist/project-qa-stage.js","apps/worker/dist/run-pipeline.js","apps/worker/dist/runtime.js","apps/worker/dist/unified-model-stage.js","apps/worker/dist/workpaper-progressive-groups.js","apps/worker/dist/workpaper-shared-stage.js","packages/contracts/dist/execution-capacity.js","packages/contracts/dist/index.js","packages/contracts/dist/performance.js","packages/contracts/dist/workpaper-entry.js","packages/contracts/dist/workpaper-progressive.js"],"review":["apps/api/dist/batch-admission.js","apps/api/dist/execution-capacity.js","apps/api/dist/performance-store.js","apps/api/dist/performance-trace.js","apps/api/dist/queue.js","apps/api/package.json","apps/worker/dist/codex-adapter.js","apps/worker/dist/file-authoring-repair.js","apps/worker/dist/file-authoring-stage.js","apps/worker/dist/historical-model-stage.js","apps/worker/dist/m4-file-workspace.js","apps/worker/dist/model-call-budget.js","apps/worker/dist/model-performance.js","apps/worker/dist/performance-io.js","apps/worker/dist/project-file-tools.js","apps/worker/dist/run-pipeline.js","apps/worker/dist/runtime.js","apps/worker/dist/unified-model-stage.js","packages/contracts/dist/execution-capacity.js","packages/contracts/dist/index.js","packages/contracts/dist/performance.js","packages/contracts/dist/workpaper-entry.js","packages/contracts/dist/workpaper-progressive.js"]});
const performanceSql = Object.freeze({"db/migrations/0180_batch_four_way.sql":{"bytes":10196,"sha256":"9529796afd9564dafb8f1a9fff5b792444b66b934838870430471f0d787b2caf"},"db/migrations/0186_shared_batch_capacity.sql":{"bytes":967,"sha256":"841e463b7f0b470be96b5e24ac3181445f95635068fcc6d437f3c9f50fb2539f"},"db/migrations/0188_execution_node_eight_capacity.sql":{"bytes":1605,"sha256":"c921711132ead5585a9976d6fb1343cec746b2fef55a60a2262f61be78f836a6"}});

const recoveryPerformancePaths = Object.freeze({"authoring":["apps/api/dist/batch-admission.js","apps/api/dist/data.js","apps/api/dist/execution-capacity.js","apps/api/dist/log-ops.js","apps/api/dist/m4-workspace.js","apps/api/dist/observability.js","apps/api/dist/performance-dispatch.js","apps/api/dist/performance-store.js","apps/api/dist/performance-trace.js","apps/api/dist/project-file-consistency.js","apps/api/dist/project-file-workspace.js","apps/api/dist/provider-results.js","apps/api/dist/queue.js","apps/api/dist/workpapers.js","apps/api/package.json","apps/worker/dist/bounded-items.js","apps/worker/dist/codex-adapter.js","apps/worker/dist/deferred-qa-journal.js","apps/worker/dist/execution-node-runtime.js","apps/worker/dist/file-authoring-repair.js","apps/worker/dist/file-authoring-stage.js","apps/worker/dist/historical-model-stage.js","apps/worker/dist/integrity-browser-boundary.js","apps/worker/dist/integrity-browser-stage.js","apps/worker/dist/integrity-browser.js","apps/worker/dist/m4-document-stage.js","apps/worker/dist/m4-file-workspace.js","apps/worker/dist/managed-run-retries.js","apps/worker/dist/model-call-budget.js","apps/worker/dist/model-performance.js","apps/worker/dist/performance-io.js","apps/worker/dist/project-file-tools.js","apps/worker/dist/project-qa-stage.js","apps/worker/dist/run-lease-heartbeat.js","apps/worker/dist/run-pipeline.js","apps/worker/dist/runtime.js","apps/worker/dist/unified-model-stage.js","apps/worker/dist/workpaper-progressive-groups.js","apps/worker/dist/workpaper-shared-stage.js","packages/contracts/dist/execution-capacity.js","packages/contracts/dist/index.js","packages/contracts/dist/performance.js","packages/contracts/dist/workpaper-entry.js","packages/contracts/dist/workpaper-progressive.js"],"review":["apps/api/dist/batch-admission.js","apps/api/dist/execution-capacity.js","apps/api/dist/performance-store.js","apps/api/dist/performance-trace.js","apps/api/dist/queue.js","apps/api/package.json","apps/worker/dist/codex-adapter.js","apps/worker/dist/execution-node-runtime.js","apps/worker/dist/file-authoring-repair.js","apps/worker/dist/file-authoring-stage.js","apps/worker/dist/historical-model-stage.js","apps/worker/dist/m4-file-workspace.js","apps/worker/dist/managed-run-retries.js","apps/worker/dist/model-call-budget.js","apps/worker/dist/model-performance.js","apps/worker/dist/performance-io.js","apps/worker/dist/project-file-tools.js","apps/worker/dist/run-lease-heartbeat.js","apps/worker/dist/run-pipeline.js","apps/worker/dist/runtime.js","apps/worker/dist/unified-model-stage.js","packages/contracts/dist/execution-capacity.js","packages/contracts/dist/index.js","packages/contracts/dist/performance.js","packages/contracts/dist/workpaper-entry.js","packages/contracts/dist/workpaper-progressive.js"]});
const recoveryPerformanceSql = Object.freeze({...performanceSql,"db/migrations/0189_terminal_recovery_audit.sql":{"bytes":1416,"sha256":"babe66b762a71248157a8b9b1d0c5687803dad8afbd1e578242cc4b3bf208f94"}});
const permissionsPaths = Object.fromEntries(Object.entries(recoveryPerformancePaths).map(([role,paths])=>[role,[...paths,'apps/api/dist/evidence-gate.js','apps/worker/dist/managed-database-preflight.js'].sort()]));
const permissionsSql = Object.freeze({...recoveryPerformanceSql,'db/migrations/0190_managed_evidence_gate_lock.sql':{"bytes": 940, "sha256": "91977d6f5a83896738469def69ebc2a4e0757851a7e9fee21c75eb2ad07bbb3d"}});
const encryptedPaths = Object.fromEntries(Object.entries(permissionsPaths).map(([role,paths])=>[role,[...paths,'apps/worker/dist/file-authoring-format.js','python/bondbuddy_file_authoring/fixed_edit.py'].sort()]));
const TASK_QUEUE_VERSION='shared-business-task-queue-v1';
const taskQueuePaths={"authoring":["apps/api/dist/batch-admission.js","apps/api/dist/data.js","apps/api/dist/evidence-gate.js","apps/api/dist/execution-capacity.js","apps/api/dist/log-ops.js","apps/api/dist/m4-workspace.js","apps/api/dist/material-jobs.js","apps/api/dist/observability.js","apps/api/dist/performance-dispatch.js","apps/api/dist/performance-store.js","apps/api/dist/performance-trace.js","apps/api/dist/project-file-consistency.js","apps/api/dist/project-file-workspace.js","apps/api/dist/provider-results.js","apps/api/dist/queue.js","apps/api/dist/review-workspace.js","apps/api/dist/trial-guard.js","apps/api/dist/workpapers.js","apps/api/package.json","apps/worker/dist/bounded-items.js","apps/worker/dist/codex-adapter.js","apps/worker/dist/deferred-qa-journal.js","apps/worker/dist/execution-node-runtime.js","apps/worker/dist/file-authoring-completion.js","apps/worker/dist/file-authoring-format.js","apps/worker/dist/file-authoring-repair.js","apps/worker/dist/file-authoring-stage.js","apps/worker/dist/historical-model-stage.js","apps/worker/dist/integrity-browser-boundary.js","apps/worker/dist/integrity-browser-stage.js","apps/worker/dist/integrity-browser.js","apps/worker/dist/m4-document-stage.js","apps/worker/dist/m4-file-workspace.js","apps/worker/dist/managed-database-preflight.js","apps/worker/dist/managed-run-retries.js","apps/worker/dist/material-parse-job.js","apps/worker/dist/material-parser.js","apps/worker/dist/model-call-budget.js","apps/worker/dist/model-performance.js","apps/worker/dist/performance-io.js","apps/worker/dist/project-file-tools.js","apps/worker/dist/project-qa-stage.js","apps/worker/dist/review-assistant.js","apps/worker/dist/review-correction-stage.js","apps/worker/dist/review-file-completion.js","apps/worker/dist/review-file-report.js","apps/worker/dist/review-file-stage.js","apps/worker/dist/run-lease-heartbeat.js","apps/worker/dist/run-pipeline.js","apps/worker/dist/runtime.js","apps/worker/dist/unified-model-stage.js","apps/worker/dist/workpaper-progressive-groups.js","apps/worker/dist/workpaper-shared-stage.js","packages/contracts/dist/execution-capacity.js","packages/contracts/dist/index.js","packages/contracts/dist/performance.js","packages/contracts/dist/review-editor.js","packages/contracts/dist/trial-guard.js","packages/contracts/dist/workpaper-entry.js","packages/contracts/dist/workpaper-progressive.js","python/bondbuddy_file_authoring/correction_findings.py","python/bondbuddy_file_authoring/correction_locator.py","python/bondbuddy_file_authoring/correction_rounding.py","python/bondbuddy_file_authoring/fixed_edit.py","python/bondbuddy_file_authoring/format_plan.py","python/bondbuddy_file_authoring/review-correction.md","python/bondbuddy_file_authoring/review_corrections.py","python/bondbuddy_workpaper_progressive_render.py"],"review":["apps/api/dist/batch-admission.js","apps/api/dist/evidence-gate.js","apps/api/dist/execution-capacity.js","apps/api/dist/m4-workspace.js","apps/api/dist/material-jobs.js","apps/api/dist/performance-store.js","apps/api/dist/performance-trace.js","apps/api/dist/queue.js","apps/api/dist/review-workspace.js","apps/api/dist/trial-guard.js","apps/api/package.json","apps/worker/dist/codex-adapter.js","apps/worker/dist/execution-node-runtime.js","apps/worker/dist/file-authoring-completion.js","apps/worker/dist/file-authoring-format.js","apps/worker/dist/file-authoring-repair.js","apps/worker/dist/file-authoring-stage.js","apps/worker/dist/historical-model-stage.js","apps/worker/dist/m4-file-workspace.js","apps/worker/dist/managed-database-preflight.js","apps/worker/dist/managed-run-retries.js","apps/worker/dist/material-parse-job.js","apps/worker/dist/material-parser.js","apps/worker/dist/model-call-budget.js","apps/worker/dist/model-performance.js","apps/worker/dist/performance-io.js","apps/worker/dist/project-file-tools.js","apps/worker/dist/review-assistant.js","apps/worker/dist/review-correction-stage.js","apps/worker/dist/review-file-completion.js","apps/worker/dist/review-file-report.js","apps/worker/dist/review-file-stage.js","apps/worker/dist/run-lease-heartbeat.js","apps/worker/dist/run-pipeline.js","apps/worker/dist/runtime.js","apps/worker/dist/unified-model-stage.js","packages/contracts/dist/execution-capacity.js","packages/contracts/dist/index.js","packages/contracts/dist/performance.js","packages/contracts/dist/review-editor.js","packages/contracts/dist/trial-guard.js","packages/contracts/dist/workpaper-entry.js","packages/contracts/dist/workpaper-progressive.js","python/bondbuddy_file_authoring/correction_findings.py","python/bondbuddy_file_authoring/correction_locator.py","python/bondbuddy_file_authoring/correction_rounding.py","python/bondbuddy_file_authoring/fixed_edit.py","python/bondbuddy_file_authoring/format_plan.py","python/bondbuddy_file_authoring/review-correction.md","python/bondbuddy_file_authoring/review_corrections.py"]};
const taskQueueSql=Object.freeze({...permissionsSql,...{"db/migrations/0191_task_target_execution_mutex.sql":{"bytes":3984,"sha256":"d27e82cf8402ea8fb5e2f9c7cd6ca2946197d5a3ef28ab47e708edb377b6f380"}}});
const performanceProfile = version => version===TASK_QUEUE_VERSION ? {paths:taskQueuePaths,sql:taskQueueSql,count:118} : version===ENCRYPTED_VERSION ? {paths:encryptedPaths,sql:permissionsSql,count:78} : version===PERMISSIONS_VERSION ? {paths:permissionsPaths,sql:permissionsSql,count:74} : version===RECOVERY_PERFORMANCE_VERSION ? {paths:recoveryPerformancePaths,sql:recoveryPerformanceSql,count:70} : {paths:performancePaths,sql:performanceSql,count:63};

function performanceKey(f) { return `${f.service_id}/${f.path}`; }
function validPerformanceFiles(files, version = files?.length===118 ? TASK_QUEUE_VERSION : files?.length===78 ? ENCRYPTED_VERSION : files?.length===74 ? PERMISSIONS_VERSION : files?.length===70 ? RECOVERY_PERFORMANCE_VERSION : PERFORMANCE_VERSION) {
  const {paths,count}=performanceProfile(version);
  return Array.isArray(files) && files.length === count && new Set(files.map(performanceKey)).size === count &&
    files.every(f=>f && Object.keys(f).length === 4 && Object.keys(f).every(k=>['service_id','path','sha256','bytes'].includes(k)) &&
      Object.hasOwn(paths,f.service_id) && paths[f.service_id].includes(f.path) &&
      /^[a-f0-9]{64}$/.test(f.sha256) && Number.isInteger(f.bytes) && f.bytes > 0 && f.bytes <= 262144) &&
    Object.entries(paths).every(([role,paths])=>files.filter(f=>f.service_id===role).length===paths.length);
}
function performanceArchiveFiles(archive,descriptor) {
  requireThat(validPerformanceFiles(descriptor.files,descriptor.version) && archive.length===descriptor.bytes && sha256(archive)===descriptor.sha256,'BUSINESS_OVERLAY_ARCHIVE');
  const tar=gunzipSync(archive,{maxOutputLength:4194304}), result=new Map();
  const expected=new Map([...descriptor.files.map(f=>[performanceKey(f),f]),...Object.entries(performanceProfile(descriptor.version).sql)]);
  let offset=0,ended=false;
  while(offset+512<=tar.length){
    const h=tar.subarray(offset,offset+512);offset+=512;
    if(h.every(b=>b===0)){requireThat(tar.length-offset>=512 && tar.subarray(offset).every(b=>b===0),'BUSINESS_OVERLAY_TRAILING');ended=true;break;}
    const string=(start,end)=>h.subarray(start,end).toString().split('\0')[0];
    const name=string(0,100),sizeText=string(124,136).trim(),checksumText=string(148,156).trim();
    const checksum=h.reduce((sum,b,i)=>sum+(i>=148&&i<156?32:b),0);
    requireThat(!string(345,500) && /^[0-7]+$/.test(sizeText) && /^[0-7]+$/.test(checksumText) &&
      parseInt(checksumText,8)===checksum && (h[156]===0||h[156]===48) && expected.has(name) && !result.has(name),'BUSINESS_OVERLAY_MEMBER');
    const size=parseInt(sizeText,8),entry=expected.get(name);
    requireThat(size===entry.bytes && size<=262144 && offset+size<=tar.length,'BUSINESS_OVERLAY_MEMBER');
    const bytes=Buffer.from(tar.subarray(offset,offset+size));requireThat(sha256(bytes)===entry.sha256,'BUSINESS_OVERLAY_FILE_HASH');
    result.set(name,bytes);offset+=Math.ceil(size/512)*512;
  }
  requireThat(ended && result.size===expected.size && [...expected.keys()].every(p=>result.has(p)),'BUSINESS_OVERLAY_FILES');
  return new Map(descriptor.files.map(f=>[performanceKey(f),result.get(performanceKey(f))]));
}
function performanceCompose(base,directory,files) {
  requireThat(validPerformanceFiles(files) && /^\/opt\/bondbuddy\/business-overlays\/[a-f0-9]{64}$/.test(directory),'BUSINESS_OVERLAY_SCOPE');
  const boundary=base.indexOf('\n  review:'),marker='    volumes:\n';
  requireThat(base.startsWith('# Standalone execution nodes only:')&&boundary>0,'BUSINESS_OVERLAY_COMPOSE');
  const sections=[base.slice(0,boundary),base.slice(boundary)];
  return ['authoring','review'].map((role,i)=>{
    requireThat(sections[i].split(marker).length===2,'BUSINESS_OVERLAY_COMPOSE');
    const mounts=files.filter(f=>f.service_id===role).map(f=>`      - ${directory}/${role}/${f.path}:/app/${f.path}:ro\n`).join('');
    return sections[i].replace(marker,marker+mounts);
  }).join('');
}

export function validateBusinessOverlay(value, pin) {
  const performance=isPerformanceVersion(value?.version);
  if(performance){
    requireThat(value.sha256===pin && /^[a-f0-9]{64}$/.test(pin) && Number.isInteger(value.bytes) && value.bytes>0 && value.bytes<=(value.version===TASK_QUEUE_VERSION?1048576:524288) && validPerformanceFiles(value.files,value.version),'BUSINESS_OVERLAY_SCOPE');
  } else {
  const recovery=value?.version===recoveryVersion,eight=recovery||value?.version==='shared-business-eight-v1',count=recovery?31:eight?25:19;
  requireThat((eight || value?.version === 'shared-business-four-v1') && value.sha256 === pin && /^[a-f0-9]{64}$/.test(pin) &&
    Number.isInteger(value.bytes) && value.bytes > 0 && value.bytes <= 262144 &&
    Array.isArray(value.files) && value.files.length === count && new Set(value.files.map(f=>f.path)).size === count &&
    value.files.every(f=>safePath(f.path,eight,recovery) && /^[a-f0-9]{64}$/.test(f.sha256) &&
      Number.isInteger(f.bytes) && f.bytes > 0 && f.bytes <= 262144), 'BUSINESS_OVERLAY_SCOPE');
  }
  let url; try { url = new URL(value.url); } catch { throw Error('BUSINESS_OVERLAY_URL'); }
  requireThat(url.protocol === 'https:' && /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) &&
    url.pathname.startsWith('/bondbuddy-private/') && !url.username && !url.password && !url.hash &&
    url.searchParams.get('sp') === 'r' && url.searchParams.get('sr') === 'b' &&
    Date.parse(url.searchParams.get('se')) > Date.now() + 60000, 'BUSINESS_OVERLAY_URL');
}

/** Read only regular USTAR members; never let tar create links or arbitrary paths. */
export function businessOverlayFiles(archive, descriptor) {
  if(isPerformanceVersion(descriptor.version))return performanceArchiveFiles(archive,descriptor);
  requireThat(archive.length === descriptor.bytes && sha256(archive) === descriptor.sha256, 'BUSINESS_OVERLAY_ARCHIVE');
  const tar = gunzipSync(archive, {maxOutputLength: 2097152}), result = new Map();
  const recovery=descriptor.version===recoveryVersion,eight=recovery||descriptor.version==='shared-business-eight-v1';
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512); offset += 512;
    if(h.every(b=>b===0))break;
    const string = (start,end) => h.subarray(start,end).toString().split('\0')[0];
    const path = string(0,100), sizeText = string(124,136).trim();
    requireThat(!string(345,500) && /^[0-7]+$/.test(sizeText) && (h[156]===0 || h[156]===48), 'BUSINESS_OVERLAY_MEMBER');
    const size = parseInt(sizeText,8);
    requireThat(size <= 262144 && offset + size <= tar.length && !result.has(path), 'BUSINESS_OVERLAY_MEMBER');
    requireThat(safePath(path,eight,recovery) || /^db\/migrations\/018(?:0_batch_four_way|6_shared_batch_capacity)\.sql$/.test(path) || eight && path==='db/migrations/0188_execution_node_eight_capacity.sql' || recovery && path==='db/migrations/0189_terminal_recovery_audit.sql', 'BUSINESS_OVERLAY_PATH');
    result.set(path, Buffer.from(tar.subarray(offset,offset+size))); offset += Math.ceil(size/512)*512;
  }
  requireThat(result.size === (recovery?35:eight?28:21) && descriptor.files.every(f=>result.get(f.path)?.length === f.bytes &&
    sha256(result.get(f.path))===f.sha256), 'BUSINESS_OVERLAY_FILES');
  return new Map(descriptor.files.map(f=>[f.path,result.get(f.path)]));
}

export function businessOverlayCompose(base, directory, files) {
  if(files.some(f=>Object.hasOwn(f,'service_id')))return performanceCompose(base,directory,files);
  const boundary = base.indexOf('\n  review:');
  requireThat(base.startsWith('# Standalone execution nodes only:') && boundary > 0, 'BUSINESS_OVERLAY_COMPOSE');
  const authoring = base.slice(0,boundary), marker = '    volumes:\n';
  requireThat(authoring.split(marker).length===2, 'BUSINESS_OVERLAY_COMPOSE');
  const mounts = files.filter(f=>f.path!=='apps/worker/dist/run-pipeline-review.js').map(f=>`      - ${directory}/${f.path}:/app/${f.path}:ro\n`).join('');
  const common=new Set(['apps/worker/dist/runtime.js','apps/worker/dist/model-call-budget.js','apps/api/dist/execution-capacity.js',
    'apps/api/dist/batch-admission.js','packages/contracts/dist/workpaper-entry.js',
    'packages/contracts/dist/execution-capacity.js','packages/contracts/dist/index.js','packages/contracts/dist/workpaper-progressive.js']);
  const recovery=files.some(f=>f.path==='apps/worker/dist/managed-run-retries.js');
  if(recovery)for(const path of ['apps/api/dist/queue.js','apps/worker/dist/execution-node-runtime.js','apps/worker/dist/run-lease-heartbeat.js','apps/worker/dist/managed-run-retries.js','apps/worker/dist/run-pipeline-review.js'])common.add(path);
  const reviewMounts=files.filter(f=>common.has(f.path)).map(f=>`      - ${directory}/${f.path}:/app/${f.path==='apps/worker/dist/run-pipeline-review.js'?'apps/worker/dist/run-pipeline.js':f.path}:ro\n`).join('');
  const review=base.slice(boundary);
  requireThat(review.split(marker).length===2,'BUSINESS_OVERLAY_COMPOSE');
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
  const composeFile=join(dirname(config.compose_file),`compose.business-${descriptor.sha256}-${config.compose_sha256}.yaml`);
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
  for(const entry of descriptor.files)await file(join(target,isPerformanceVersion(descriptor.version)?performanceKey(entry):entry.path),entry);
  try {await lstat(composeFile);}catch(e){if(e.code!=='ENOENT')throw e;await write(composeFile,Buffer.from(compose));}
  await file(composeFile,{bytes:Buffer.byteLength(compose),sha256:sha256(compose)});
  return {compose_file:composeFile,compose_sha256:sha256(compose)};
}
