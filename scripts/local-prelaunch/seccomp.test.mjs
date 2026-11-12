import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {actualSecurityProfiles,canonicalHash,deriveLocalSeccomp,mountGuard,productionSeccompFile,seccompSources} from './seccomp.mjs';

const production=JSON.parse(readFileSync(productionSeccompFile)),derived=deriveLocalSeccomp(production);
const syscallRules=(profile,name)=>profile.syscalls.filter(rule=>rule.names.includes(name)).map(({names,...rest})=>rest);

test('every mount allowance is constrained; every other syscall has identical conditions',()=>{
  for(const name of new Set(production.syscalls.flatMap(rule=>rule.names))) {
    const before=syscallRules(production,name),after=syscallRules(derived.profile,name);
    if(name==='mount')assert.deepEqual(after,before.map(rule=>rule.action==='SCMP_ACT_ALLOW'?{...rule,args:[...(rule.args??[]),mountGuard]}:rule));
    else assert.deepEqual(after,before,`Changed unrelated syscall ${name}`);
  }
  assert.equal(derived.guardedMountRules,2);
  assert.equal(production.defaultAction,'SCMP_ACT_ERRNO');
  assert.equal(derived.profile.defaultAction,production.defaultAction);
  assert.equal(derived.profile.defaultErrnoRet,production.defaultErrnoRet);
});

test('checked-in local profile equals complete production derivation',()=>{
  const sources=seccompSources();assert.deepEqual(sources.local,derived.profile);
  assert.equal(sources.proof.allOtherRulesUnchanged,true);
  assert.throws(()=>deriveLocalSeccomp({syscalls:[{names:['mount'],action:'SCMP_ACT_ALLOW',args:[{index:3,value:1,op:'SCMP_CMP_EQ'}]}]}));
});

test('actual Docker profiles match by content despite JSON object order',()=>{
  const container=(service,profile)=>({Id:service,Config:{Labels:{'com.docker.compose.service':service}},HostConfig:{SecurityOpt:['no-new-privileges:true','seccomp='+JSON.stringify(profile)]},AppArmorProfile:''});
  const ordered=Object.fromEntries(Object.entries(derived.profile).reverse());
  assert.equal(canonicalHash(ordered),canonicalHash(derived.profile));
  const profiles=actualSecurityProfiles([container('worker',ordered),container('worker-parse',production),container('worker-review',{defaultAction:'SCMP_ACT_ALLOW',syscalls:[]})]);
  assert.equal(profiles[0].source.kind,'local-derived');assert.equal(profiles[1].source.kind,'production');assert.equal(profiles[2].source,null);
});
