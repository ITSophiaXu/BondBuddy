import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {gzipSync} from 'node:zlib';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const baseline='1d78ccfec024fb5484a8baeaf87d1ae13bc130f5',fix='670e591b55262e9b9cf7e608eddd75bcb18c3ee4';
const git=(...args)=>execFileSync('git',['-C',root,...args],{maxBuffer:2000000}).toString();
const source=(commit,path)=>git('show',commit+':'+path),hash=b=>createHash('sha256').update(b).digest('hex');
const once=(text,before,after)=>{if(text.split(before).length!==2)throw Error('RECOVERY_SOURCE_ANCHOR');return text.replace(before,after);};
function approvedPatch(text,path){
 const patch=git('diff','--no-ext-diff',fix+'^',fix,'--',path);
 for(const hunk of patch.split(/^@@[^\n]*\n/m).slice(1)){
  const lines=hunk.trimEnd().split('\n'),first=lines.findIndex(l=>l[0]==='+'||l[0]==='-');let last=lines.length-1;
  while(last>first&&lines[last][0]===' ')last--;
  let applied=false;
  for(let context=3;context>=0&&!applied;context--){
   const selected=[...lines.slice(Math.max(0,first-context),first),...lines.slice(first,last+1),...lines.slice(last+1,last+1+context)];
   const before=selected.filter(l=>l[0]!=='+').map(l=>l.slice(1)+'\n').join(''),after=selected.filter(l=>l[0]!=='-').map(l=>l.slice(1)+'\n').join('');
   if(before&&text.split(before).length===2){text=text.replace(before,after);applied=true;}
  }
  if(!applied)throw Error('RECOVERY_PATCH_ANCHOR: '+path);
 }
 return text;
}
function managedQueue(){
 const lock=JSON.parse(readFileSync(join(root,'deploy/tencent-elasticity/managed-overlay.lock.json'))),entry=lock.components.authoring.fixed_overlay.find(e=>e.path==='apps/api/src/queue.ts');
 let q=source(entry.source_sha,entry.path);if(hash(q)!==entry.sha256)throw Error('QUEUE_SOURCE_PIN');
 q="import {executionClaimGate} from './execution-capacity.js';\n"+q;
 q=once(q,'const runKinds = checkedRunKinds(options.runKinds);\n  return transaction(pool,async client=>{','const runKinds = checkedRunKinds(options.runKinds);\n  return transaction(pool,async client=>{\n    await executionClaimGate(client,pool);');
 q=once(q,"AND r.state NOT IN ('cancelled','failed','succeeded','test_completed','rejected') AND (j.job_type='platform_probe')","AND NOT (j.execution_node_id IS NOT NULL AND j.lease_token IS NOT NULL) AND r.state NOT IN ('cancelled','failed','succeeded','test_completed','rejected') AND (j.job_type='platform_probe')");
 q=once(q,'async function providerCallNeedsReconciliation(','export async function providerCallNeedsReconciliation(');
 const upstream=source(lock.infrastructure_sha,entry.path);return q+'\n'+upstream.slice(upstream.indexOf('/** Cloud death is a capacity fence,'));
}
const emit=s=>{const r=ts.transpileModule(s,{reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});if(r.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error))throw Error('RECOVERY_TRANSPILE');return r.outputText;};
export function buildRecoveryOverlay(){
 if(git('remote','get-url','origin').trim()!=='https://github.com/ITSophiaXu/BondBuddy.git')throw Error('TRUSTED_REMOTE_REQUIRED');
 git('merge-base','--is-ancestor',baseline,'origin/master');git('merge-base','--is-ancestor',fix,'origin/develop');
 const out=join(root,'deploy/tencent-elasticity/recovery-artifacts');if(existsSync(out)){const prior=JSON.parse(readFileSync(join(out,'source-manifest.json')));if(prior.version!=='managed-recovery-source-v1'||prior.fix_commit!==fix)throw Error('RECOVERY_OUTPUT_EXISTS');}mkdirSync(out,{recursive:true});
 const write=(path,b)=>{const target=join(out,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,b);};
 const descriptor=JSON.parse(source(baseline,'deploy/tencent-elasticity/node-eight-artifacts/descriptor.json')),receipts=[];
 for(const f of descriptor.files){const b=Buffer.from(source(baseline,'deploy/tencent-elasticity/node-eight-artifacts/'+f.path));if(hash(b)!==f.sha256)throw Error('BASE_OVERLAY_HASH');write(f.path,b);}
 const paths=['apps/api/src/queue.ts','apps/api/src/execution-capacity.ts',...['runtime','run-pipeline','execution-node-runtime','run-lease-heartbeat','integrity-browser','integrity-browser-boundary','integrity-browser-stage'].map(n=>'apps/worker/src/'+n+'.ts')];
 for(const path of paths){
  const artifact=path.replace('/src/','/dist/').replace(/\.ts$/,'.js');let text=path==='apps/api/src/queue.ts'?managedQueue():source(baseline,path==='apps/api/src/execution-capacity.ts'?'deploy/tencent-elasticity/node-eight-sources/api-execution-capacity.ts':path);
  const before=emit(text),old=descriptor.files.find(f=>f.path===artifact);
  if(old&&hash(before)!==old.sha256)throw Error('SOURCE_DOES_NOT_MATCH_DEPLOYED_OVERLAY: '+path);
  if(path==='apps/api/src/queue.ts'&&hash(before)!=='d9c8718ca52e126925e671e91f930933ace8d6998c9856c69f1af841dda0bc3e')throw Error('QUEUE_BEFORE_DIFFERS');
  if(path==='apps/worker/src/run-pipeline.ts'){
   text="import {startRunLeaseHeartbeat} from './run-lease-heartbeat.js';\n"+text;
   text=once(text,'const heartbeat = setInterval(() => { void renew(pool, lease, leaseSeconds).catch(() => { clearInterval(heartbeat); abort.abort(); }); }, Math.max(1000, leaseSeconds * 400));','const heartbeat = startRunLeaseHeartbeat({renew:()=>renew(pool,lease,leaseSeconds),intervalMs:Math.max(1000,leaseSeconds*400),onLost:()=>abort.abort()});');
   text=once(text,'    clearInterval(heartbeat);','    heartbeat.stop();');
  }
  text=approvedPatch(text,path);const compiled=emit(text);write('sources/'+path,text);write(artifact,compiled);receipts.push({path,baseline_source:baseline,baseline_compiled_sha256:hash(before),fix_source:fix,source_sha256:hash(text),compiled_sha256:hash(compiled)});
 }
 const added='apps/worker/src/managed-run-retries.ts',a=source(fix,added);write('sources/'+added,a);write('apps/worker/dist/managed-run-retries.js',emit(a));receipts.push({path:added,fix_source:fix,source_sha256:hash(a),compiled_sha256:hash(emit(a))});
 const reviewBase='9c6ab2c2d995774af48a537cdf0a087959165d10',reviewPath='apps/worker/src/run-pipeline.ts';
 let review=source(reviewBase,reviewPath);const reviewBefore=emit(review);
 if(hash(reviewBefore)!=='021f553a70a74a7b4170bc99a4f23302f3c52ed80cffb41dccb68c7a767e9416')throw Error('REVIEW_PIPELINE_BEFORE_DIFFERS');
 review="import {startRunLeaseHeartbeat} from './run-lease-heartbeat.js';\n"+review;
 review=once(review,'const heartbeat = setInterval(() => { void renew(pool, lease, leaseSeconds).catch(() => { clearInterval(heartbeat); abort.abort(); }); }, Math.max(1000, leaseSeconds * 400));','const heartbeat = startRunLeaseHeartbeat({renew:()=>renew(pool,lease,leaseSeconds),intervalMs:Math.max(1000,leaseSeconds*400),onLost:()=>abort.abort()});');
 review=once(review,'    clearInterval(heartbeat);','    heartbeat.stop();');review=approvedPatch(review,reviewPath);
 const reviewSource='apps/worker/src/run-pipeline-review.ts';write('sources/'+reviewSource,review);write('apps/worker/dist/run-pipeline-review.js',emit(review));receipts.push({path:reviewSource,mount_target:'apps/worker/dist/run-pipeline.js',service_id:'review',baseline_source:reviewBase,baseline_compiled_sha256:hash(reviewBefore),fix_source:fix,source_sha256:hash(review),compiled_sha256:hash(emit(review))});
 const files=[...new Set([...descriptor.files.map(f=>f.path),...receipts.map(f=>f.path.replace('/src/','/dist/').replace(/\.ts$/,'.js'))])].sort().map(path=>{const b=readFileSync(join(out,path));return {path,bytes:b.length,sha256:hash(b)};});
 if(files.length!==31)throw Error('RECOVERY_CLOSURE_COUNT');
 write('source-manifest.json',JSON.stringify({version:'managed-recovery-source-v1',base_archive:descriptor.sha256,fix_commit:fix,typescript:ts.version,files:receipts,preserved:['codex-adapter.js','model-call-budget.js','durable-probe-journal.js'],model_wait_billing_included:false},null,2)+'\n');
 write('descriptor.files.json',JSON.stringify({version:'shared-business-eight-recovery-v1',files},null,2)+'\n');
 const migrations=['0180_batch_four_way.sql','0186_shared_batch_capacity.sql','0188_execution_node_eight_capacity.sql','0189_terminal_recovery_audit.sql'].map(n=>'db/migrations/'+n);
 for(const path of migrations)write(path,source(path.includes('0189_')?fix:baseline,path));
 const tar=execFileSync('tar',['--format=ustar','--mtime=@0','--owner=0','--group=0','--numeric-owner','--mode=0644','-cf','-',...files.map(f=>f.path),...migrations],{cwd:out,maxBuffer:4000000});
 const archive=gzipSync(tar,{level:9,mtime:0});write('overlay.tar.gz',archive);write('descriptor.json',JSON.stringify({version:'shared-business-eight-recovery-v1',sha256:hash(archive),bytes:archive.length,files},null,2)+'\n');
 return {version:'shared-business-eight-recovery-v1',files:files.length,source_files:receipts.length,archive_bytes:archive.length,archive_sha256:hash(archive)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildRecoveryOverlay()));
