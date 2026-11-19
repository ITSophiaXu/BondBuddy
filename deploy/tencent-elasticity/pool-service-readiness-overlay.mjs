import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root=fileURLToPath(new URL('../..',import.meta.url));
const nodeEight='1d78ccfec024fb5484a8baeaf87d1ae13bc130f5';
const stablePreimage='f4de3d7f96a57e96079ca54f31d969b374ce7aab';
const app='apps/api/src/execution-capacity.ts';
const overlay='deploy/tencent-elasticity/node-eight-sources/api-execution-capacity.ts';
const deployedSha='b9f80d741978c4b1963e3f61a8d6eb4bbb9c33b5d10c4d6a8e46206b4c6c8957';
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
const source=(commit,path)=>git('show',`${commit}:${path}`);
const emit=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const sha=text=>createHash('sha256').update(text).digest('hex');
function slice(text,start,end){
 const head=text.indexOf(start),tail=text.indexOf(end,head+start.length);
 if(head<0||tail<0||text.indexOf(start,head+1)>=0)throw Error('POOL_READINESS_SOURCE_DRIFT');
 return text.slice(head,tail);
}
function replaceOnce(text,before,after){
 if(text.split(before).length!==2||before===after)throw Error('POOL_READINESS_SOURCE_DRIFT');
 return text.replace(before,after);
}

// Keep the published node-eight baseline immutable. Transfer only the
// readiness query and the per-capability planner input to its exact variant.
export function buildPoolServiceReadiness(candidate){
 if(ts.version!=='5.9.3')throw Error('POOL_READINESS_TYPESCRIPT_VERSION');
 const before=source(stablePreimage,app);
 let pinned=source(nodeEight,overlay);
 if(sha(emit(pinned))!==deployedSha)throw Error('POOL_READINESS_DEPLOYED_BASE_MISMATCH');
 for(const [oldStart,newStart,end] of [
  ['async function dto(', 'async function freshExecutionServices(', '\nfunction opDto('],
  ['  const nodes:ExecutionNode[]=[];', '  const nodes:ExecutionNode[]=[];', '\n  const holders='],
  ['available_run_slots:', 'available_run_slots:', '})),excluded'],
 ]){
  pinned=replaceOnce(pinned,slice(before,oldStart,end),slice(candidate,newStart,end));
 }
 return emit(pinned);
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const revision=process.argv[2];
 if(revision){
  if(!/^[a-f0-9]{40}$/.test(revision)||git('remote','get-url','origin').trim()!=='https://github.com/ITSophiaXu/BondBuddy.git')
   throw Error('POOL_READINESS_TRUSTED_SOURCE_REQUIRED');
  git('merge-base','--is-ancestor',revision,'origin/master');
 }
 process.stdout.write(buildPoolServiceReadiness(revision?source(revision,app):readFileSync(new URL('../../'+app,import.meta.url),'utf8')));
}
