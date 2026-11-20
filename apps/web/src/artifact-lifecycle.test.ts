import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { ApiClient, type Dto } from './api.js';
import { ArtifactDownloadTimeout, withArtifactDownload, type ArtifactDownloadLifecycle } from './download-timeout.js';
import { ArtifactDownloads } from './artifact-download.js';

const bytes = new TextEncoder().encode('Synthetic artifact download: complete verified bytes.');
const metadata = (): Dto<'ArtifactResponse'> => ({
  artifact_id: 'saved-artifact', run_id: 'saved-run', version: 3,
  media_type: 'text/plain', sha256: createHash('sha256').update(bytes).digest('hex'),
  quality_status: 'passed', delivery_status: 'available',
  download_url: '/api/v1/artifacts/saved-artifact/download?grant=synthetic',
  expires_at: '2099-01-01T00:00:00Z',
});

function fixture(t: TestContext, response: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  for (const [key, value] of Object.entries({ document: { cookie: '' }, location: { origin: 'https://bondbuddy.example' } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith('/browser-errors')) signals.push(init!.signal!);
    return response(input, init);
  });
  return { api: new ApiClient(() => assert.fail('a download must not lose the session')), signals };
}

async function drain() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

test('a saved artifact with continuing body progress finishes after the old two-minute limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let body!: ReadableStreamDefaultController<Uint8Array>, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { body = controller; },
    cancel() { cancelled = true; },
  });
  const { api, signals } = fixture(t, () => new Response(stream, { headers: { 'Content-Type': 'text/plain' } }));
  let settled = false;
  const result = api.artifactBytes(metadata(), new AbortController().signal)
    .then(blob => { settled = true; return { blob }; }, error => { settled = true; return { error }; });
  await drain();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(29_000);
    await drain();
    assert.equal(settled, false, `active artifact must remain readable after ${(i + 1) * 29} seconds`);
    assert.equal(signals[0].aborted, false);
    assert.equal(cancelled, false);
    body.enqueue(bytes.slice(Math.floor(i * bytes.length / 5), Math.floor((i + 1) * bytes.length / 5)));
    await drain();
  }
  body.close();
  const outcome = await result;
  if ('error' in outcome) throw outcome.error;
  assert.equal(outcome.blob.type, 'text/plain');
  assert.deepEqual(new Uint8Array(await outcome.blob.arrayBuffer()), bytes);
  assert.equal(stream.locked, false);
});

test('a stalled saved artifact still cancels its pending body within a finite deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes.slice(0, 4)); },
    cancel() { cancelled = true; },
  });
  const { api, signals } = fixture(t, () => new Response(stream, { headers: { 'Content-Type': 'text/plain' } }));
  const result = api.artifactBytes(metadata(), new AbortController().signal);
  const failure = assert.rejects(result, /下载准备超时/);
  await drain();
  t.mock.timers.tick(120_000);
  await failure;
  assert.equal(cancelled, true);
  assert.equal(signals[0].aborted, true);
  assert.equal(stream.locked, false);
});

for (const phase of ['metadata', 'headers', 'assembly', 'hash'] as const) test(`a stalled ${phase} stage reports its own deadline`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = withArtifactDownload(new AbortController().signal, download => download.stage(phase, () => new Promise(() => {})));
  const failed = assert.rejects(result, error => error instanceof ArtifactDownloadTimeout && error.phase === phase && error.kind === 'stage');
  t.mock.timers.tick(phase === 'hash' || phase === 'assembly' ? 30_000 : 120_000);
  await failed;
});

test('only increasing received bytes renew the idle deadline and progress cannot extend the total limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let download!: ArtifactDownloadLifecycle;
  const result = withArtifactDownload(new AbortController().signal, active => { download = active; return active.stage('body', () => new Promise(() => {})); }, { totalMs: 180_000 });
  const failure = assert.rejects(result, error => error instanceof ArtifactDownloadTimeout && error.kind === 'total' && error.phase === 'body');
  t.mock.timers.tick(60_000); download.progress(1);
  t.mock.timers.tick(60_000); download.progress(2);
  t.mock.timers.tick(60_000); await failure;

  const stalled = withArtifactDownload(new AbortController().signal, active => { download = active; return active.stage('body', () => new Promise(() => {})); });
  const idleFailure = assert.rejects(stalled, error => error instanceof ArtifactDownloadTimeout && error.kind === 'idle');
  t.mock.timers.tick(60_000); download.progress(0); download.progress(Number.NaN);
  t.mock.timers.tick(60_000); await idleFailure;
});

