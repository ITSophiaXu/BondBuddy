import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

/** The requested commit decides capability. Missing report fields never do. */
export function imageContract(dockerfile){
 const bytes=Buffer.from(dockerfile),text=bytes.toString('utf8').replace(/\\\r?\n/g,' ');
 return {schema:'release-image-contract-v1',dockerfileSha256:createHash('sha256').update(bytes).digest('hex'),
  confirmation:/^\s*FROM\s+\S+(?:\s+\S+)*\s+AS\s+upload-confirmation\s*(?:#.*)?$/im.test(text)};
}
export function candidateImageContract(commit,git){return imageContract(git(['cat-file','blob',`${commit}:deploy/m1/Dockerfile`]));}
export function confirmationRequired(expected){
 const c=expected.imageContract;
 assert.ok(c?.schema==='release-image-contract-v1'&&/^[a-f0-9]{64}$/.test(c.dockerfileSha256??'')&&typeof c.confirmation==='boolean','Raw candidate image contract is required');
 return c.confirmation;
}
export function requiredImageTargets(expected){return ['api','worker','web',...(confirmationRequired(expected)?['upload-confirmation']:[])];}
export function requiresConfirmationConfiguration(scope,selection,role){
 assert.ok(['all','main','execution'].includes(scope)&&['source','active','disabled'].includes(selection)&&['disabled','execution','size-split'].includes(role),'Unknown protected confirmation configuration');
 // Main in execution/general mode only disables its old confirmation loop;
 // size-split additionally needs the new small-lane semantics on main.
 return selection==='active'||role==='size-split'||scope!=='main'&&role==='execution';
}
export function imageTargetsForRole(scope,expected,selection='source'){
 assert.ok(['all','main','execution'].includes(scope),'Unknown deployment image scope');
 assert.ok(['source','active','disabled'].includes(selection),'Unknown confirmation service selection');
 const capable=confirmationRequired(expected);
 assert.ok(selection!=='active'||capable,'Requested commit has no upload confirmation image');
 assert.ok(scope!=='main'||selection!=='active','Main role cannot run standalone upload confirmation');
 const targets=scope==='execution'?['worker']:['api','worker','web'];
 if(scope!=='main'&&capable&&selection!=='disabled')targets.push('upload-confirmation');
 return targets;
}
export function verifyImageContract(report,expected){
 const required=confirmationRequired(expected);
 if(required||report.imageContract!==undefined)assert.deepEqual(report.imageContract,expected.imageContract,'Image capability/source proof differs from the raw candidate');
 for(const target of requiredImageTargets(expected)){
  assert.match(report.images?.[target]?.id??'',/^sha256:[a-f0-9]{64}$/,'Tested image missing: '+target);
  assert.match(report.images[target].platform??'',/^linux\/(amd64|arm64)$/,'Tested platform missing: '+target);
 }
 assert.equal(new Set(requiredImageTargets(expected).map(t=>report.images[t].platform)).size,1,'Tested images have different platforms');
}
