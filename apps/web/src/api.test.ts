import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { ApiClient, ApiError, friendlyError, parseApiError, type Dto } from './api.js';
import { UPLOAD_BYTES_PENDING_FIELD_ERROR } from '@bondbuddy/contracts';
import { PROSPECTUS_DOCX_ONLY_FIELD_ERROR, PROSPECTUS_DOCX_ONLY_MESSAGE, SOURCE_PROSPECTUS_REQUIRED_FIELD_ERROR, SOURCE_PROSPECTUS_REQUIRED_MESSAGE } from '@bondbuddy/contracts';

test('pending bytes requires its exact field/code and 422 envelope, without any inspection failure', () => {
  assert.equal(parseApiError(422, { code: 'MATERIAL_UNREADABLE', field_errors: [UPLOAD_BYTES_PENDING_FIELD_ERROR] }).details.uploadBytesPending, true);
  for (const [status, body] of [
    [503, { code: 'MATERIAL_UNREADABLE', field_errors: [UPLOAD_BYTES_PENDING_FIELD_ERROR] }],
    [422, { code: 'VALIDATION_FAILED', field_errors: [UPLOAD_BYTES_PENDING_FIELD_ERROR] }],
    [422, { code: 'MATERIAL_UNREADABLE', field_errors: [] }],
    [422, { code: 'MATERIAL_UNREADABLE', field_errors: [{ ...UPLOAD_BYTES_PENDING_FIELD_ERROR, field: 'other' }] }],
    [422, { code: 'MATERIAL_UNREADABLE', field_errors: [UPLOAD_BYTES_PENDING_FIELD_ERROR, { field: 'material_upload', code: 'structure_invalid' }] }],
  ] as const) assert.equal(parseApiError(status, body).details.uploadBytesPending, undefined);
});

test('missing source uses the public field code instead of server prose', () => {
  const error = parseApiError(422, {code: 'INPUT_REQUIRED', message: 'untrusted server prose', field_errors: [SOURCE_PROSPECTUS_REQUIRED_FIELD_ERROR]});
  assert.equal(friendlyError(error), SOURCE_PROSPECTUS_REQUIRED_MESSAGE);
  const unrelated = parseApiError(422, {code: 'INPUT_REQUIRED', field_errors: [{...SOURCE_PROSPECTUS_REQUIRED_FIELD_ERROR, field: 'other'}]});
  assert.equal(unrelated.details.sourceProspectusRequired, false);
});
import { PROSPECTUS_SELECTION_REQUIRED_FIELD_ERROR, PROSPECTUS_SELECTION_REQUIRED_MESSAGE, type M4Artifact } from '@bondbuddy/contracts';

test('Word-only upload errors use the public reason without trusting server prose', () => {
  const error=parseApiError(422,{code:'MATERIAL_FORMAT_UNSUPPORTED',message:'private detail',
    field_errors:[{...PROSPECTUS_DOCX_ONLY_FIELD_ERROR,message:'untrusted replacement'}]});
  assert.equal(friendlyError(error),PROSPECTUS_DOCX_ONLY_MESSAGE);
  assert.equal(uploadErrorMessage(error),PROSPECTUS_DOCX_ONLY_MESSAGE);
  const unrelated=parseApiError(422,{code:'VALIDATION_FAILED',field_errors:[PROSPECTUS_DOCX_ONLY_FIELD_ERROR]});
  assert.equal(unrelated.details.prospectusDocxOnly,undefined);
});

test('unselected prospectus errors explain adoption without trusting server prose', () => {
  const error = parseApiError(409, {code:'INPUT_REVISION_CONFLICT',message:'private server message',
    field_errors:[{...PROSPECTUS_SELECTION_REQUIRED_FIELD_ERROR,message:'untrusted replacement'}]});
  assert.equal(error.code, 'INPUT_REVISION_CONFLICT');
  assert.equal(error.details.prospectusSelectionRequired, true);
  assert.equal(friendlyError(error), PROSPECTUS_SELECTION_REQUIRED_MESSAGE);
  assert.doesNotMatch(friendlyError(error), /private|untrusted|其他页面/);
});

