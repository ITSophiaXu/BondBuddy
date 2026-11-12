import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyImageIdentity,verifyInstalledImages,targetsFor} from './verify-images.mjs';
import {imageContract} from './image-contract.mjs';
const expected={commit:'a'.repeat(40),tree:'b'.repeat(40)},id='sha256:'+'c'.repeat(64);
expected.imageContract=imageContract('FROM scratch AS worker\n');
const report={sha:expected.commit,tree:expected.tree,images:Object.fromEntries(['api','worker','web'].map(t=>[t,{id,platform:'linux/amd64'}]))};
const actual=()=>({Id:id,Os:'linux',Architecture:'amd64',Config:{Labels:{'org.opencontainers.image.revision':expected.commit}}});
test('actual immutable image identity, source revision, platform and engine must all match',()=>{
 assert.deepEqual(verifyImageIdentity(report,expected,'api',actual(),'linux/amd64'),{id,platform:'linux/amd64'});
 for(const mutate of [a=>a.Id='sha256:'+'d'.repeat(64),a=>a.Architecture='arm64',a=>a.Os='windows',a=>a.Config.Labels['org.opencontainers.image.revision']='d'.repeat(40)]){
  const image=actual();mutate(image);assert.throws(()=>verifyImageIdentity(report,expected,'api',image,'linux/amd64'));
 }
 assert.throws(()=>verifyImageIdentity(report,expected,'api',actual(),'linux/arm64'));
});
test('reuse tags only the exact existing tested ID; it never pulls or builds',()=>{
 const calls=[],tags=new Set();
 const docker=args=>{
  calls.push(args);
  if(args[0]==='version')return 'linux/amd64';
  if(args[0]==='tag'){assert.equal(args[1],id);tags.add(args[2]);return '';}
  assert.deepEqual(args.slice(0,2),['image','inspect']);
  if(args[2]!==id&&!tags.has(args[2]))throw Error('missing');
  return JSON.stringify([actual()]);
 };
 const result=verifyInstalledImages(report,expected,'main',{docker,reuse:true});
 assert.deepEqual(Object.keys(result),['api','worker','web']);assert.equal(calls.filter(a=>a[0]==='tag').length,3);
 assert.ok(calls.every(a=>['version','image','tag'].includes(a[0])));
});
test('drifting tags, malformed inventories and unavailable tested images cannot be replaced or rebuilt',()=>{
 for(const mode of ['drift','malformed','missing']){
  const calls=[],docker=args=>{calls.push(args);if(args[0]==='version')return 'linux/amd64';
   if(mode==='missing')throw Error('missing');if(mode==='malformed')return '{}';
   return JSON.stringify([{...actual(),Id:'sha256:'+'d'.repeat(64)}]);};
  assert.throws(()=>verifyInstalledImages(report,expected,'execution',{docker,reuse:true}));
  assert.ok(calls.every(a=>!['tag','pull','build'].includes(a[0])));
 }
 assert.deepEqual(targetsFor('execution',expected),['worker']);assert.throws(()=>targetsFor('other',expected));
});
test('verification mode cannot create missing release tags',()=>{
 const calls=[],docker=args=>{calls.push(args);if(args[0]==='version')return 'linux/amd64';throw Error('missing');};
 assert.throws(()=>verifyInstalledImages(report,expected,'all',{docker}),/Missing tested deployment image/);
 assert.equal(calls.length,2);
});
