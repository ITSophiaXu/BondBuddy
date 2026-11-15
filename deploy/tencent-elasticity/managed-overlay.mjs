import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,unlinkSync,readdirSync,copyFileSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',['-C',root,...args],{maxBuffer:128*1024*1024});
const source=(sha,path)=>git('show',`${sha}:${path}`);
const checkedSource=(entry)=>{
  if(!/^[a-f0-9]{40}$/.test(entry.source_sha)||!/^[a-f0-9]{64}$/.test(entry.sha256)||!entry.path||entry.path.startsWith('/')||entry.path.split('/').includes('..'))throw Error('OVERLAY_SOURCE_INVALID');
  const bytes=source(entry.source_sha,entry.path);
  if(hash(bytes)!==entry.sha256)throw Error(`OVERLAY_SOURCE_HASH_MISMATCH: ${entry.path}`);
  return bytes;
};
function assertTrustedCommit(sha){
  if(!/^[a-f0-9]{40}$/.test(sha)||git('remote','get-url','origin').toString().trim()!=='https://github.com/ITSophiaXu/BondBuddy.git')throw Error('OVERLAY_TRUSTED_REMOTE_REQUIRED');
  const refs=git('for-each-ref','--format=%(refname)','refs/remotes/origin/').toString().trim().split('\n');
  if(!refs.some(ref=>{try{git('merge-base','--is-ancestor',sha,ref);return true;}catch{return false;}}))throw Error('OVERLAY_SOURCE_NOT_FROM_ORIGIN');
}
function replaceOnce(text,before,after){
  if(text.split(before).length!==2)throw Error(`OVERLAY_ANCHOR_MISMATCH: ${before.slice(0,100)}`);
  return text.replace(before,after);
}
function applyPinnedHunks(output,patch){
  let path;
  for(const section of patch.toString().split(/^diff --git /m).slice(1)){
    path=section.match(/^a\/\S+ b\/(\S+)/)?.[1];
    let text=readFileSync(join(output,path),'utf8');
    for(const hunk of section.split(/^@@[^\n]*\n/m).slice(1)){
      const lines=hunk.trimEnd().split('\n');
      const first=lines.findIndex(l=>l[0]==='+'||l[0]==='-');
      let last=lines.length-1;while(last>first&&lines[last][0]===' ')last--;
      const middle=lines.slice(first,last+1);let applied=false;
      // The approved patches were authored after managed admission existed.
      // Keep every changed line; use the nearest unique unchanged anchors when
      // their outer managed-only context is absent from the fixed component.
      for(let context=3;context>=1&&!applied;context--){
        const selected=[...lines.slice(Math.max(0,first-context),first),...middle,...lines.slice(last+1,last+1+context)];
        const before=selected.filter(l=>l[0]!=='+').map(l=>l.slice(1)+'\n').join('');
        const after=selected.filter(l=>l[0]!=='-').map(l=>l.slice(1)+'\n').join('');
        if(text.split(before).length===2){text=text.replace(before,after);applied=true;}
      }
      if(!applied)throw Error(`FIXED_PATCH_ANCHOR_MISMATCH: ${path}`);
    }
    writeFileSync(join(output,path),text);
  }
}

/** Materialize two component-specific source trees. This never builds an image,
 * migrates a database, activates a pool or changes deployment configuration. */