test('only the prospectus field/code pair under input conflict selects the recovery message', () => {
  for (const fields of [undefined, {}, [null, [], 'invalid'],
    [{field:'wrong',code:PROSPECTUS_SELECTION_REQUIRED_FIELD_ERROR.code}],
    [{field:PROSPECTUS_SELECTION_REQUIRED_FIELD_ERROR.field,code:'UNKNOWN',message:PROSPECTUS_SELECTION_REQUIRED_MESSAGE}],
  ]) {
    const error = parseApiError(409, {code:'INPUT_REVISION_CONFLICT',message:PROSPECTUS_SELECTION_REQUIRED_MESSAGE,field_errors:fields});
    assert.equal(error.details.prospectusSelectionRequired, undefined);
    assert.match(friendlyError(error), /其他页面修改/);
  }
  const unrelated = parseApiError(422, {code:'VALIDATION_FAILED',field_errors:[PROSPECTUS_SELECTION_REQUIRED_FIELD_ERROR]});
  assert.equal(unrelated.details.prospectusSelectionRequired, undefined);
  assert.doesNotMatch(friendlyError(unrelated), /用于本次更新/);
});

test('an active source-project run has a safe business message distinct from draft version conflict',()=>{
  const error=parseApiError(409,{code:'PROJECT_RUN_ACTIVE',message:'Synthetic private worker path or provider detail must not reach the UI'});
  assert.match(friendlyError(error),/同一来源项目已有任务正在执行/);assert.match(friendlyError(error),/草稿保留/);assert.doesNotMatch(friendlyError(error),/其他页面|worker|provider|Synthetic/);
  assert.match(friendlyError(new ApiError(409,'INPUT_REVISION_CONFLICT')),/其他页面修改/);
});
test('workpaper conflicts use bounded reasons and never server prose or foreign field markers',()=>{
  for(const [reason,expected] of [['current_item_active',/当前文件尚未结束/],['other_batch_active',/其他底稿文件包/],['source_task_active',/其他任务尚未结束/]] as const){
    const error=parseApiError(409,{code:'PROJECT_RUN_ACTIVE',message:'private provider path',field_errors:[{field:'workpaper_batch',code:reason,message:'untrusted prose'}]});
    assert.match(friendlyError(error),expected);assert.doesNotMatch(friendlyError(error),/private|provider|untrusted/);
  }
  for(const [code,field,reason] of [['PROJECT_RUN_ACTIVE','wrong','current_item_active'],['PROJECT_RUN_ACTIVE','workpaper_batch','private'],['INPUT_REVISION_CONFLICT','workpaper_batch','current_item_active']]){
    assert.equal(parseApiError(409,{code,field_errors:[{field,code:reason}]}).details.workpaperConflict,undefined);
  }
});
import { uploadErrorMessage } from './upload-error.js';

test('start limits describe the recovery action without trusting server prose', () => {
  for (const [limit, expected] of [
    ['active_runs_per_user', /等待已有任务完成/],
    ['global_active_runs', /系统当前处理的任务/],
    ['runs_per_user_per_day', /次日重试/],
    ['model_tokens_per_user_per_day', /次日重试/],
  ] as const) {
    const error = parseApiError(429, {code:'TRIAL_QUOTA_EXCEEDED',message:'private server detail',correlation_id:'synthetic-quota',
      field_errors:[{field:'trial_limit',code:limit,message:'untrusted replacement'}]});
    assert.equal(error.details.trialLimit, limit);
    const message = friendlyError(error);
    assert.match(message, expected);
    assert.match(message, /材料和要求保留/);
    assert.match(message, /不会因这次拒绝扣费/);
    assert.match(message, /synthetic-quota/);
    assert.doesNotMatch(message, /private|untrusted|操作未完成|充值/);
  }
  for (const fields of [[], [{field:'trial_limit',code:'<script>'}], [{field:'wrong',code:'global_active_runs'}]]) {
    const error = parseApiError(429, {code:'TRIAL_QUOTA_EXCEEDED',field_errors:fields});
    assert.equal(error.details.trialLimit, undefined);
    assert.match(friendlyError(error), /当前处理上限/);
    assert.doesNotMatch(friendlyError(error), /<script>/);
  }
  assert.match(friendlyError(new ApiError(403, 'TRIAL_ACCESS_DENIED')), /账号暂不能开始新任务/);
  assert.match(friendlyError(new ApiError(503, 'MODEL_CALLS_SUSPENDED')), /系统暂时停止接受/);
  assert.match(friendlyError(new ApiError(409, 'BILLING_PROTOCOL_REPLAY_ONLY')), /刷新页面后重新开始/);
});