test('unified metadata and body stages share cancellation without inheriting the old total timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveMetadata!: (value: Response) => void, body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
  const { api, signals } = fixture(t, input => String(input).includes('/download?') ? new Response(stream, { headers: { 'Content-Type': 'text/plain' } }) : new Promise(resolve => { resolveMetadata = resolve; }));
  const result = api.downloadArtifact({ artifact_id: 'saved-artifact', version: 3, run_id: 'saved-run' });
  await drain(); t.mock.timers.tick(100_000); resolveMetadata(Response.json(metadata())); await drain();
  t.mock.timers.tick(90_000); body.enqueue(bytes); body.close();
  const file = await result;
  assert.deepEqual(new Uint8Array(await file.bytes.arrayBuffer()), bytes);
  assert.equal(signals.length, 2); assert.equal(signals[0], signals[1]);
});

test('a changed artifact pin never starts a binary request', async t => {
  const urls: string[] = [];
  const { api } = fixture(t, input => { urls.push(String(input)); return Response.json(metadata()); });
  await assert.rejects(api.downloadArtifact({ artifact_id: 'saved-artifact', version: 2, run_id: 'saved-run' }), /任务或版本无法核实/);
  assert.equal(urls.some(url => url.includes('/download?')), false);
});

test('download failure diagnostics record phase, bytes and request IDs without copying grants or native errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reports: Record<string, any>[] = [];
  let stream!: ReadableStream<Uint8Array>;
  stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 4)); } });
  const { api } = fixture(t, (input, init) => {
    if (String(input).endsWith('/browser-errors')) { reports.push(JSON.parse(String(init!.body))); throw new Error('synthetic report failed'); }
    return String(input).includes('/download?') ? new Response(stream, { headers: { 'Content-Type': 'text/plain', 'x-bb-request-id': 'binary-request' } }) : Response.json(metadata(), { headers: { 'x-bb-request-id': 'metadata-request' } });
  });
  const result = api.downloadArtifact({ artifact_id: 'saved-artifact', version: 3, run_id: 'saved-run', project_id: 'saved-project' });
  const failure = assert.rejects(result, error => error instanceof ArtifactDownloadTimeout && error.phase === 'body');
  await drain(); t.mock.timers.tick(120_000); await failure; await drain();
  assert.equal(reports.length, 1);
  const detail = JSON.parse(reports[0].message);
  assert.equal(detail.received_bytes, 4); assert.equal(detail.phase, 'body'); assert.equal(detail.code, 'timeout_idle');
  assert.deepEqual(detail.request_ids, { metadata: 'metadata-request', headers: 'binary-request' });
  assert.equal(reports[0].project_id, 'saved-project'); assert.match(reports[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(reports), /grant|synthetic report failed|download_url|stack|Synthetic artifact/);
  assert.equal(stream.locked, false);
});

test('leaving a download preserves the cancellation reason and emits no failure report', async t => {
  const calls: string[] = [], parent = new AbortController(), reason = new Error('left download page');
  const stream = new ReadableStream<Uint8Array>();
  const { api } = fixture(t, input => { calls.push(String(input)); return new Response(stream, { headers: { 'Content-Type': 'text/plain' } }); });
  const result = api.artifactBytes(metadata(), parent.signal);
  const failure = assert.rejects(result, error => error === reason);
  await drain(); parent.abort(reason); await failure;
  assert.equal(stream.locked, false); assert.equal(calls.length, 1);
});

