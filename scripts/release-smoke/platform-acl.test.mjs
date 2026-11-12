import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {hostEnvironment,protectPrivatePath} from './platform.mjs';
const env=hostEnvironment();
function shell(path,command){return execFileSync(join(env.SystemRoot||env.WINDIR,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{env:{...env,BB_ACL_TEST_PATH:path},encoding:'utf8',windowsHide:true}).trim();}
function snapshot(path){return JSON.parse(shell(path,String.raw`
$a=Get-Acl -LiteralPath $env:BB_ACL_TEST_PATH
$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
[pscustomobject]@{ownerIsCurrent=($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $me);protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object{[pscustomobject]@{principal=if($_.IdentityReference.Value -eq $me){'user'}elseif($_.IdentityReference.Value -eq 'S-1-5-18'){'system'}else{'other'};allow=($_.AccessControlType -eq 'Allow');rights=$_.FileSystemRights.ToString();inheritance=$_.InheritanceFlags.ToString();inherited=$_.IsInherited}})}|ConvertTo-Json -Depth 4 -Compress
`));}
function privatePolicy(value,directory){assert.equal(value.ownerIsCurrent,true);assert.equal(value.protected,true);assert.deepEqual(value.rules.map(r=>r.principal).sort(),['system','user']);for(const rule of value.rules){assert.equal(rule.allow,true);assert.equal(rule.rights,'FullControl');assert.equal(rule.inherited,false);assert.equal(rule.inheritance,directory?'ContainerInherit, ObjectInherit':'None');}}
function temporary(fn){const base=resolve(tmpdir()),root=mkdtempSync(join(base,'bb-release-acl-test-'));try{return fn(root);}finally{assert.ok(resolve(root).startsWith(base+sep)&&root!==base);rmSync(root,{recursive:true,force:true});}}
test('private runtime directory can be protected again without changing its owner or access policy',()=>temporary(root=>{
 const dir=join(root,'runtime');mkdirSync(dir);protectPrivatePath(dir,'directory',env);
 if(process.platform==='win32'){const before=snapshot(dir);privatePolicy(before,true);protectPrivatePath(dir,'directory',env);assert.deepEqual(snapshot(dir),before);}
 else {assert.equal(statSync(dir).mode&0o777,0o700);protectPrivatePath(dir,'directory',env);assert.equal(statSync(dir).mode&0o777,0o700);}
}));
test('private credential copies remain private after repeated protection and new children inherit no extra principals',()=>temporary(root=>{
 const dir=join(root,'runtime');mkdirSync(dir);protectPrivatePath(dir,'directory',env);const file=join(dir,'synthetic-auth.json');writeFileSync(file,'{"synthetic":true}');
 if(process.platform==='win32')assert.deepEqual(snapshot(file).rules.map(r=>r.principal).sort(),['system','user']);
 protectPrivatePath(file,'file',env);if(process.platform==='win32'){const before=snapshot(file);privatePolicy(before,false);protectPrivatePath(file,'file',env);assert.deepEqual(snapshot(file),before);}else {assert.equal(statSync(file).mode&0o777,0o444);protectPrivatePath(file,'file',env);assert.equal(statSync(file).mode&0o777,0o444);}
}));
test('an extra reader cannot silently pass private-path protection',()=>temporary(root=>{
 const file=join(root,'synthetic.txt');writeFileSync(file,'synthetic');protectPrivatePath(file,'file',env);
 if(process.platform==='win32'){
  execFileSync(join(env.SystemRoot||env.WINDIR,'System32','icacls.exe'),[file,'/grant','*S-1-5-11:(R)'],{env,windowsHide:true,stdio:'pipe'});
  assert.ok(snapshot(file).rules.some(r=>r.principal==='other'));
  try {protectPrivatePath(file,'file',env);} catch {return;}
  privatePolicy(snapshot(file),false);
 }else {protectPrivatePath(file,'file',env);assert.equal(statSync(file).mode&0o777,0o444);}
}));