test('material input errors name missing fields without exposing server messages or diagnostic IDs',()=>{
  const error=parseApiError(422,{code:'INPUT_REQUIRED',message:'private server detail',correlation_id:'internal-reference',field_errors:[
    {field:'market',code:'M4_MARKET_REQUIRED',message:'untrusted replacement'},
    {field:'template',code:'M4_TEMPLATE_REQUIRED',message:'untrusted replacement'},
    {field:'market',code:'UNKNOWN',message:'secret'},
    {field:'broker',code:'M4_MARKET_REQUIRED',message:'wrong target'},
  ]});
  assert.equal(error.details.materialInputIssues?.length,2);
  assert.match(friendlyError(error),/尚未选择交易所/);assert.match(friendlyError(error),/尚未提供立项模板/);
  assert.match(friendlyError(error),/补齐后请重新点击生成/);
  assert.doesNotMatch(friendlyError(error),/private|untrusted|secret|internal-reference|错误编号/);
});

test('public inspection detail is carried from Error.field_errors to the upload row', () => {
  const error = parseApiError(422, {
    code: 'MATERIAL_UNREADABLE', retryable: false, correlation_id: 'synthetic-upload-1',
    field_errors: [{ field: 'material_upload', code: 'external_link_invalid', message: 'opaque' }],
  });
  assert.equal(error.details.uploadReason, 'external_link_invalid');
  assert.match(uploadErrorMessage(error), /外部工作簿引用/);
  assert.match(uploadErrorMessage(error), /保留原文件/);
  assert.match(uploadErrorMessage(error), /错误编号：synthetic-upload-1/);
  assert.doesNotMatch(uploadErrorMessage(error), /文件.*损坏|重新导出/);
});

test('timeout is a temporary inspection failure; missing and untrusted details never imply corruption', () => {
  const timeout = parseApiError(422, {
    code: 'MATERIAL_UNREADABLE', retryable: true, correlation_id: 'synthetic-timeout',
    field_errors: [{ field: 'material_upload', code: 'inspection_timeout', message: 'opaque' }],
  });
  assert.match(uploadErrorMessage(timeout), /稍后重试此文件/);
  for (const payload of [
    { code: 'MATERIAL_UNREADABLE', correlation_id: 'synthetic-unknown' },
    { code: 'MATERIAL_UNREADABLE', correlation_id: '<script>', field_errors: [{ field: 'material_upload', code: '<script>' }] },
  ]) {
    const message = uploadErrorMessage(parseApiError(422, payload));
    assert.match(message, /保留原文件/);
    assert.doesNotMatch(message, /损坏|重新导出|<script>/);
  }
  const unrelated = parseApiError(409, {
    code: 'MATERIAL_UNREADABLE', correlation_id: 'synthetic-run',
    field_errors: [{ field: 'material', code: 'external_link_invalid' }],
  });
  assert.equal(unrelated.details.uploadReason, undefined);
  assert.match(friendlyError(unrelated), /核对材料状态/);
});

test('unknown start failures retain reference and distinguish transient from permanent', () => {
  const temporary = friendlyError(parseApiError(503, {
    code: 'DATA_UNAVAILABLE', retryable: true, correlation_id: 'synthetic-start-503',
  }));
  assert.match(temporary, /结果尚未确认.*刷新项目状态/);
  assert.match(temporary, /错误编号：synthetic-start-503/);
  assert.doesNotMatch(temporary, /填写内容/);
  const permanent = friendlyError(parseApiError(409, { code: 'INPUT_REQUIRED', correlation_id: 'synthetic-start-409' }));
  assert.match(permanent, /尚未满足执行条件/);
  assert.match(permanent, /错误编号：synthetic-start-409/);
  assert.doesNotMatch(permanent, /稍后重试/);
});

const sourceBytes = new TextEncoder().encode('Synthetic original source: 原始材料 100.00\n');
function sourceMaterial(): Dto<'MaterialResponse'> {
  return { material_id:'material/source',material_version:2,upload_id:'upload-source',role:'audit',filename:'source.txt',
    media_type:'text/plain',byte_size:sourceBytes.byteLength,sha256:createHash('sha256').update(sourceBytes).digest('hex'),
    state:'persisted',persisted_at:'2026-10-03T00:00:00Z',error:null };
}
function stubDownload(t:TestContext, reply:()=>Response) {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{cookie:''}});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'document',descriptor);else Reflect.deleteProperty(globalThis,'document');});
  const calls:{url:string;init:RequestInit}[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    calls.push({url:String(input),init:init??{}});return reply();
  });
  return {api:new ApiClient(()=>assert.fail('download must not lose the session')),calls};
}

