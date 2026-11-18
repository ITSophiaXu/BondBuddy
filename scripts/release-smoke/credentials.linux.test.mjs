// Explicit Docker check: synthetic files only, no network and no model process.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {hostEnvironment} from './platform.mjs';

test('Linux executes the mounted LF shebang helper with synthetic credentials only',t=>{
 const image=process.env.BB_RELEASE_CREDENTIAL_TEST_IMAGE;
 assert.ok(image,'Set BB_RELEASE_CREDENTIAL_TEST_IMAGE to an existing local Node/worker image');
 const root=mkdtempSync(join(tmpdir(),'bb-release-credential-linux-'));
 t.after(()=>{assert.equal(dirname(root),tmpdir());rmSync(root,{recursive:true,force:true});});
 const helper=join(root,'helper'),auth=join(root,'synthetic-auth.json');
 writeFileSync(helper,readFileSync(join(dirname(fileURLToPath(import.meta.url)),'local-copilot-token.mjs'),'utf8').replaceAll('\r\n','\n'),{mode:0o755});
 const invoke=source=>spawnSync('docker',['run','--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--mount',`type=bind,source=${helper},target=/usr/local/bin/bb-copilot-token,readonly`,'--mount',`type=bind,source=${auth},target=/run/secrets/bb-copilot-oauth,readonly`,'--env',`BB_COPILOT_OAUTH_FILE=${source}`,'--entrypoint','/usr/local/bin/bb-copilot-token',image],{encoding:'utf8',env:hostEnvironment(),timeout:30000});
 const token='synthetic-linux-helper-credential';
 writeFileSync(auth,JSON.stringify({OPENAI_API_KEY:token}));
 const good=invoke('/run/secrets/bb-copilot-oauth');assert.equal(good.status,0,good.stderr);assert.equal(good.stdout,token);
 for(const content of ['invalid-synthetic-private-content',JSON.stringify({OPENAI_API_KEY:12})]){
  writeFileSync(auth,content);const bad=invoke('/run/secrets/bb-copilot-oauth');
  assert.equal(bad.status,1);assert.equal(bad.stdout,'');assert.equal(bad.stderr,'Local Copilot credential unavailable\n');
 }
 writeFileSync(auth,JSON.stringify({OPENAI_API_KEY:token}));
 const path=invoke('/tmp/not-the-secret');assert.equal(path.status,1);assert.equal(path.stdout,'');assert.equal(path.stderr,'Local Copilot credential unavailable\n');
});
