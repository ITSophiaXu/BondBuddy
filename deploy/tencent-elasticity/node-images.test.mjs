import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNodeAdapter,verifyInstalledExecutionImage} from './node-adapter.mjs';
import {canonical,sha256} from './policy.mjs';

const image='sha256:'+'a'.repeat(64),other='sha256:'+'b'.repeat(64);

test('a captured local image requires its complete exact inspect ID without RepoDigests or pull',async()=>{
  const calls=[];
  await verifyInstalledExecutionImage(image,async args=>{calls.push(args);return image;});
  assert.deepEqual(calls,[['image','inspect','--format','{{.Id}}',image]]);
});

test('a different, missing or abbreviated inspected local ID rejects admission',async()=>{
  for(const result of [other,'','a'.repeat(12),JSON.stringify([image]),JSON.stringify(image)])
    await assert.rejects(verifyInstalledExecutionImage(image,async()=>result),/NODE_IMAGE_NOT_INSTALLED/);
  let calls=0;
  await assert.rejects(verifyInstalledExecutionImage(image,async()=>{calls++;throw Error('synthetic inspect unavailable');}),/synthetic inspect unavailable/);
  assert.equal(calls,1,'inspect failure must not retry or pull');
});

test('tags, short IDs and malformed pins are rejected before any Docker operation',async()=>{
  let calls=0;
  for(const ref of ['synthetic/image:latest','synthetic/image','a'.repeat(12),'a'.repeat(64),
    'sha256:'+'a'.repeat(63),'sha256:'+'A'.repeat(64),image+' ',image+'\n',null,{},
    'synthetic/image@sha256:'+'a'.repeat(63)])
    await assert.rejects(verifyInstalledExecutionImage(ref,async()=>{calls++;return image;}),/NODE_IMAGE_DIGEST_REQUIRED/);
  assert.equal(calls,0);
});

test('repository digests retain exact RepoDigests membership rather than a local ID match',async()=>{
  const ref='synthetic/image@'+image,calls=[];
  await verifyInstalledExecutionImage(ref,async args=>{calls.push(args);return JSON.stringify([ref]);});
  assert.deepEqual(calls,[['image','inspect','--format','{{json .RepoDigests}}',ref]]);
  for(const digests of [null,[],['synthetic/other@'+image],['synthetic/image@'+other],{Id:image}])
    await assert.rejects(verifyInstalledExecutionImage(ref,async()=>JSON.stringify(digests)),/NODE_IMAGE_NOT_INSTALLED/);
});

test('the actual adapter retains bundle and compose gates before inspecting each service image',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'execution-image-test-'));
  try{
    const services=[{service_id:'authoring',capabilities:['authoring']},{service_id:'review',capabilities:['review']}];
    const images={authoring:image,review:other},compose='synthetic compose',calls=[];
    const config={runtime_uid:1000,image_sha256:sha256(canonical(images)),images,services,
      compose_file:'/opt/bondbuddy/compose.yaml',compose_sha256:sha256(compose)};
    const adapter=createNodeAdapter(config,{enrollmentBroker:{},runDocker:async args=>{calls.push(args);return image;}});
    // Test-local file only. All successful-image setup remains outside this test.
    config.compose_file=join(dir,'compose.yaml');await writeFile(config.compose_file,compose);
    const envelope={services,image_sha256:config.image_sha256};
    await assert.rejects(adapter.runtime.verifyArtifacts({...envelope,image_sha256:'c'.repeat(64)}),/NODE_IMAGE_BUNDLE/);
    await writeFile(config.compose_file,'changed');
    await assert.rejects(adapter.runtime.verifyArtifacts(envelope),/NODE_COMPOSE_CHANGED/);
    assert.equal(calls.length,0);
    await writeFile(config.compose_file,compose);
    await assert.rejects(adapter.runtime.verifyArtifacts(envelope),/NODE_IMAGE_NOT_INSTALLED/);
    assert.deepEqual(calls,[['image','inspect','--format','{{.Id}}',image],['image','inspect','--format','{{.Id}}',other]]);
  }finally{await rm(dir,{recursive:true});}
});