test('material download returns exact verified Blob bytes through the same-origin project route',async t=>{
  const material=sourceMaterial(),signal=new AbortController().signal;
  const {api,calls}=stubDownload(t,()=>new Response(sourceBytes,{status:200,headers:{'Content-Type':'text/plain; charset=utf-8'}}));
  const blob=await api.materialBytes('project a',material,signal);
  assert(blob instanceof Blob);assert.equal(blob.type,material.media_type);assert.equal(blob.size,sourceBytes.byteLength);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),sourceBytes);
  assert.equal(calls.length,1);assert.equal(calls[0]!.url,'/api/v1/projects/project%20a/materials/material%2Fsource/download?version=2');
  assert.equal(calls[0]!.init.method,'GET');assert.equal(calls[0]!.init.credentials,'same-origin');
  assert.equal(calls[0]!.init.cache,'no-store');assert(calls[0]!.init.signal instanceof AbortSignal);assert.equal(calls[0]!.init.signal.aborted,false);
});

const sourceM4Artifact = (): M4Artifact => ({
  source_project_id:'source-project',artifact_id:'artifact/source',artifact_version:3,sha256:sourceMaterial().sha256,
  topic_id:'source-topic',run_id:'source-run',document_type:'annual',kind:'document',filename:'source.docx',
  mime_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',byte_size:sourceBytes.byteLength,
  created_at:'2026-10-03T00:00:00Z',base_artifact:null,input_hash:'a'.repeat(64),revision_number:1,
});
const sourceDownloads = [
  {name:'material',type:'text/plain',read:(api:ApiClient,signal:AbortSignal)=>api.materialBytes('project a',sourceMaterial(),signal)},
  {name:'M4 artifact',type:sourceM4Artifact().mime_type,read:(api:ApiClient,signal:AbortSignal)=>api.m4ArtifactBytes(sourceM4Artifact(),signal)},
];
const drainDownload = async () => { for(let i=0;i<10;i++)await Promise.resolve(); };

for(const source of sourceDownloads){
  test(`an active ${source.name} download can finish and verify after more than two minutes`,async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    let body!:ReadableStreamDefaultController<Uint8Array>,cancelled=false;
    const stream=new ReadableStream<Uint8Array>({start(controller){body=controller;},cancel(){cancelled=true;}});
    const {api,calls}=stubDownload(t,()=>new Response(stream,{headers:{'Content-Type':source.type}}));
    const parent=new AbortController();let settled=false;
    const result=source.read(api,parent.signal).then(blob=>{settled=true;return {blob};},error=>{settled=true;return {error};});
    await drainDownload();assert.equal(stream.locked,true);
    // Five real response chunks arrive over 150 seconds of controlled time.
    // Original materials and M4 files must not inherit the workpaper deadline.
    for(let i=0;i<5;i++){
      t.mock.timers.tick(30_000);await drainDownload();
      assert.equal(settled,false,`${source.name} must remain readable after ${(i+1)*30} seconds`);
      assert.equal(calls[0].init.signal?.aborted,false);assert.equal(cancelled,false);
      body.enqueue(sourceBytes.slice(Math.floor(i*sourceBytes.length/5),Math.floor((i+1)*sourceBytes.length/5)));
      await drainDownload();
    }
    body.close();const outcome=await result;if('error' in outcome)throw outcome.error;
    assert.equal(outcome.blob.type,source.type);
    assert.deepEqual(new Uint8Array(await outcome.blob.arrayBuffer()),sourceBytes);
    assert.equal(calls.length,1);assert.equal(stream.locked,false);
  });

  test(`leaving a ${source.name} download cancels a pending body and permits a verified retry`,async t=>{
    const reason=new Error('left download page');let cancelled:unknown,retry=false;
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(sourceBytes.slice(0,4));},cancel(value){cancelled=value;}});
    const {api,calls}=stubDownload(t,()=>new Response(retry?sourceBytes:stream,{headers:{'Content-Type':source.type}}));
    const parent=new AbortController(),download=source.read(api,parent.signal);
    await drainDownload();assert.equal(stream.locked,true);
    const failure=assert.rejects(download,error=>error===reason);
    parent.abort(reason);await failure;
    assert.equal(cancelled,reason);assert.equal(calls[0].init.signal?.aborted,true);assert.equal(stream.locked,false);
    retry=true;const blob=await source.read(api,new AbortController().signal);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),sourceBytes);assert.equal(calls.length,2);
  });
}

test('artifact metadata that never finishes does not hold a download action indefinitely',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {api,calls}=stubDownload(t,()=>new Response(new ReadableStream(),{headers:{'Content-Type':'application/json'}}));
  const metadata=api.artifact('saved-artifact');
  const failure=assert.rejects(metadata,/下载准备超时.*无需重新生成/);
  t.mock.timers.tick(120_000);await failure;
  assert.equal(calls[0].init.signal?.aborted,true);
});

