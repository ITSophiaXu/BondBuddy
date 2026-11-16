// Real synthetic child processes; no supplier or real sandbox is invoked. The
// fake permission preflight below isolates adapter ordering from OS sandbox QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runCodexProcess, runContainedModelCall, classifyCodexResult, loadCodexAdapterConfig,
  assertCodexConfig, type CodexAdapterConfig, type ContainedCallInput } from './codex-adapter.js';
import { AUTHORING_IMAGE_BUDGET_SIGNAL, AUTHORING_IMAGE_MAX_BYTES, createAuthoringImageBudget } from './authoring-image-tools.js';
import { MemoryCodexJournal } from './codex-memory-journal.js';
import { saveFileAuthoringRecovery, restoreFileAuthoringWork, type FileAuthoringRecovery } from './file-authoring-recovery.js';
import type { StageContext } from './run-pipeline.js';

const complete = { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } };
const message = (text: string) => ({ type: 'item.completed', item: { type: 'agent_message', text } });
const tool = (text: string) => ({ type: 'item.completed', item: { id: 'tool', type: 'command_execution', status: 'completed', exit_code: 0, command: 'synthetic', aggregated_output: text } });
type Step = { event?: unknown; raw?: string; chunks?: string[]; repeat?: number; delay?: number; path?: string; text?: string; hang?: boolean };
async function setup(overrides: Partial<CodexAdapterConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bb-file-output-limits-')), executable = join(root, 'synthetic.mjs');
  await writeFile(executable, `import {writeFileSync} from 'node:fs';
if (process.argv.includes('sandbox')) {
  writeFileSync('scratch/permission-result','ok'); console.log('BB_FILE_PERMISSIONS_OK');
} else {
  let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;
  const steps=JSON.parse(prompt);
  writeFileSync('synthetic-pid',String(process.pid));
  for(const step of steps) {
    if(step.path)writeFileSync(step.path,step.text);
    const chunks=step.chunks?.map(value=>Buffer.from(value,'base64')) ??
      (step.raw!==undefined?[Buffer.from(step.raw)]:step.event?[Buffer.from(JSON.stringify(step.event)+'\\n')]:[]);
    for(let i=0;i<(step.repeat??1);i++)for(const chunk of chunks) {
      await new Promise(resolve=>process.stdout.write(chunk,resolve));
      if(step.delay)await new Promise(resolve=>setTimeout(resolve,step.delay));
    }
    if(step.hang)await new Promise(()=>{setInterval(()=>{},1000);});
  }
}
`);
  const config: CodexAdapterConfig = { ...loadCodexAdapterConfig({}), command: [process.execPath, executable],
    credential: { kind: 'env', name: 'BB_OUTPUT_LIMIT_SYNTHETIC_KEY' }, work_root: join(root, 'work'),
    path_env: process.env.PATH ?? '/usr/bin:/bin', timeout_ms: 10000, authoring_timeout_ms: 10000, kill_grace_ms: 50,
    file_output_limits: { event_bytes: 4096, final_message_bytes: 1024 }, exec_log_max_bytes: 1024, ...overrides };
  const run = (steps: Step[], options: Partial<Parameters<typeof runCodexProcess>[1]> = {}) => runCodexProcess(config, {
    prompt: JSON.stringify(steps), cwd: root, home: root, codexHome: root, schemaFile: null,
    ephemeral: true, resumeThreadId: null, fileAuthoring: true, captureExecLog: true, ...options });
  const input = (steps: Step[]): ContainedCallInput => ({ owner_user_id: 'owner', project_id: 'project', job_id: 'job', run_id: 'run',
    trace_id: 'run', logical_call_id: 'file-authoring-v1', prompt_snapshot_ref: 'prompt', prompt: JSON.stringify(steps),
    result_schema_version: 'synthetic-file-v1', output: { kind: 'text' },
    fileWorkspace: { prepare: async cwd => {
      await mkdir(join(cwd, 'scratch')); await mkdir(join(cwd, 'output')); await writeFile(join(cwd, 'input.json'), '{}');
    }, collect: async cwd => ({ text: await readFile(join(cwd, 'output/partial.txt'), 'utf8') }) } });
  return { root, config, run, input, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const classify = (result: Awaited<ReturnType<typeof runCodexProcess>>) => classifyCodexResult(result, text => ({ ok: true, value: text }));

test('file mode completes beyond 32 MiB cumulative stdout while retained log, message and command tail stay bounded', async () => {
  const s = await setup({ max_output_bytes: 32 * 1024 * 1024, file_output_limits: { event_bytes: 32768, final_message_bytes: 1024 } });
  try {
    const event = tool('x'.repeat(16384)), repeats = 2200;
    assert(Buffer.byteLength(JSON.stringify(event)) * repeats > 32 * 1024 * 1024);
    let observed = 0;
    const result = await s.run([{ event, repeat: repeats }, { event: message('done') }, { event: complete }], { onActivity: () => { observed++; } });
    assert.equal(result.stop, null); assert.equal(result.turn_completed, true); assert.equal(result.last_message, 'done');
    assert.equal(classify(result).outcome, 'completed'); assert.equal(result.usage.status, 'measured');
    assert.equal(observed, repeats + 2); assert.equal(result.file_diagnostics!.tools.length, 24);
    assert.equal(result.file_diagnostics!.omitted, repeats - 24);
    assert(result.file_diagnostics!.tools.every(x => String(x.output).length <= 4096));
    assert.equal(result.exec_log!.truncated, true); assert.equal(result.exec_log!.bytes.length, 1024);
  } finally { await s.cleanup(); }
});

test('non-file mode retains cumulative stdout semantics even when individual events fit', async () => {
  const s = await setup({ max_output_bytes: 256 });
  try {
    const result = await s.run([{ event: message('x'), repeat: 20 }, { event: complete }], { fileAuthoring: false });
    assert.equal(classify(result).error_code, 'MODEL_OUTPUT_TOO_LARGE'); assert.equal(result.usage.status, 'unknown');
  } finally { await s.cleanup(); }
});

test('event boundary is UTF-8 bytes, including incomplete lines across chunks, excluding the newline', async () => {
  const event = message('汉🙂'.repeat(20)), bytes = Buffer.from(JSON.stringify(event));
  for (const over of [false, true]) {
    const s = await setup({ file_output_limits: { event_bytes: bytes.length - Number(over), final_message_bytes: 200 } });
    try {
      const multibyte = bytes.indexOf(Buffer.from('汉'));
      const chunks = [bytes.subarray(0, multibyte + 1), bytes.subarray(multibyte + 1, multibyte + 2), bytes.subarray(multibyte + 2), Buffer.from('\n')].map(x => x.toString('base64'));
      const result = await s.run([{ chunks, delay: 10 }, { event: complete }]);
      assert.equal(classify(result).error_code, over ? 'MODEL_OUTPUT_TOO_LARGE' : null);
      if (!over) assert.equal(result.last_message, event.item.text, 'UTF-8 decoder must not corrupt split codepoints');
    } finally { await s.cleanup(); }
  }
});

test('an unfinished oversized JSONL event is stopped before newline or process exit', async () => {
  const s = await setup({ file_output_limits: { event_bytes: 1024, final_message_bytes: 512 } });
  try {
    const result = await s.run([{ raw: '{"type":"synthetic","data":"' }, { raw: 'a'.repeat(500), repeat: 3, delay: 10, hang: true }]);
    assert.equal(classify(result).error_code, 'MODEL_OUTPUT_TOO_LARGE'); assert.equal(result.turn_completed, false);
    assert(result.exit_code !== null || result.exit_signal !== null); assert.equal(result.usage.status, 'unknown');
    assert(result.duration_ms < 5000);
  } finally { await s.cleanup(); }
});

test('final reply has an independent byte boundary and repeated small replies retain only the last', async () => {
  const s = await setup({ file_output_limits: { event_bytes: 4096, final_message_bytes: 6 } });
  try {
    const exact = await s.run([{ event: message('汉汉'), repeat: 100 }, { event: complete }]);
    assert.equal(classify(exact).outcome, 'completed'); assert.equal(exact.last_message, '汉汉');
    const over = await s.run([{ event: message('汉汉x') }, { event: complete }]);
    assert.equal(classify(over).error_code, 'MODEL_OUTPUT_TOO_LARGE'); assert.equal(over.last_message, null);
    const measured = await s.run([{ event: complete }, { event: message('汉汉x') }]);
    assert.equal(classify(measured).error_code, 'MODEL_OUTPUT_TOO_LARGE'); assert.equal(classify(measured).usage.status, 'measured');
  } finally { await s.cleanup(); }
});

test('multiple complete events and a trailing complete line without newline are parsed independently', async () => {
  const s = await setup({ file_output_limits: { event_bytes: 128, final_message_bytes: 20 } });
  try {
    const raw = JSON.stringify(message('汉')) + '\n' + JSON.stringify(complete);
    assert(Buffer.byteLength(raw) > 128);
    const result = await s.run([{ raw }]);
    assert.equal(classify(result).outcome, 'completed'); assert.equal(result.last_message, '汉');
    const invalid = await s.run([{ raw: '{invalid}\n' }]); assert.equal(classify(invalid).error_code, 'MODEL_STREAM_BROKEN');
  } finally { await s.cleanup(); }
});

for (const failure of ['MODEL_OUTPUT_TOO_LARGE','MODEL_TIMEOUT','MODEL_PROVIDER_PAYLOAD_TOO_LARGE','MODEL_CONTEXT_ROTATION_REQUIRED'] as const)
test(`${failure} snapshots terminated work before observation and cleanup, then only audited retry restores it`, async () => {
  const s = await setup({ authoring_timeout_ms: failure==='MODEL_TIMEOUT'?3000:10000, file_output_limits: { event_bytes: 1024, final_message_bytes: 512 } });
  try {
    const journal = new MemoryCodexJournal(), saved = new Map<string, Buffer>(); let snapshots = 0, cwdSeen = '';
    let snapshot: FileAuthoringRecovery | undefined;
    const recoveryCtx = { run: { id: 'run', owner_user_id: 'owner', project_id: 'project', input_hash: 'a'.repeat(64) },
      lease: { checkpoint: {} }, checkpoint: {}, signal: new AbortController().signal,
      blobs: { put: async (key: string, bytes: Buffer) => { saved.set(key, Buffer.from(bytes)); },
        getIfExistsBounded: async (key: string, max: number) => { const bytes=saved.get(key); return bytes && bytes.length<=max ? bytes : null; } } } as unknown as StageContext;
    const input = s.input([{ path: 'output/partial.txt', text: 'synthetic partial' }, { path: 'scratch/state.json', text: '{"done":1}' }, ...(failure==='MODEL_CONTEXT_ROTATION_REQUIRED'?[{event:{type:'item.completed',item:{type:'mcp_tool_call',server:'bb_images',tool:'view_image',result:{content:[{type:'text',text:AUTHORING_IMAGE_BUDGET_SIGNAL+'. Save and continue in a fresh context.'}],isError:false}}},hang:true}]:failure==='MODEL_PROVIDER_PAYLOAD_TOO_LARGE'?[{event:{type:'error',message:'HTTP 413 Payload Too Large'},hang:true}]:[{ raw: failure==='MODEL_TIMEOUT'?'':'x'.repeat(2048), hang: true }])]);
    input.fileWorkspace!.onFailure = async (cwd, intent) => {
      snapshots++; cwdSeen = cwd; assert.equal(intent.attempt_no, 1); assert.equal(journal.observations.length, 0);
      const pid = Number(await readFile(join(cwd, 'synthetic-pid'), 'utf8'));
      assert.throws(() => process.kill(pid, 0), 'checkpoint must run only after the spawned process is gone');
      snapshot = await saveFileAuthoringRecovery(recoveryCtx, cwd, intent, { checkpoint: async (_pool, lease, stage, value) => {
        lease.checkpoint = { stages: { [stage]: value } };
      } });
      assert.ok(snapshot.files.some(file => file.path==='output/partial.txt'));
      assert.ok(snapshot.files.some(file => file.path==='scratch/state.json'));
      assert.ok(snapshot.files.some(file => file.path==='input.json'));
      for (const file of snapshot.files) assert.deepEqual(saved.get(file.key), await readFile(join(cwd, file.path)));
    };
    const first = await runContainedModelCall(input, journal, s.config);
    assert.equal(first.status, failure==='MODEL_PROVIDER_PAYLOAD_TOO_LARGE'?'failed':'needs_reconcile'); assert.equal(first.error_code, failure);
    assert.equal(first.attempts[0].usage.status, 'unknown'); assert.equal(snapshots, 1); assert.equal(journal.results.size, 0);
    await assert.rejects(readFile(join(cwdSeen, 'output/partial.txt')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(s.config.work_root), []);
    journal.prior = { call_id: first.attempts[0].call_id, attempt_no: 1, status: 'pending_reconcile', observed: true };
    assert.equal((await runContainedModelCall(input, journal, s.config)).error_code, 'MODEL_PRIOR_ATTEMPT_UNRESOLVED');
    assert.equal(journal.intents.length, 1);
    journal.prior = { ...journal.prior, status: 'failed', operator_retry: true };
    const retry = s.input([{ event: message('done') }, { event: complete }]);
    const prepare = retry.fileWorkspace!.prepare;
    retry.fileWorkspace!.prepare = async cwd => { await prepare(cwd); await restoreFileAuthoringWork(recoveryCtx, cwd, snapshot!); };
    const second = await runContainedModelCall(retry, journal, s.config);
    assert.equal(second.status, 'completed'); assert.deepEqual(second.value, { text: 'synthetic partial' });
    assert.equal(second.attempts[0].attempt_no, 2); assert.equal(journal.observations[0].observation.usage.status, 'unknown');
  } finally { await s.cleanup(); }
});

for (const failure of ['MODEL_OUTPUT_TOO_LARGE','MODEL_TIMEOUT'] as const)
test(`${failure} recovery excludes cancellation, lease loss and unrelated unknown errors`, async () => {
  for (const mode of ['cancel', 'abort_after_close', 'snapshot_failure', 'broken_stream'] as const) {
    const s = await setup({ authoring_timeout_ms: failure==='MODEL_TIMEOUT'?3000:10000, file_output_limits: { event_bytes: 1024, final_message_bytes: 512 } });
    try {
      const journal = new MemoryCodexJournal(), controller = new AbortController(); let snapshots = 0;
      const input = s.input(mode === 'cancel' ? [{ event: { type: 'thread.started', thread_id: 'thread' }, hang: true }]
        : mode === 'broken_stream' ? [{ raw: '{broken}\n', hang: true }] : [{ raw: failure==='MODEL_TIMEOUT'?'':'x'.repeat(2048), hang: true }]);
      input.signal = controller.signal;
      if (mode === 'cancel') input.onEvent = () => controller.abort();
      if (mode === 'abort_after_close') journal.storeExecLog = async () => { controller.abort(); };
      input.fileWorkspace!.onFailure = async () => { snapshots++; throw Error('synthetic save failure'); };
      const result = await runContainedModelCall(input, journal, s.config);
      assert.equal(result.error_code, mode === 'snapshot_failure' ? failure : mode === 'broken_stream' ? 'MODEL_STREAM_BROKEN' : 'MODEL_CANCELLED');
      assert.equal(snapshots, mode === 'snapshot_failure' ? 1 : 0); assert.equal(result.attempts[0].usage.status, 'unknown');
      assert.equal(journal.intents.length, 1); assert.equal(journal.observations.length, 1); assert.equal(journal.results.size, 0);
      assert.deepEqual(await readdir(s.config.work_root), []);
    } finally { await s.cleanup(); }
  }
});

test('file output limits reject invalid or unbounded host configuration', () => {
  const config = loadCodexAdapterConfig({});
  for (const limits of [{ event_bytes: 0, final_message_bytes: 1 }, { event_bytes: Infinity, final_message_bytes: 1 },
    { event_bytes: 4096, final_message_bytes: 4097 }, { event_bytes: 33 * 1024 * 1024, final_message_bytes: 1 }])
    assert.throws(() => assertCodexConfig({ ...config, file_output_limits: limits }), { code: 'MODEL_ADAPTER_CONFIG_INVALID' });
});


test('an expired context deadline never spawns the provider and has an explicit not-sent outcome',async()=>{
  const s=await setup();
  try{
    const result=await s.run([{event:message('must not run')},{event:complete}],{deadlineAt:new Date(Date.now()-1000).toISOString()});
    assert.equal(result.stop,'deadline_exceeded');assert.equal(result.exit_code,null);
    assert.equal(classify(result).outcome,'confirmed_not_sent');assert.equal(classify(result).error_code,'MODEL_TIMEOUT');
    await assert.rejects(readFile(join(s.root,'synthetic-pid')),{code:'ENOENT'});
  }finally{await s.cleanup();}
});

test('deadline expiry before intent or during persistence cannot send another model request',async()=>{
  for(const phase of ['before_intent','after_intent'] as const){
    const s=await setup(),journal=new MemoryCodexJournal(),marker=join(s.root,'provider-started');
    try{
      const input=s.input([{path:marker,text:'unexpected'},{event:message('done')},{event:complete}]);
      const prepare=input.fileWorkspace!.prepare;
      input.fileWorkspace!.prepare=async cwd=>{
        await prepare(cwd);
        input.fileWorkspace!.deadlineAt=new Date(Date.now()+(phase==='before_intent'?-1000:60000)).toISOString();
      };
      if(phase==='after_intent'){
        const record=journal.recordIntent.bind(journal);
        journal.recordIntent=async intent=>{await record(intent);input.fileWorkspace!.deadlineAt=new Date(Date.now()-1).toISOString();};
        const result=await runContainedModelCall(input,journal,s.config);
        assert.equal(result.status,'failed');assert.equal(result.error_code,'MODEL_TIMEOUT');
        assert.equal(journal.intents.length,1);assert.equal(journal.observations[0].observation.outcome,'confirmed_not_sent');
        assert.equal(journal.runtimes[0].finish_reason,'context_deadline_exhausted');
      }else{
        await assert.rejects(runContainedModelCall(input,journal,s.config),/AUTHORING_CONTEXT_DEADLINE_EXCEEDED/);
        assert.equal(journal.intents.length,0);assert.equal(journal.observations.length,0);
      }
      await assert.rejects(readFile(marker),{code:'ENOENT'});
    }finally{await s.cleanup();}
  }
});

test('a restored context uses only its remaining deadline instead of a fresh authoring timeout',async()=>{
  const s=await setup({authoring_timeout_ms:10000});
  try{
    const result=await s.run([{event:message('started'),hang:true}],{deadlineAt:new Date(Date.now()+1500).toISOString()});
    assert.equal(result.stop,'timeout');assert.equal(classify(result).error_code,'MODEL_TIMEOUT');
    assert(result.duration_ms<7000,'the old deadline must terminate the child before a fresh 10 second budget');
    assert.equal(result.turn_completed,false);
  }finally{await s.cleanup();}
});


test('eight maximum-size previews cross four contexts and finish without reporting a provider fault',async()=>{
  const s=await setup({file_output_limits:{event_bytes:512*1024,final_message_bytes:1024}});
  try{
    const journal=new MemoryCodexJournal(),objects=new Map<string,Buffer>();
    const ctx={run:{id:'run',owner_user_id:'owner',project_id:'project',input_hash:'a'.repeat(64)},lease:{checkpoint:{}},checkpoint:{},signal:new AbortController().signal,
      blobs:{put:async(key:string,bytes:Buffer)=>{objects.set(key,Buffer.from(bytes));},getIfExistsBounded:async(key:string,max:number)=>{const bytes=objects.get(key);return bytes&&bytes.length<=max?bytes:null;}}} as unknown as StageContext;
    let saved:FileAuthoringRecovery|undefined,seen=0;
    const deadlineAt=new Date(Date.now()+60000).toISOString(),data=Buffer.alloc(AUTHORING_IMAGE_MAX_BYTES,7).toString('base64');
    const inlineBytes=Buffer.byteLength(`data:image/jpeg;base64,${data}`);
    for(let context=0;context<4;context++){
      const budget=createAuthoringImageBudget(),steps:Step[]=[];
      for(let image=0;image<2;image++){
        assert.equal(budget.consume(inlineBytes),true);seen++;
        steps.push({event:{type:'item.completed',item:{type:'mcp_tool_call',server:'bb_images',tool:'view_image',result:{content:[{type:'image',mimeType:'image/jpeg',data}]}}}});
      }
      steps.push({path:'output/partial.txt',text:String(seen)});
      if(context<3){
        assert.equal(budget.consume(inlineBytes),false);
        steps.push({event:{type:'item.completed',item:{type:'mcp_tool_call',server:'bb_images',tool:'view_image',result:{isError:false,content:[{type:'text',text:AUTHORING_IMAGE_BUDGET_SIGNAL+'. Continue saved work.'}]}}},hang:true});
      }else steps.push({event:message('done')},{event:complete});
      const input=s.input(steps),prepare=input.fileWorkspace!.prepare;
      input.fileWorkspace!.deadlineAt=deadlineAt;input.fileWorkspace!.recovery=!!saved;
      input.fileWorkspace!.prepare=async cwd=>{await prepare(cwd);if(saved)await restoreFileAuthoringWork(ctx,cwd,saved);};
      input.fileWorkspace!.onFailure=async(cwd,intent)=>{saved=await saveFileAuthoringRecovery(ctx,cwd,intent,{deadlineAt,checkpoint:async(_pool,lease,stage,value)=>{lease.checkpoint={stages:{[stage]:value}};}});};
      const result=await runContainedModelCall(input,journal,s.config);
      if(context<3){
        assert.equal(result.status,'needs_reconcile');assert.equal(result.error_code,'MODEL_CONTEXT_ROTATION_REQUIRED');
        assert.equal(saved!.deadline_at,deadlineAt);
        const last=result.attempts.at(-1)!;journal.prior={call_id:last.call_id,attempt_no:last.attempt_no,status:'failed',observed:true,operator_retry:true};
      }else{assert.equal(result.status,'completed');assert.deepEqual(result.value,{text:'8'});}
    }
    assert.equal(seen,8);assert.equal(journal.intents.length,4);
    assert.deepEqual(journal.observations.slice(0,3).map(row=>[row.observation.error_code,row.observation.usage.status]),Array(3).fill(['MODEL_CONTEXT_ROTATION_REQUIRED','unknown']));
    assert.ok(journal.observations.every(row=>row.observation.error_code!=='MODEL_PROVIDER_PAYLOAD_TOO_LARGE'));
  }finally{await s.cleanup();}
});


test('deadline expiry does not invalidate a completed result that needs no provider send',async()=>{
  const s=await setup(),journal=new MemoryCodexJournal();
  try{
    const input=s.input([]);input.fileWorkspace!.deadlineAt=new Date(Date.now()-1000).toISOString();
    input.fileWorkspace!.prepare=async()=>{throw Error('completed result must not prepare a new execution');};
    journal.prior={call_id:'finished',attempt_no:1,status:'completed',observed:true};
    journal.readCompleted=async()=>({value:{text:'saved'},result_sha256:'a'.repeat(64)});
    const result=await runContainedModelCall(input,journal,s.config);
    assert.equal(result.status,'reused');assert.deepEqual(result.value,{text:'saved'});assert.equal(journal.intents.length,0);
  }finally{await s.cleanup();}
});


test('a restored deadline also bounds the capacity wait before any new intent',async()=>{
  const s=await setup(),journal=new MemoryCodexJournal();
  try{
    const input=s.input([]);input.fileWorkspace!.deadlineAt=new Date(Date.now()+1000).toISOString();
    let waits=0,wrappedAbort=false;
    Object.assign(journal,{acquireCallSlot:async(signal?:AbortSignal)=>{
      waits++;
      try{await delay(10000,undefined,{signal});}
      catch(error){
        assert.equal((error as Error).name,'AbortError');
        assert.equal((error as Error).cause,signal?.reason);
        wrappedAbort=true;
        throw error;
      }
    }});
    const started=Date.now();
    await assert.rejects(runContainedModelCall(input,journal,s.config),/AUTHORING_CONTEXT_DEADLINE_EXCEEDED/);
    assert.equal(waits,1);assert.equal(wrappedAbort,true);assert.equal(journal.intents.length,0);assert(Date.now()-started<5000);
  }finally{await s.cleanup();}
});


test('only a host-enabled recoverable authoring context treats the image control signal as normal rotation',async()=>{
  const s=await setup();
  try{
    const event={type:'item.completed',item:{type:'mcp_tool_call',server:'bb_images',tool:'view_image',result:{isError:false,content:[{type:'text',text:AUTHORING_IMAGE_BUDGET_SIGNAL+'. Saved work.'}]}}};
    const ordinary=await s.run([{event,hang:true}]);
    assert.equal(classify(ordinary).error_code,'MODEL_PROVIDER_PAYLOAD_TOO_LARGE');
    assert.equal(classify(ordinary).outcome,'failed','unrelated file routes must not acquire an unsupported pending rotation');
    const recoverable=await s.run([{event,hang:true}],{contextRotation:true});
    assert.equal(classify(recoverable).error_code,'MODEL_CONTEXT_ROTATION_REQUIRED');
    assert.equal(classify(recoverable).outcome,'pending_reconcile');
  }finally{await s.cleanup();}
});
