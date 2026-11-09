import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {root} from './config.mjs';

export const productionSeccompFile=path.join(root,'deploy/m1/security/codex-seccomp.json');
export const localSeccompFile=path.join(root,'deploy/local-prelaunch/security/codex-seccomp.json');
export const mountGuard={index:3,value:14,op:'SCMP_CMP_NE'};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const canonicalHash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

// WSL has no AppArmor. Deny only mount(..., MS_NOSUID|MS_NODEV|MS_NOEXEC, ...),
// so Codex retains its empty /proc fallback instead of mounting the parent's procfs.
// Split mixed syscall rules: mount flags must never constrain unrelated syscalls.
export function deriveLocalSeccomp(production) {
  assert.ok(Array.isArray(production.syscalls),'Production seccomp syscalls missing');
  const derived=structuredClone(production);let guardedMountRules=0;
  derived.syscalls=derived.syscalls.flatMap(rule=>{
    if(rule.action!=='SCMP_ACT_ALLOW'||!rule.names.includes('mount'))return [rule];
    assert.ok(!(rule.args??[]).some(arg=>arg.index===3),'Unexpected existing mount flags constraint; review derivation');
    guardedMountRules++;
    const mount={...structuredClone(rule),names:['mount'],args:[...(rule.args??[]),{...mountGuard}]};
    const otherNames=rule.names.filter(name=>name!=='mount');
    return otherNames.length?[{...rule,names:otherNames},mount]:[mount];
  });
  assert.ok(guardedMountRules>0,'No production mount ALLOW rule found');
  return {profile:derived,guardedMountRules};
}

export function seccompSources() {
  const productionBytes=readFileSync(productionSeccompFile),localBytes=readFileSync(localSeccompFile);
  const production=JSON.parse(productionBytes),local=JSON.parse(localBytes),derived=deriveLocalSeccomp(production);
  assert.deepEqual(local,derived.profile,'Local profile must only constrain production mount ALLOW rules');
  return {production,local,proof:{productionSource:productionSeccompFile,productionSha256:createHash('sha256').update(productionBytes).digest('hex'),
    productionCanonicalSha256:canonicalHash(production),localSource:localSeccompFile,localSha256:createHash('sha256').update(localBytes).digest('hex'),
    localCanonicalSha256:canonicalHash(local),guardedMountRules:derived.guardedMountRules,mountGuard,allOtherRulesUnchanged:true,
    localBoundary:'WSL without AppArmor; production AppArmor mount policy requires separate assessment'}};
}

// Docker inspect contains the profile that Docker actually loaded, not just a path
// in the current Compose file. Match its parsed content to verified source bytes.
export function actualSecurityProfiles(items) {
  const {proof}=seccompSources();
  return items.filter(item=>item.Config.Labels['com.docker.compose.service'].startsWith('worker')).map(item=>{
    const value=(item.HostConfig.SecurityOpt??[]).find(option=>option.startsWith('seccomp='));
    let loadedCanonicalSha256=null;try{loadedCanonicalSha256=canonicalHash(JSON.parse(value?.slice(8)));}catch{}
    const source=loadedCanonicalSha256===proof.localCanonicalSha256?{path:proof.localSource,sha256:proof.localSha256,kind:'local-derived'}:
      loadedCanonicalSha256===proof.productionCanonicalSha256?{path:proof.productionSource,sha256:proof.productionSha256,kind:'production'}:null;
    return {service:item.Config.Labels['com.docker.compose.service'],containerId:item.Id,loadedCanonicalSha256,source,
      appArmorProfile:item.AppArmorProfile??null,noNewPrivileges:(item.HostConfig.SecurityOpt??[]).includes('no-new-privileges:true')};
  });
}