test('material download rejects same-length corrupted bytes whose hash differs',async t=>{
  const corrupted=sourceBytes.slice();corrupted[corrupted.length-2]^=1;
  const {api}=stubDownload(t,()=>new Response(corrupted,{status:200,headers:{'Content-Type':'text/plain'}}));
  await assert.rejects(()=>api.materialBytes('project a',sourceMaterial()),error=>error instanceof ApiError&&error.code==='DATA_UNAVAILABLE');
});

test('material download rejects truncated and empty responses',async t=>{
  for(const bytes of [sourceBytes.slice(0,-1),new Uint8Array()])await t.test(`received ${bytes.byteLength} bytes`,async sub=>{
    const {api}=stubDownload(sub,()=>new Response(bytes,{status:200,headers:{'Content-Type':'text/plain'}}));
    await assert.rejects(()=>api.materialBytes('project a',sourceMaterial()),error=>error instanceof ApiError&&error.code==='DATA_UNAVAILABLE');
  });
});

test('material download preserves a server denial for a material outside the requested project',async t=>{
  const {api,calls}=stubDownload(t,()=>new Response(JSON.stringify({code:'NOT_FOUND'}),{status:404,headers:{'Content-Type':'application/json'}}));
  await assert.rejects(()=>api.materialBytes('other project',sourceMaterial()),error=>error instanceof ApiError&&error.status===404);
  assert.equal(calls.length,1);assert.equal(calls[0]!.url,'/api/v1/projects/other%20project/materials/material%2Fsource/download?version=2');
});

test('material download never requests bytes for an upload that has not been persisted',async t=>{
  const {api,calls}=stubDownload(t,()=>{throw Error('unpersisted material must not be requested');});
  await assert.rejects(()=>api.materialBytes('project a',{...sourceMaterial(),state:'uploading'}),error=>error instanceof ApiError&&error.code==='DATA_UNAVAILABLE');
  assert.equal(calls.length,0);
});

test('material download rejects a partial response or a substituted content type',async t=>{
  for(const [status,type] of [[206,'text/plain'],[200,'text/html']] as const)await t.test(`${status} ${type}`,async sub=>{
    const {api}=stubDownload(sub,()=>new Response(sourceBytes,{status,headers:{'Content-Type':type}}));
    await assert.rejects(()=>api.materialBytes('project a',sourceMaterial()),error=>error instanceof ApiError&&error.code==='DATA_UNAVAILABLE');
  });
});

test('workpaper ZIP reports received bytes and returns the complete streamed archive',async t=>{
  const first=new Uint8Array(24).fill(1),last=new Uint8Array(37).fill(2);
  const {api,calls}=stubDownload(t,()=>new Response(new ReadableStream({start(c){c.enqueue(first);c.enqueue(last);c.close();}}),{headers:{'Content-Type':'application/zip'}}));
  const progress:number[]=[],bytes=await api.workpaperZip('source project','batch',new AbortController().signal,n=>progress.push(n));
  assert.deepEqual(progress,[0,24,61]);assert.equal(bytes.size,61);
  assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()),new Uint8Array([...first,...last]));
  assert.equal(calls[0]!.url,'/api/v1/projects/source%20project/workpapers/batches/batch/download');
});

test('a broken ZIP response body is never offered as a finished download',async t=>{
  const {api}=stubDownload(t,()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(30));c.error(new Error('connection lost'));}}),{headers:{'Content-Type':'application/zip'}}));
  await assert.rejects(api.workpaperZip('project','batch',new AbortController().signal,()=>{}),/connection lost/);
});

test('ZIP progress uses only reliable lengths and rejects truncated archives',async t=>{
  for(const encoding of [undefined,'gzip'])await t.test(encoding??'identity',async sub=>{
    const {api}=stubDownload(sub,()=>new Response(new Uint8Array(64),{headers:{'content-type':'application/zip','content-length':'64',...(encoding?{'content-encoding':encoding}:{})}}));
    const progress:Array<[number,number|undefined]>=[];
    await api.workpaperZip('project','batch',new AbortController().signal,(received,total)=>progress.push([received,total]));
    assert.deepEqual(progress,[[0,encoding?undefined:64],[64,encoding?undefined:64]]);
  });
  await t.test('truncated',async sub=>{
    const {api}=stubDownload(sub,()=>new Response(new Uint8Array(32),{headers:{'content-type':'application/zip','content-length':'64'}}));
    await assert.rejects(api.workpaperZip('project','batch',new AbortController().signal,()=>{}),error=>error instanceof ApiError&&error.code==='DATA_UNAVAILABLE');
  });
});
