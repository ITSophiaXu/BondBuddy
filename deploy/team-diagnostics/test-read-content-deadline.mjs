import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

// Runs the actual helper body in an isolated VM, with no SDK, files, network or
// production credentials. Only the SDK and clock are synthetic dependencies.
const helper = process.env.BB_DIAG_HELPER_PATH ?? fileURLToPath(new URL('./read-content.mjs', import.meta.url));
const source = readFileSync(helper, 'utf8').replace(/^import .*;\r?$/gm, '');
const secret = 'synthetic-secret-never-export';
function fixture(kind='exec', length=1024) {
  const head = Buffer.from(`synthetic ${kind} 中文 ${secret}\n`);
  const bytes = Buffer.concat([head, Buffer.alloc(length-head.length, 0x2e)]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const suffix = kind==='exec' ? 'runs/run/attempts/attempt/exec.log'
    : kind==='prompt' ? 'snapshots/snapshot' : `provider-results/attempt-${sha256}.json`;
  return {bytes, row: {kind, owner_user_id:'owner', project_id:'project', run_id:'run', attempt_id:'attempt',
    object_key:'users/owner/projects/project/'+suffix, sha256, byte_size:bytes.length}};
}
async function read({kind='exec', length=1024, delays=[0], mutate={}, propertyLength, changedEtag=false, sdkError=false, streamExtra=false}={}) {
  const data = fixture(kind,length), row = {...data.row,...mutate};
  let now=0, nextTimer=0, stdout='', stderr='', downloads=0, propertyReads=0;
  const timers=new Map(), sdkCalls=[];
  const advance = ms => {
    const until=now+ms;
    for(const [id,timer] of [...timers].sort((a,b)=>a[1].at-b[1].at)) {
      if(timer.at<=until && timers.has(id)){now=timer.at;timers.delete(id);timer.callback();}
    }
    now=until;
  };
  const guard = signal => {if(signal.aborted)throw new Error('synthetic SDK aborted '+secret);};
  const blob = {
    async getProperties({abortSignal}) {propertyReads++;guard(abortSignal);return {contentLength:propertyLength??data.bytes.length,etag:'synthetic-etag'};},
    async download(offset,count,{abortSignal,conditions}) {
      downloads++; assert.equal(offset,0);assert.equal(count,data.bytes.length+1);assert.equal(conditions.ifMatch,'synthetic-etag');
      if(changedEtag || sdkError)throw Error('synthetic storage error URL?sig='+secret);
      const sliceLength=Math.ceil(data.bytes.length/delays.length);
      return {readableStreamBody:(async function*(){
        for(let i=0;i<delays.length;i++){advance(delays[i]);guard(abortSignal);yield data.bytes.subarray(i*sliceLength,Math.min((i+1)*sliceLength,data.bytes.length));}
        if(streamExtra)yield Buffer.from('extra');
      })()};
    },
  };
  const BlobServiceClient={fromConnectionString(value){sdkCalls.push(value);return {getContainerClient(name){assert.equal(name,'bondbuddy-private');return {getBlockBlobClient(key){assert.equal(key,row.object_key);return blob;}};}};}};
  const processStub={argv:['node','-',JSON.stringify(row)],env:{AZURE_STORAGE_CONNECTION_STRING:'synthetic-connection-string',SYNTHETIC_SECRET:secret},exitCode:0,
    stdout:{write(value){stdout+=value;}},stderr:{write(value){stderr+=value;}}};
  const context=vm.createContext({createRequire:()=>()=>({BlobServiceClient}),createHash,Buffer,AbortController,
    process:processStub,setTimeout(callback,ms){const id=++nextTimer;timers.set(id,{at:now+ms,callback});return id;},clearTimeout(id){timers.delete(id);}});
  await new vm.Script(`(async()=>{\n${source}\n})()`,{filename:helper}).runInContext(context);
  assert.equal(timers.size,0,'helper always clears its deadline');
  assert(!stdout.includes(secret) && !stderr.includes(secret),'synthetic credentials never leave the helper');
  return {exitCode:processStub.exitCode,stdout,stderr,downloads,propertyReads,elapsed:now,expected:data.bytes.toString('utf8').replace(secret,'[redacted]'),sdkCalls};
}

for(const [length,delays] of [[7_766_789,[20_000,20_000]],[20_970_480,[30_000,30_000,30_000]]]) {
  test(`synthetic complete exec ${length} bytes remains readable after 35 seconds`,async()=>{
    const result=await read({length,delays});assert.equal(result.exitCode,0);assert.equal(result.stdout,result.expected);
  });
}
test('synthetic exec beyond 120 seconds has a fixed safe timeout classification',async()=>{
  const result=await read({delays:[120_001]});assert.equal(result.exitCode,3);assert.equal(result.stderr,'CONTENT_READ_TIMEOUT\n');assert.equal(result.stdout,'');
});
for(const kind of ['prompt','result']) {
  test(`${kind} keeps its existing 35 second deadline and generic failure`,async()=>{
    const result=await read({kind,delays:[35_001]});assert.equal(result.exitCode,2);assert.equal(result.stderr,'CONTENT_UNAVAILABLE_OR_INTEGRITY_FAILED\n');assert.equal(result.stdout,'');
  });
  test(`${kind} immediate complete content and environment redaction unchanged`,async()=>{
    const result=await read({kind});assert.equal(result.exitCode,0);assert.equal(result.stdout,result.expected);
  });
}
for(const [name,options] of [
  ['wrong owner prefix',{mutate:{owner_user_id:'other'}}],
  ['wrong project prefix',{mutate:{project_id:'other'}}],
  ['wrong run key',{mutate:{run_id:'other'}}],
  ['wrong attempt key',{mutate:{attempt_id:'other'}}],
  ['path traversal',{mutate:{object_key:'users/owner/projects/project/../other/exec.log'}}],
  ['wrong SHA256',{mutate:{sha256:'0'.repeat(64)}}],
  ['wrong expected size',{mutate:{byte_size:1025}}],
  ['property length exceeds 20 MiB',{propertyLength:20*1024*1024+1}],
  ['stream exceeds declared size',{streamExtra:true}],
  ['ETag changed before read',{changedEtag:true}],
  ['unrelated storage exception',{sdkError:true}],
]) {
  test(`exec still denies ${name} with safe generic failure`,async()=>{
    const result=await read(options);assert.equal(result.exitCode,2);assert.equal(result.stdout,'');assert.equal(result.stderr,'CONTENT_UNAVAILABLE_OR_INTEGRITY_FAILED\n');
    if(/prefix|key|traversal/.test(name)){assert.equal(result.downloads,0);assert.equal(result.sdkCalls.length,0);}
  });
}
test('exec immediate valid bytes keep full SHA check and credential redaction',async()=>{
  const result=await read();assert.equal(result.exitCode,0);assert.equal(result.stdout,result.expected);assert.equal(result.downloads,1);
});
