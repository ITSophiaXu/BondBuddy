#!/usr/bin/env node
/** Reuse the exact locally tested images; never rebuild, pull or waive evidence. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyReport,verifyRollbackReport} from './verify.mjs';
import {sha256} from './support.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export function targetsFor(scope){
 if(scope==='all'||scope==='main')return ['api','worker','web'];
 if(scope==='execution')return ['worker'];
 throw Error('Unknown deployment image scope');
}
export function verifyImageIdentity(report,expected,target,actual,enginePlatform){
 const tested=report.images?.[target],platform=actual?.Os+'/'+actual?.Architecture;
 assert.ok(/^[a-f0-9]{40}$/.test(expected.commit)&&report.sha===expected.commit&&report.tree===expected.tree,'Image report belongs to another candidate');
 assert.ok(/^sha256:[a-f0-9]{64}$/.test(tested?.id??'')&&actual?.Id===tested.id,'Actual '+target+' image differs from the tested image ID');
 assert.equal(actual.Config?.Labels?.['org.opencontainers.image.revision'],expected.commit,'Actual image source revision mismatch: '+target);
 assert.ok(/^linux\/(?:amd64|arm64)$/.test(tested.platform)&&platform===tested.platform,'Actual image platform differs from tested platform: '+target);
 assert.equal(enginePlatform,tested.platform,'Target Docker engine requires a different architecture; rerun tests on the target architecture');
 return {id:actual.Id,platform};
}
export function verifyInstalledImages(report,expected,scope,{docker,reuse=false}={}){
 const engine=docker(['version','--format','{{.Server.Os}}/{{.Server.Arch}}']).trim(),result={};
 for(const target of targetsFor(scope)){
  const wanted=report.images?.[target],ref=`bondbuddy-m1-${target}:${expected.commit.slice(0,12)}`;
  let actual,raw;
  try{raw=docker(['image','inspect',ref]);}catch{
   if(!reuse)throw Error('Missing tested deployment image: '+ref);
   let source;try{source=JSON.parse(docker(['image','inspect',wanted?.id??'invalid']))[0];}catch{throw Error('Tested image is unavailable locally; load the exact tested image archive: '+target);}
   verifyImageIdentity(report,expected,target,source,engine);
   docker(['tag',wanted.id,ref]);
   raw=docker(['image','inspect',ref]);
  }
  const parsed=JSON.parse(raw);assert.ok(Array.isArray(parsed)&&parsed.length===1,'Ambiguous image inspection');actual=parsed[0];
  result[target]=verifyImageIdentity(report,expected,target,actual,engine);
 }
 return result;
}
export function candidateIdentity(commit,git){
 const sha=git(['rev-parse','--verify',`${commit}^{commit}`]).toString().trim();
 return {commit:sha,tree:git(['rev-parse',`${sha}^{tree}`]).toString().trim(),
  inspectorSha256:sha256(git(['show',`${sha}:scripts/release-smoke/artifact-inspect-cli.mjs`]))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [mode,ref,filename,scope,logFile]=process.argv.slice(2);
  assert.ok(['reuse','verify','verify-rollback'].includes(mode)&&ref&&filename&&scope&&(mode!=='verify-rollback'||logFile),'Usage: verify-images.mjs reuse|verify <commit> <report> all|main|execution | verify-rollback <commit> <report> <scope> <releases.log>');
  const git=args=>execFileSync('git',args,{cwd:root,windowsHide:true}),expected=candidateIdentity(ref,git),raw=readFileSync(filename,'utf8');
  const report=mode==='verify-rollback'?verifyRollbackReport(raw,expected,readFileSync(logFile,'utf8'),Date.now(),scope==='all'?undefined:scope):verifyReport(JSON.parse(raw),expected);
  const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  const images=verifyInstalledImages(report,expected,scope,{docker,reuse:mode==='reuse'});
  process.stdout.write(JSON.stringify({commit:expected.commit,tree:expected.tree,images})+'\n');
 }catch(error){console.error('Release image gate: '+error.message);process.exitCode=1;}
}