export function generateManagedOverlay(role,output){
  const lockBytes=readFileSync(join(root,'deploy/tencent-elasticity/managed-overlay.lock.json'));
  const lock=JSON.parse(lockBytes),component=lock.components[role];
  if(!component||existsSync(output))throw Error('OVERLAY_ROLE_OR_OUTPUT_INVALID');
  for(const sha of new Set([component.base_sha,lock.infrastructure_sha,lock.progressive_fallback.source_sha,...component.fixed_overlay.map(e=>e.source_sha),...lock.fixed_derivations.map(e=>e.commit)]))assertTrustedCommit(sha);
  if(!/^[a-f0-9]{40}$/.test(component.base_sha)||git('rev-parse',`${component.base_sha}^{tree}`).toString().trim()!==component.base_tree)throw Error('OVERLAY_BASE_MISMATCH');
  mkdirSync(output,{recursive:true});
  const archive=join(output,'.base-source.tar');
  git('archive',`--output=${archive}`,component.base_sha);
  try{execFileSync('tar',['-xf',archive,'-C',output]);}finally{unlinkSync(archive);}
  const receipts=[];
  const write=(path,bytes,origin)=>{
    mkdirSync(dirname(join(output,path)),{recursive:true});writeFileSync(join(output,path),bytes);
    receipts.push({path,sha256:hash(bytes),...origin});
  };
  for(const entry of component.fixed_overlay)write(entry.path,checkedSource(entry),{kind:'fixed-component',source_sha:entry.source_sha,source_sha256:entry.sha256});
  for(const derivation of lock.fixed_derivations){
    const patch=git('diff',`${derivation.commit}^`,derivation.commit,'--',...derivation.paths);
    if(hash(patch)!==derivation.patch_sha256)throw Error('FIXED_PATCH_HASH_MISMATCH');
    applyPinnedHunks(output,patch);
    for(const expected of derivation.results){
      const bytes=readFileSync(join(output,expected.path));
      if(hash(bytes)!==expected.sha256)throw Error(`FIXED_DERIVED_SOURCE_MISMATCH: ${expected.path}`);
      receipts.push({path:expected.path,kind:'fixed-derived',source_sha:derivation.commit,patch_sha256:derivation.patch_sha256,sha256:hash(bytes)});
    }
  }
  const fixedFiles=[...new Set([...git('ls-tree','-r','--name-only','-z',component.base_sha).toString().split('\0').filter(Boolean),...component.fixed_overlay.map(e=>e.path)])].sort();
  const fixedHashes=new Map(fixedFiles.map(path=>[path,hash(readFileSync(join(output,path)))]));
  const read=path=>readFileSync(join(output,path),'utf8');
  const shared=new Map(lock.sources.map(entry=>[entry.path,entry]));
  const from=path=>checkedSource(shared.get(path)).toString();
  for(const path of lock.copy_paths)write(path,checkedSource(shared.get(path)),{kind:'managed-infrastructure',source_sha:shared.get(path).source_sha,source_sha256:shared.get(path).sha256});
  const patch=(path,text,sourcePaths)=>write(path,text,{kind:'managed-seam',source_sha:lock.infrastructure_sha,source_paths:sourcePaths,fixed_sha256:fixedHashes.get(path)});

  const queue='apps/api/src/queue.ts';let q=read(queue);
  if(!q.includes("import {executionClaimGate}"))q="import {executionClaimGate} from './execution-capacity.js';\n"+q;
  q=replaceOnce(q,'const runKinds = checkedRunKinds(options.runKinds);\n  return transaction(pool,async client=>{','const runKinds = checkedRunKinds(options.runKinds);\n  return transaction(pool,async client=>{\n    await executionClaimGate(client,pool);');
  q=replaceOnce(q,"AND r.state NOT IN ('cancelled','failed','succeeded','test_completed','rejected') AND (j.job_type='platform_probe')", "AND NOT (j.execution_node_id IS NOT NULL AND j.lease_token IS NOT NULL) AND r.state NOT IN ('cancelled','failed','succeeded','test_completed','rejected') AND (j.job_type='platform_probe')");
  q=replaceOnce(q,'async function providerCallNeedsReconciliation(', 'export async function providerCallNeedsReconciliation(');
  const fence=from(queue).slice(from(queue).indexOf('/** Cloud death is a capacity fence,'));
  if(!fence.startsWith('/** Cloud death')||q.includes('fenceStoppedExecutionEpoch'))throw Error('OVERLAY_FENCE_INVALID');
  patch(queue,q+'\n'+fence,[queue]);

  const journal='apps/worker/src/durable-probe-journal.ts';let j=read(journal);
  j=replaceOnce(j,'acquire(signal, `run:${this.codexInput.lease.runId}`)','acquire(signal, `run:${this.codexInput.lease.runId}`,{kind:\'job\',id:this.codexInput.lease.jobId,token:this.codexInput.lease.token})');
  patch(journal,j,[journal]);

  const apiPackage='apps/api/package.json';const pkg=JSON.parse(read(apiPackage));
  pkg.exports['./execution-capacity']={types:'./dist/execution-capacity.d.ts',default:'./dist/execution-capacity.js'};
  patch(apiPackage,JSON.stringify(pkg,null,2)+'\n',[apiPackage]);
  const index='packages/contracts/src/index.ts';
  patch(index,read(index)+"\nexport * from './execution-capacity.js';\n",[index]);
  const progressive='packages/contracts/src/workpaper-progressive.ts';
  let p=existsSync(join(output,progressive))?read(progressive):checkedSource(lock.progressive_fallback).toString();
  p=replaceOnce(p,'max_parallel:typeof WORKPAPER_MAX_PARALLEL;','max_parallel:2|4;');
  if(!p.includes('WORKPAPER_PLAN_GROUP_SIZE'))p+='\n'+from(progressive).slice(from(progressive).indexOf('/** Stable eight-file planning groups.'));
  patch(progressive,p,[progressive]);
  const workpapers='packages/contracts/src/workpapers.ts';
  if(!read(workpapers).includes("export * from './workpaper-progressive.js'"))patch(workpapers,read(workpapers)+"\nexport * from './workpaper-progressive.js';\n",[workpapers]);

  const changed=new Set(receipts.filter(r=>r.kind.startsWith('managed-')).map(r=>r.path));
  const preserved=fixedFiles.filter(path=>!changed.has(path)).map(path=>({path,sha256:fixedHashes.get(path)}));
  for(const entry of preserved)if(hash(readFileSync(join(output,entry.path)))!==entry.sha256)throw Error(`OVERLAY_UNLISTED_CHANGE: ${entry.path}`);
  const business=preserved.filter(e=>/^(apps\/(worker|api)\/src|python|packages\/domain|knowledge)\//.test(e.path));
  const manifest={version:'managed-component-overlay-v1',role,base_sha:component.base_sha,base_tree:component.base_tree,
    fixed_manifest_sha256:component.fixed_manifest_sha256,fixed_image_id:component.fixed_image_id,
    infrastructure_sha:lock.infrastructure_sha,lock_sha256:hash(lockBytes),generator_sha256:hash(readFileSync(fileURLToPath(import.meta.url))),migrations:lock.migrations,
    files:receipts,unchanged_business_files:business,business_sha256:hash(JSON.stringify(business)),
    preserved_files_sha256:hash(JSON.stringify(preserved)),activation:'disabled',production_acceptance:'pending'};
  writeFileSync(join(output,'managed-overlay.manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
export function buildManagedOverlay(output){
  execFileSync('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:output,stdio:'inherit'});
  for(const pkg of ['contracts','domain','rule-pack-registry','rule-applicability-context','api','worker']){
    execFileSync('npm',['run','build','-w',`@bondbuddy/${pkg}`],{cwd:output,stdio:'inherit'});
  }
  return packageManagedOverlay(output);
}
export function packageManagedOverlay(output){
  const manifest=JSON.parse(readFileSync(join(output,'managed-overlay.manifest.json')));
  // Packaging must not bless source modified since materialization.
  for(const entry of new Map(manifest.files.map(e=>[e.path,e])).values())if(hash(readFileSync(join(output,entry.path)))!==entry.sha256)throw Error(`OVERLAY_SOURCE_CHANGED: ${entry.path}`);
  for(const entry of manifest.unchanged_business_files)if(hash(readFileSync(join(output,entry.path)))!==entry.sha256)throw Error(`OVERLAY_BUSINESS_CHANGED: ${entry.path}`);
  const files=[];
  const walk=dir=>{for(const name of readdirSync(join(output,dir),{withFileTypes:true})){
    const path=join(dir,name.name);if(name.isDirectory())walk(path);else if(name.isFile()&&!/\.test\.(js|d\.ts)$/.test(path))files.push({path,sha256:hash(readFileSync(join(output,path)))});
  }};
  for(const dir of ['packages/contracts/dist','packages/domain/dist','packages/rule-pack-registry/dist','packages/rule-applicability-context/dist','apps/api/dist','apps/worker/dist'])walk(dir);
  files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const fixedAdapter=files.find(f=>f.path==='apps/worker/dist/codex-adapter.js');
  if(fixedAdapter?.sha256!=='dc68153bef393c54580a625c64bba4a501d58e60e471358894227d83fac3622c')throw Error('FIXED_CODEX_ADAPTER_EMIT_MISMATCH');
  const artifact={version:'managed-overlay-artifact-v1',role:manifest.role,source_manifest_sha256:hash(readFileSync(join(output,'managed-overlay.manifest.json'))),files,artifact_sha256:hash(JSON.stringify(files)),production_acceptance:'pending'};
  writeFileSync(join(output,'managed-overlay.artifact.json'),JSON.stringify(artifact,null,2)+'\n');
  const payload=join(output,'.managed-overlay-payload');mkdirSync(payload,{recursive:false});
  try{
    const selected=new Set(['managed-overlay.manifest.json','managed-overlay.artifact.json']);
    for(const entry of manifest.files){
      if(entry.path.endsWith('.ts')){
        const js=entry.path.replace('/src/','/dist/').replace(/\.ts$/,'.js');selected.add(js);
        if(existsSync(join(output,js.replace(/\.js$/,'.d.ts'))))selected.add(js.replace(/\.js$/,'.d.ts'));
      }else selected.add(entry.path);
    }
    for(const path of selected){mkdirSync(dirname(join(payload,path)),{recursive:true});copyFileSync(join(output,path),join(payload,path));}
    const paths=[...selected].sort();
    execFileSync('tar',['--sort=name','--mtime=1970-01-01','--owner=0','--group=0','--numeric-owner','--mode=u=rwX,go=rX','-cf',join(output,'managed-overlay.tar'),'-C',payload,...paths]);
    writeFileSync(join(output,'managed-overlay.tar.sha256'),hash(readFileSync(join(output,'managed-overlay.tar')))+'\n');
  }finally{rmSync(payload,{recursive:true});}
  return artifact;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [, ,role,output]=process.argv;if(!role||!output)throw Error('Usage: node deploy/tencent-elasticity/managed-overlay.mjs authoring|review OUTPUT');
  const result=generateManagedOverlay(role,resolve(output));
  console.log(JSON.stringify({role,base_sha:result.base_sha,business_sha256:result.business_sha256,files:result.files.length,manifest_sha256:hash(readFileSync(join(resolve(output),'managed-overlay.manifest.json')))}));
  if(process.argv.includes('--build'))console.log(JSON.stringify(buildManagedOverlay(resolve(output))));
}
