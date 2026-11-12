import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dependencyOptions,dependencyDockerfile,dependencyBuildArgs,assertNodeBaseUnchanged} from './dependencies.mjs';
import {sha256} from './support.mjs';
const original=readFileSync(new URL('../../deploy/m1/Dockerfile',import.meta.url),'utf8');
const cached={nodeImage:'local-node:fixture',cachedCodex:'/opt/cache/openai-codex-0.167.0-linux-x64.tgz',pipIndexUrl:'https://packages.example/pypi/simple/'};
test('default dependency selection leaves the Dockerfile and build arguments unchanged',()=>{
 assert.deepEqual(dependencyDockerfile(original,{}),{text:original,originalSha256:sha256(Buffer.from(original))});
 assert.deepEqual(dependencyBuildArgs({}),[]);
});
test('explicit cache changes only acquisition and reports both Dockerfile hashes',()=>{
 const result=dependencyDockerfile(original,cached);
 assert.equal(result.text.replace('cp "'+cached.cachedCodex+'" "openai-codex-${CODEX_VERSION}-${pkg}.tgz";','npm pack "@openai/codex@${CODEX_VERSION}-${pkg}" --silent >/dev/null;'),original);
 assert.equal(result.originalSha256,sha256(Buffer.from(original)));
 assert.equal(result.adaptation.dockerfileSha256,sha256(Buffer.from(result.text)));
 assert.deepEqual(dependencyBuildArgs(cached),['--build-arg','NODE_IMAGE=local-node:fixture','--build-arg','PIP_INDEX_URL=https://packages.example/pypi/simple/']);
});
test('cache cannot bypass changed acquisition, SHA512 verification or CLI version checks',()=>{
 for(const candidate of [original.replace('npm pack','npm fetch'),original+'\nnpm pack "@openai/codex@${CODEX_VERSION}-${pkg}" --silent >/dev/null;',original.replace('[ "$got" = "$want" ]','true'),original.replace("createHash('sha512')","createHash('sha256')"),original.replace('codex-cli ${CODEX_VERSION}','codex-cli other')])assert.throws(()=>dependencyDockerfile(candidate,cached));
});
test('dependency overrides reject traversal, shell text, credential URLs and implicit cache use',()=>{
 for(const options of [
  {cachedCodex:cached.cachedCodex},
  {nodeImage:'https://user:secret@example/image'}, {nodeImage:'node:22; touch /tmp/x'}, {nodeImage:'user@private/image'},
  ...['/tmp/file.tgz','/opt/../secret.tgz','/opt/cache/../../secret.tgz','/opt//file.tgz','/opt/./file.tgz','/opt/a";echo.tgz','C:/cache/file.tgz','/opt/cache/file.zip'].map(cachedCodex=>({...cached,cachedCodex})),
  ...['http://example/pypi','https://user:secret@example/pypi','https://example/pypi?token=synthetic','https://example/pypi#secret'].map(pipIndexUrl=>({pipIndexUrl})),
 ])assert.throws(()=>dependencyOptions(options));
});
test('base image identity must remain fixed through builds',()=>{
 const record={id:'sha256:'+'a'.repeat(64)};assertNodeBaseUnchanged(record,record.id);
 for(const id of ['sha256:'+'b'.repeat(64),'','unvalidated'])assert.throws(()=>assertNodeBaseUnchanged(record,id));
 assert.throws(()=>assertNodeBaseUnchanged({id:'invalid'},'invalid'));
});
