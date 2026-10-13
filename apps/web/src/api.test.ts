import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { ApiClient, ApiError, friendlyError, parseApiError, type Dto } from './api.js';

test('an active source-project run has a safe business message distinct from draft version conflict',()=>{
  const error=parseApiError(409,{code:'PROJECT_RUN_ACTIVE',message:'Synthetic private worker path or provider detail must not reach the UI'});
  assert.match(friendlyError(error),/同一来源项目已有任务正在执行/);assert.match(friendlyError(error),/草稿保留/);assert.doesNotMatch(friendlyError(error),/其他页面|worker|provider|Synthetic/);
  assert.match(friendlyError(new ApiError(409,'INPUT_REVISION_CONFLICT')),/其他页面修改/);
});
import { uploadErrorMessage } from './upload-error.js';

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
  assert.equal(calls.length,1);assert.equal(calls[0]!.url,'/api/v1/projects/project%20a/materials/material%2Fsource/download');
  assert.equal(calls[0]!.init.method,'GET');assert.equal(calls[0]!.init.credentials,'same-origin');
  assert.equal(calls[0]!.init.cache,'no-store');assert.equal(calls[0]!.init.signal,signal);
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
  assert.equal(calls.length,1);assert.equal(calls[0]!.url,'/api/v1/projects/other%20project/materials/material%2Fsource/download');
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
