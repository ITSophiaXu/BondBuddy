import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {selectReleaseCredential,prepareReleaseCredential,assertReleaseCredential} from './credentials.mjs';
import {parseLocalCopilotAuth,readLocalCopilotToken,CREDENTIAL_TARGET,LOCAL_CREDENTIAL_ERROR} from './local-copilot-token.mjs';
import {hostEnvironment} from './platform.mjs';

const directory=dirname(fileURLToPath(import.meta.url));
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'bb-release-credential-'));
 t.after(()=>{assert.equal(dirname(root),tmpdir());rmSync(root,{recursive:true,force:true});});
 const out=join(root,'run');mkdirSync(out);
 const source=join(root,'synthetic-auth.json');
 const token='synthetic-local-credential-for-tests';
 writeFileSync(source,JSON.stringify({OPENAI_API_KEY:token,unrelated:'do-not-copy'}));
 const protectedPaths=[];
 const prepare=(options={})=>prepareReleaseCredential({out,directory,sourceEnv:{BB_RELEASE_COPILOT_AUTH_FILE:source},hostEnv:{},protect:(...args)=>protectedPaths.push(args),...options});
 return {root,out,source,token,prepare,protectedPaths};
}

test('OAuth stays default; direct credentials require an explicit nonempty path',()=>{
 assert.equal(selectReleaseCredential({}, {}, '/synthetic-home').mode,'copilot-oauth-exchange');
 const selected=selectReleaseCredential({copilotAuthFile:'settings-auth',copilotOAuthFile:'oauth'},{BB_RELEASE_COPILOT_AUTH_FILE:'explicit-auth'});
 assert.equal(selected.source,'explicit-auth');assert.equal(selected.mode,'existing-local-codex-command-helper');
 for(const value of ['', ' ', '\0bad', 12, null])assert.throws(()=>selectReleaseCredential({copilotAuthFile:value},{}),/Invalid local credential/);
});

test('JSON validation rejects missing, non-string, whitespace/control and malformed credentials without echo',()=>{
 const marker='synthetic-private-marker';
 for(const text of [marker,'{'+marker,'null','[]','{}',JSON.stringify({OPENAI_API_KEY:12}),JSON.stringify({OPENAI_API_KEY:''}),JSON.stringify({OPENAI_API_KEY:'has space'}),JSON.stringify({OPENAI_API_KEY:'line\nfeed'}),JSON.stringify({OPENAI_API_KEY:'\u007f'}),JSON.stringify({OPENAI_API_KEY:'x'.repeat(16385)})]){
  assert.throws(()=>parseLocalCopilotAuth(text),error=>error.message===LOCAL_CREDENTIAL_ERROR&&!error.message.includes(marker));
 }
 assert.equal(parseLocalCopilotAuth('\uFEFF'+JSON.stringify({OPENAI_API_KEY:marker})),marker);
});

test('local staging copies only the key, protects the copy and records read-only helper evidence',t=>{
 const f=fixture(t),staged=f.prepare();
 assert.deepEqual(JSON.parse(readFileSync(join(f.out,'copilot-auth.json'),'utf8')),{OPENAI_API_KEY:f.token});
 assert.deepEqual(f.protectedPaths,[[join(f.out,'copilot-auth.json'),'file',{}]]);
 assert.equal(staged.volumes.length,2);
 assert.ok(staged.volumes.every(m=>m.read_only===true&&m.bind.create_host_path===false));
 assert.equal(staged.report.credentialMode,'existing-local-codex-command-helper');
 assert.match(staged.report.credentialAdaptation.sha256,/^[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(staged.report).includes(f.token));
 assert.ok(!JSON.stringify(staged.report).includes(f.source));
 assert.ok(!readFileSync(join(f.out,'local-copilot-token.mjs'),'utf8').includes('\r'));
 assertReleaseCredential(staged.report,{services:{worker:{volumes:staged.volumes}}},f.out);
});

test('invalid explicit local credentials fail without falling back to available OAuth',t=>{
 const f=fixture(t);writeFileSync(f.source,'malformed-synthetic-private-value');
 const oauth=join(f.root,'synthetic-oauth');writeFileSync(oauth,'synthetic-oauth-token');
 assert.throws(()=>f.prepare({settings:{copilotOAuthFile:oauth}}),error=>error.message==='Local Copilot auth JSON is unavailable or invalid');
 assert.equal(f.protectedPaths.length,0);
});

test('OAuth staging leaves the default helper intact and never creates local adaptation evidence',t=>{
 const f=fixture(t);writeFileSync(f.source,'synthetic-oauth-token');
 const staged=f.prepare({sourceEnv:{BB_RELEASE_COPILOT_OAUTH_FILE:f.source}});
 assert.deepEqual(staged.report,{credentialMode:'copilot-oauth-exchange'});
 assert.equal(staged.volumes.length,1);
 assert.equal(readFileSync(join(f.out,'copilot-oauth'),'utf8'),'synthetic-oauth-token');
 assertReleaseCredential(staged.report,{services:{worker:{volumes:staged.volumes}}},f.out);
});

test('helper reads only its fixed secret target and sanitizes source/JSON failures',async t=>{
 const f=fixture(t);let reads=0;
 const read=async(path)=>{reads++;assert.equal(path,CREDENTIAL_TARGET);return readFileSync(f.source,'utf8');};
 assert.equal(await readLocalCopilotToken(CREDENTIAL_TARGET,read),f.token);
 await assert.rejects(readLocalCopilotToken(f.source,read),{message:LOCAL_CREDENTIAL_ERROR});assert.equal(reads,1);
 await assert.rejects(readLocalCopilotToken(CREDENTIAL_TARGET,async()=>{throw Error(f.token);}),{message:LOCAL_CREDENTIAL_ERROR});
 const child=spawnSync(process.execPath,[join(directory,'local-copilot-token.mjs')],{encoding:'utf8',env:{...hostEnvironment(),BB_COPILOT_OAUTH_FILE:f.source}});
 assert.equal(child.status,1);assert.equal(child.stdout,'');assert.equal(child.stderr,LOCAL_CREDENTIAL_ERROR+'\n');
});

test('resume refuses modified helper bytes, writable mounts and changing OAuth into local fallback',t=>{
 const f=fixture(t),staged=f.prepare(),compose={services:{worker:{volumes:staged.volumes}}};
 assert.throws(()=>assertReleaseCredential({credentialMode:'copilot-oauth-exchange'},compose,f.out),/Unexpected credential helper/);
 assert.throws(()=>assertReleaseCredential({...staged.report,credentialMode:'unknown'},compose,f.out),/Unknown/);
 const writable=structuredClone(compose);writable.services.worker.volumes[1].read_only=false;
 assert.throws(()=>assertReleaseCredential(staged.report,writable,f.out),/mounts/);
 const changed={...staged.report,credentialAdaptation:{...staged.report.credentialAdaptation,sha256:'0'.repeat(64)}};
 assert.throws(()=>assertReleaseCredential(changed,compose,f.out),/unavailable or changed/);
});