test('the artifact path still rejects corrupt bytes, mismatched MIME and external URLs', async t => {
  const corrupted = bytes.slice(); corrupted[1] ^= 1;
  for (const [label, patch, type, content] of [
    ['corruption', {}, 'text/plain', corrupted], ['MIME', {}, 'text/html', bytes],
    ['external', { download_url: 'https://external.example/file?grant=hidden' }, 'text/plain', bytes],
  ] as const) await t.test(label, async sub => {
    const urls: string[] = [];
    const { api } = fixture(sub, input => { urls.push(String(input)); return new Response(content, { headers: { 'Content-Type': type } }); });
    await assert.rejects(api.artifactBytes({ ...metadata(), ...patch }), { code: 'DATA_UNAVAILABLE' });
    assert.equal(urls.some(url => url.startsWith('https://external.example')), false);
  });
});

for(const legacy of [false,true]) test(`${legacy?'legacy bytes':'unified download'} records verified bytes before browser handoff and ignores reporting failure`,async t=>{
  const events:string[]=[],reports:Record<string,any>[]=[];
  const {api}=fixture(t,(input,init)=>{
    if(String(input).endsWith('/browser-errors')){const report=JSON.parse(String(init!.body));reports.push(report);events.push(JSON.parse(report.message).event);throw Error('synthetic diagnostics unavailable');}
    return String(input).includes('/download?')?new Response(bytes,{headers:{'Content-Type':'text/plain','x-bb-request-id':'binary-request'}}):Response.json(metadata(),{headers:{'x-bb-request-id':'metadata-request'}});
  });
  const digest=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',async(...args:Parameters<typeof digest>)=>{const value=await digest(...args);events.push('hash_finished');return value;});
  const file=legacy?{bytes:await api.artifactBytes(metadata())}:await api.downloadArtifact({artifact_id:'saved-artifact',version:3,run_id:'saved-run'});
  let trustedClick:((event:{isTrusted:boolean})=>void)|undefined;
  const link={href:'',download:'',className:'',textContent:'',click(){events.push('click');},remove(){},addEventListener(_type:string,listener:typeof trustedClick){trustedClick=listener;}};
  Object.assign(document,{createElement:()=>link,createTextNode:()=>({}),body:{append(){}}});
  const host={replaceChildren(){},append(){},contains(){return true;}} as unknown as HTMLElement;
  const downloads=new ArtifactDownloads();t.after(()=>downloads.dispose());
  downloads.save(file.bytes,'synthetic.txt',host);trustedClick!({isTrusted:true});
  assert.deepEqual(events,['hash_finished','verified','click','auto_save_requested','save_link_clicked']);
  const detail=reports.map(report=>JSON.parse(report.message));
  assert.equal(new Set(detail.map(row=>row.download_id)).size,1);
  if('downloadId' in file)assert.equal(file.downloadId,detail[0].download_id);
  for(const row of detail){assert.equal(row.received_bytes,bytes.length);assert(row.completed.includes('body'));assert(row.completed.includes('assembly'));assert(row.completed.includes('hash'));assert.equal(row.request_ids.headers,'binary-request');if(!legacy)assert.equal(row.request_ids.metadata,'metadata-request');}
  assert.deepEqual(new Uint8Array(await file.bytes.arrayBuffer()),bytes);
});

test('a browser handoff exception remains visible and is never recorded as a requested save',async t=>{
  const reports:Record<string,any>[]=[];
  const {api}=fixture(t,(input,init)=>{if(String(input).endsWith('/browser-errors')){reports.push(JSON.parse(String(init!.body)));return new Response(null,{status:201});}return new Response(bytes,{headers:{'Content-Type':'text/plain'}});});
  const blob=await api.artifactBytes(metadata()),reason=new Error('synthetic click rejected');
  const link={href:'',download:'',click(){throw reason;},remove(){}};
  Object.assign(document,{createElement:()=>link,body:{append(){}}});
  const downloads=new ArtifactDownloads();t.after(()=>downloads.dispose());
  assert.throws(()=>downloads.save(blob,'synthetic.txt'),error=>error===reason);
  const detail=reports.map(report=>JSON.parse(report.message));
  assert.deepEqual(detail.map(row=>row.event),['verified','handoff_failed']);
  assert.equal(detail[0].download_id,detail[1].download_id);
  assert.doesNotMatch(JSON.stringify(reports),/synthetic click rejected|stack|grant/);
});
