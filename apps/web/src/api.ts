import {runRecoverableBillingRequest,observeAutomaticQuotes} from './billing-task-recovery.js';
import {readDownloadBytes,type DownloadProgress} from './download-progress.js';
import {schemas as uploadSchemas,WorkpaperZipPreparationSchema,type WorkpaperZipPreparation} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {BILLING_WIRE_HEADER,BILLING_WIRE_VERSION,LEGACY_BILLING_WIRE_VERSION,billingWireRoute,encodeBillingDto,validateBillingDto} from '@bondbuddy/contracts';
import { UserFacingError, unknownErrorText, type ErrorOperation } from './user-facing-error.js';
import type { Static } from '@sinclair/typebox';
import type { schemas, SchemaName, DataPolicy, AgreementResponse } from './billing-types.js';
import type { FactDecisionRequest } from '@bondbuddy/contracts';
import type {SubscriptionCatalog,SubscriptionAccount,SubscriptionCheckoutRequest,SubscriptionCheckout,Subscription,SubscriptionAutoRenewRequest,SubscriptionAutoRenew,SubscriptionChangeQuoteRequest,SubscriptionChangeCheckoutRequest} from './billing-types.js';
import { isProspectusDocxOnlyFieldError, PROSPECTUS_DOCX_ONLY_MESSAGE, isUploadInspectionPublicReason, isProspectusSelectionRequiredFieldError, isSourceProspectusRequiredFieldError, SOURCE_PROSPECTUS_REQUIRED_MESSAGE, PROSPECTUS_SELECTION_REQUIRED_MESSAGE, m4InputIssue, PROJECT_TASK_COUNTS_CAPABILITY, TRIAL_LIMIT_KINDS, TRIAL_LIMIT_ERROR_FIELD, type TrialLimitKind, type M4InputIssue, type UploadInspectionPublicReason } from '@bondbuddy/contracts';

export type Dto<K extends SchemaName> = Static<(typeof schemas)[K]>;
const UPLOAD_CONFIRMATION_TIMEOUT_MS = 600_000;
export class ApiError extends Error {
  constructor(public status: number, public code: string, public readonly details: {
    correlationId?: string; retryable?: boolean; uploadReason?: UploadInspectionPublicReason; materialInputIssues?: M4InputIssue[]; trialLimit?: TrialLimitKind; prospectusSelectionRequired?: boolean; sourceProspectusRequired?: boolean; prospectusDocxOnly?: boolean;
  } = {}) { super(code); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseApiError(status: number, value: unknown, fallbackCode = 'DATA_UNAVAILABLE'): ApiError {
  if (!isRecord(value)) return new ApiError(status, fallbackCode);
  const problem = value;
  const code = typeof problem.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(problem.code) ? problem.code : fallbackCode;
  const correlationId = typeof problem.correlation_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(problem.correlation_id)
    ? problem.correlation_id : undefined;
  const fields: unknown[] = Array.isArray(problem.field_errors) ? problem.field_errors : [];
  let uploadReason: UploadInspectionPublicReason | undefined;
  let trialLimit: TrialLimitKind | undefined;
  if (code === 'TRIAL_QUOTA_EXCEEDED') for (const field of fields) {
    if (isRecord(field) && field.field === TRIAL_LIMIT_ERROR_FIELD &&
        TRIAL_LIMIT_KINDS.includes(field.code as TrialLimitKind)) {
      trialLimit = field.code as TrialLimitKind;
      break;
    }
  }
  if (code === 'MATERIAL_UNREADABLE') for (const field of fields) {
    if (isRecord(field) && field.field === 'material_upload' && isUploadInspectionPublicReason(field.code)) {
      uploadReason = field.code;
      break;
    }
  }
  return new ApiError(status, code, {
    ...(code === 'MATERIAL_FORMAT_UNSUPPORTED' && fields.some(isProspectusDocxOnlyFieldError)
      ? { prospectusDocxOnly: true } : {}),
    ...(code === 'INPUT_REVISION_CONFLICT' && fields.some(isProspectusSelectionRequiredFieldError)
      ? { prospectusSelectionRequired: true } : {}),
    ...(code === 'INPUT_REQUIRED' ? { sourceProspectusRequired: fields.some(isSourceProspectusRequiredFieldError), materialInputIssues: fields.flatMap(field => {
      if (!isRecord(field)) return [];
      const issue = m4InputIssue(field.code, field.field);
      return issue ? [issue] : [];
    }) } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(typeof problem.retryable === 'boolean' ? { retryable: problem.retryable } : {}),
    ...(uploadReason ? { uploadReason } : {}),
    ...(trialLimit ? { trialLimit } : {}),
  });
}

export function errorReference(error: ApiError): string {
  return error.details.correlationId ? ` 错误编号：${error.details.correlationId}。` : '';
}

export function friendlyError(error: unknown, operation: ErrorOperation = 'action'): string {
  if (error instanceof UserFacingError) return error.message;
  if (!(error instanceof ApiError)) return unknownErrorText(operation);
  const reference = errorReference(error);
  switch (error.code) {
    case 'MATERIAL_FORMAT_UNSUPPORTED': return error.details.prospectusDocxOnly
      ? PROSPECTUS_DOCX_ONLY_MESSAGE : '文件格式不受支持，请选择此分区支持的文件。';
    case 'INPUT_REVISION_CONFLICT': return error.details.prospectusSelectionRequired
      ? PROSPECTUS_SELECTION_REQUIRED_MESSAGE
      : '这个项目已在其他页面修改。你的输入仍保留，请查看最新版本后再修改。';
    case 'PROJECT_RUN_ACTIVE': return '同一来源项目已有任务正在执行。本次未开始，草稿保留。请在任务进度与结果查看任务，等待完成或停止后明确执行。';
    case 'UNAUTHENTICATED': return '登录已失效，请重新登录。';
    case 'NOT_FOUND': return '无法访问这个项目，它可能已移除或不属于当前账号。';
    case 'RATE_LIMITED': return '尝试次数过多，请稍后再试。';
    case 'TRIAL_QUOTA_EXCEEDED': {
      const limit = error.details.trialLimit;
      const reason = limit === 'active_runs_per_user' ? '当前账号同时处理的任务已达上限，请等待已有任务完成后再次开始。'
        : limit === 'global_active_runs' ? '系统当前处理的任务已达上限，请稍后再次开始。'
        : limit === 'runs_per_user_per_day' || limit === 'model_tokens_per_user_per_day' ? '当前账号今日处理额度已用完，请次日重试或联系支持。'
        : '已达到当前处理上限，请稍后重试；持续无法开始时请联系支持。';
      return `${reason} 已保存的材料和要求保留；本次操作未开始，不会因这次拒绝扣费。${reference}`;
    }
    case 'TRIAL_ACCESS_DENIED': return `当前账号暂不能开始新任务，请联系支持核对。已保存的材料和要求保留。${reference}`;
    case 'MODEL_CALLS_SUSPENDED': return `系统暂时停止接受新的处理任务，请稍后重试。已保存的材料和要求保留。${reference}`;
    case 'BILLING_PROTOCOL_REPLAY_ONLY': return `页面版本已更新，请刷新页面后重新开始。已保存的材料和要求保留；本次任务未开始。${reference}`;
    case 'CSRF_DENIED': return '会话验证未通过，请刷新页面后重试。';
    case 'VALIDATION_FAILED': return `请检查填写内容后重试。${reference}`;
    case 'INPUT_REQUIRED': return error.details.sourceProspectusRequired ? SOURCE_PROSPECTUS_REQUIRED_MESSAGE : error.details.materialInputIssues?.length
      ? `${error.details.materialInputIssues.map(issue => issue.message).join(' ')} 补齐后请重新点击生成。`
      : `本次输入尚未满足执行条件，请核对项目材料；仍无法继续时联系支持。${reference}`;
    case 'MATERIAL_UNREADABLE': return `材料尚未满足当前处理条件，请保留原文件并核对材料状态。${reference}`;
    case 'CAPABILITY_NOT_READY': return `这项功能暂未开放，请联系支持。${reference}`;
    case 'CREDITS_INSUFFICIENT': return '积分不足，本次任务尚未开始。请通过原任务入口补足积分后继续。';
    case 'QUOTE_REQUIRED': return '请查看本次任务报价后确认开始。';
    case 'QUOTE_CHANGED': return '价格或项目输入已变化，请查看新报价后重新确认。';
    case 'QUOTE_EXPIRED': return '报价已过期，本次未开始、未扣费。准备内容保留，请重新申请范围报价。';
    case 'QUOTE_UNAVAILABLE': return '当前范围暂无法承接，本次未开始、未扣费。请查看报价原因或调整准备内容。';
    case 'QUOTE_DECLINED': return '本报价已拒绝，本次未开始、未扣费。准备内容保留，可重新申请范围报价。';
    case 'BILLING_NOT_READY': return '积分价格尚未配置，请联系支持；本次未扣费。';
    case 'PAYMENT_UNAVAILABLE': return '充值渠道暂不可用，请稍后重试。项目材料已保留。';
    case 'PAYMENT_INVALID': return '支付结果尚未核实，请刷新订单状态；无需重复付款。';
    case 'SUBSCRIPTION_CHANGE_QUOTE_STALE': return '可抵扣积分已变化或付款摘要已过期，请刷新付款摘要。';
    case 'SUBSCRIPTION_CHANGE_MANDATE_PENDING': return '原自动续费仍在解除核对中，请稍后继续同一付款请求；尚未生成新订单。';
    case 'PASSWORD_INVALID': return '当前密码不正确。';
    case 'ACCOUNT_CLOSURE_BLOCKED': return '还有任务尚未结束，暂时不能注销账号。';
    case 'PROJECT_DELETE_BLOCKED': return '项目中还有任务尚未结束，暂时不能删除。';
    case 'DATA_UNAVAILABLE': return error.status >= 500
      ? `服务暂时无法完成操作，结果尚未确认。请刷新项目状态；仍无法继续时联系支持。${reference}`
      : `当前结果无法核实，请刷新后联系支持。${reference}`;
    default: return error.details.retryable || error.status >= 500
      ? `操作结果尚未确认，请刷新项目状态后重试。${reference}`
      : `操作未完成，请核对当前状态；仍无法继续时联系支持。${reference}`;
  }
}

type RequestUploadProgress={progress:(loaded:number,total:number)=>void;uploaded?:()=>void};

export class ApiClient {
  /** Authenticated binary imports keep the same response/error/401 handling as JSON requests. */
  uploadRequest<T>(path:string,file:File,progress:RequestUploadProgress['progress'],signal:AbortSignal,uploaded?:()=>void){
    return this.request<T>('POST',path,file,{'Content-Type':'application/octet-stream'},signal,{progress,uploaded});
  }
  private sendUpload(method:string,path:string,file:Blob,headers:Record<string,string>,signal:AbortSignal,upload:RequestUploadProgress):Promise<Response>{
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();let timer:ReturnType<typeof setTimeout>|undefined;let transferred=false;
      const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
      const fail=(error:unknown)=>{clean();reject(error);};
      const abort=()=>{xhr.abort();fail(signal.reason??new DOMException('Aborted','AbortError'));};
      xhr.upload.addEventListener('progress',e=>{if(!signal.aborted)upload.progress(e.loaded,e.lengthComputable?e.total:file.size);});
      const uploaded=()=>{if(signal.aborted||transferred)return;transferred=true;upload.progress(file.size,file.size);upload.uploaded?.();timer=setTimeout(()=>{fail(new ApiError(0,'DATA_UNAVAILABLE'));xhr.abort();},120_000);};
      xhr.upload.addEventListener('load',uploaded);
      xhr.addEventListener('load',()=>{uploaded();clean();if(signal.aborted){reject(signal.reason);return;}const responseHeaders=new Headers();for(const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)){const index=line.indexOf(':');if(index>0)responseHeaders.append(line.slice(0,index),line.slice(index+1).trim());}resolve(new Response(xhr.status===204?null:xhr.responseText,{status:xhr.status,statusText:xhr.statusText,headers:responseHeaders}));});
      xhr.addEventListener('error',()=>fail(new ApiError(0,'DATA_UNAVAILABLE')));
      xhr.addEventListener('abort',()=>fail(signal.aborted?signal.reason:new ApiError(0,'DATA_UNAVAILABLE')));
      signal.addEventListener('abort',abort,{once:true});
      try{xhr.open(method,'/api/v1'+path);xhr.withCredentials=true;for(const [key,value] of Object.entries(headers))xhr.setRequestHeader(key,value);upload.progress(0,file.size);signal.throwIfAborted();xhr.send(file);}catch(error){fail(error);}
    });
  }

  subscriptionCatalog(signal?:AbortSignal){return this.request<SubscriptionCatalog>('GET','/subscriptions/catalog',undefined,{},signal);}
  subscriptionAccount(signal?:AbortSignal){return this.request<SubscriptionAccount>('GET','/subscriptions/account',undefined,{},signal);}
  createSubscription(input:SubscriptionCheckoutRequest,signal?:AbortSignal){return this.request<SubscriptionCheckout>('POST','/subscriptions',input,{},signal);}
  renewSubscription(id:string,input:SubscriptionCheckoutRequest,signal?:AbortSignal){return this.request<SubscriptionCheckout>('POST',`/subscriptions/${encodeURIComponent(id)}/renew`,input,{},signal);}
  subscriptionChangeQuote(input:SubscriptionChangeQuoteRequest,signal?:AbortSignal){return this.request<Dto<'SubscriptionChangeQuoteResponse'>>('POST','/subscriptions/change-quotes',input,{},signal);}
  subscriptionChangeCheckout(input:SubscriptionChangeCheckoutRequest,signal?:AbortSignal){return this.request<Dto<'SubscriptionChangeCheckoutResponse'>>('POST','/subscriptions/change-checkouts',input,{},signal);}
  cancelSubscription(id:string,input:{request_id:string},signal?:AbortSignal){return this.request<Subscription>('POST',`/subscriptions/${encodeURIComponent(id)}/cancel`,input,{},signal);}
  subscriptionAutoRenew(id:string,input:SubscriptionAutoRenewRequest,signal?:AbortSignal){return this.request<SubscriptionAutoRenew>('POST',`/subscriptions/${encodeURIComponent(id)}/auto-renew`,input,{},signal);}
  refreshSubscriptionAutoRenew(id:string,signal?:AbortSignal){return this.request<SubscriptionAutoRenew>('POST',`/subscriptions/${encodeURIComponent(id)}/auto-renew/refresh`,{}, {},signal);}
  projectTasks(id:string,cursor?:string,signal?:AbortSignal){return this.request<Dto<'ProjectTasksResponse'>>('GET','/projects/'+encodeURIComponent(id)+'/tasks'+(cursor?'?cursor='+encodeURIComponent(cursor):''),undefined,{[PROJECT_TASK_COUNTS_CAPABILITY.header]:PROJECT_TASK_COUNTS_CAPABILITY.value},signal);}
  commerceCatalog(signal?:AbortSignal){return this.request<Dto<'CommerceCatalogResponse'>>('GET','/commerce/catalog',undefined,{},signal);}
  commerceAccount(signal?:AbortSignal){return this.request<Dto<'CommerceAccountResponse'>>('GET','/commerce/account',undefined,{},signal);}
  commerceTopup(input:Dto<'CommerceTopupRequest'>,signal?:AbortSignal){return this.request<Dto<'RechargeOrderResponse'>>('POST','/commerce/topups',input,{},signal);}
  commerceOrder(id:string,signal?:AbortSignal){return this.request<Dto<'RechargeOrderResponse'>>('GET',`/commerce/topups/${encodeURIComponent(id)}`,undefined,{},signal);}
  commerceRefresh(id:string,signal?:AbortSignal){return this.request<Dto<'RechargeOrderResponse'>>('POST',`/commerce/topups/${encodeURIComponent(id)}/refresh`,{}, {},signal);}
  commerceFeedback(input:Dto<'CommerceFeedbackRequest'>,signal?:AbortSignal){return this.request<Dto<'CommerceFeedbackResponse'>>('POST','/commerce/feedback',input,{},signal);}
  projectFiles(id:string,signal?:AbortSignal){return this.request<Dto<'ProjectFilesResponse'>>('GET','/projects/'+encodeURIComponent(id)+'/files',undefined,{},signal);}
  consumptionHistory(cursor?:string,signal?:AbortSignal){return this.request<Dto<'CreditConsumptionHistoryResponse'>>('GET','/credits/consumption-history'+(cursor?'?cursor='+encodeURIComponent(cursor):''),undefined,{},signal);}
  rechargeHistory(cursor?:string,signal?:AbortSignal){return this.request<Dto<'RechargeHistoryResponse'>>('GET','/credits/recharge-history'+(cursor?'?cursor='+encodeURIComponent(cursor):''),undefined,{},signal);}
  creditBalance(signal?: AbortSignal) { return this.request<Dto<'CreditBalanceResponse'>>('GET','/credits/balance',undefined,{},signal); }
  creditQuote(id: string, input: Dto<'FixedQuoteRequest'>, signal?: AbortSignal) {
    return this.request<Dto<'FixedQuoteResponse'>>('POST',`/projects/${encodeURIComponent(id)}/credit-quote`,input,{},signal);
  }
  runCharge(id: string, signal?: AbortSignal) { return this.request<Dto<'RunCreditChargeResponse'>>('GET',`/runs/${encodeURIComponent(id)}/credit-charge`,undefined,{},signal); }
  rechargeConfig(signal?: AbortSignal) { return this.request<Dto<'RechargeConfigResponse'>>('GET','/credits/recharge-config',undefined,{},signal); }
  createRecharge(input: Dto<'RechargeOrderRequest'>, signal?: AbortSignal) { return this.request<Dto<'RechargeOrderResponse'>>('POST','/credits/recharge-orders',input,{},signal); }
  rechargeOrder(id: string, signal?: AbortSignal) { return this.request<Dto<'RechargeOrderResponse'>>('GET',`/credits/recharge-orders/${encodeURIComponent(id)}`,undefined,{},signal); }
  refreshRecharge(id: string, signal?: AbortSignal) { return this.request<Dto<'RechargeOrderResponse'>>('POST',`/credits/recharge-orders/${encodeURIComponent(id)}/refresh`,{}, {},signal); }
  private controller = new AbortController();
  private refresh: Promise<void> | undefined;
  constructor(private sessionLost: () => void) {}

  reset() {
    this.controller.abort();
    this.controller = new AbortController();
    this.refresh = undefined;
  }

  private async send(method: string, path: string, body: unknown, headers: Record<string, string>, signal: AbortSignal, upload?:RequestUploadProgress) {
    const csrf = document.cookie.split('; ').find(value => value.startsWith('bb_csrf='))?.slice('bb_csrf='.length);
    if(upload&&body instanceof Blob)return this.sendUpload(method,path,body,{...(method==='GET'||!csrf?{}:{'X-BB-CSRF':csrf}),...headers},signal,upload);
    return fetch(`/api/v1${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' || !csrf ? {} : { 'X-BB-CSRF': csrf }), ...headers },
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body)
    });
  }

  private async response(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signalOverride?: AbortSignal, upload?:RequestUploadProgress): Promise<Response> {
    const signal = signalOverride ?? this.controller.signal;
    let response = await this.send(method, path, body, headers, signal, upload);
    const authenticated = !path.startsWith('/auth/recovery/') && !['/auth/login', '/auth/register', '/auth/agreement'].includes(path);
    if (response.status === 401 && authenticated && document.cookie.includes('bb_csrf=')) {
      if (!this.refresh) {
        const pending = this.send('POST', '/auth/refresh', undefined, {}, signal).then(async res => {
          if (!res.ok) throw parseApiError(res.status, await res.json().catch(() => ({})), 'UNAUTHENTICATED');
        });
        this.refresh = pending;
        void pending.finally(() => { if (this.refresh === pending) this.refresh = undefined; }).catch(() => {});
      }
      try { await this.refresh; }
      catch (error) {
        if (!signal.aborted && error instanceof ApiError && error.status === 401) this.sessionLost();
        throw error;
      }
      signal.throwIfAborted();
      response = await this.send(method, path, body, headers, signal, upload);
    }
    signal.throwIfAborted();
    if (!response.ok) {
      const problem: unknown = await response.json().catch(() => ({}));
      if (response.status === 401 && authenticated) this.sessionLost();
      throw parseApiError(response.status, problem);
    }
    return response;
  }

  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signalOverride?: AbortSignal, upload?:RequestUploadProgress): Promise<T> {
    headers={[BILLING_WIRE_HEADER]:BILLING_WIRE_VERSION,...headers};
    const family=billingWireRoute(method,path);
    if(family?.request&&body!==undefined&&headers[BILLING_WIRE_HEADER]!==LEGACY_BILLING_WIRE_VERSION)body=encodeBillingDto(family.request,body);
    const value=await runRecoverableBillingRequest(method,path,body,headers,async()=>{
      const response=await this.response(method,path,body,headers,signalOverride,upload);
      if(response.status===204)return undefined as T;
      let payload:unknown=await response.json();
      if(family?.response){
        // Legacy replay receipts may be narrowed numbers; normalize only the returned view.
        if(headers[BILLING_WIRE_HEADER]===LEGACY_BILLING_WIRE_VERSION)payload=encodeBillingDto(family.response,payload);
        else try{validateBillingDto(family.response,payload);}catch{throw new ApiError(0,'DATA_UNAVAILABLE');}
      }
      return payload as T;
    });
    observeAutomaticQuotes(value);
    // Refresh the signed-in wallet after charge/quote reads and explicit execution/payment changes.
    if (typeof window !== 'undefined' && (path.endsWith('/credit-charge') || path.endsWith('/credit-quote') ||
        method !== 'GET' && (path.startsWith('/runs/') || path.includes('/review/') || path.startsWith('/credits/') || path.startsWith('/commerce/')))) {
      window.dispatchEvent(new Event('bondbuddy:credits-changed'));
    }
    return value;
  }

  /** Only fixed owner-authorized artifact routes may use this binary seam. */
  async workpaperZip(project:string,batch:string,signal:AbortSignal,onProgress?:(received:number,total?:number)=>void,onPreparation?:(state:WorkpaperZipPreparation)=>void):Promise<Blob>{
    let response:Response;
    for(;;){
      signal.throwIfAborted();
      response=await this.response('GET',`/projects/${encodeURIComponent(project)}/workpapers/batches/${encodeURIComponent(batch)}/download`,undefined,{'Prefer':'respond-async'},signal);
      if(response.status!==202)break;
      // Consume the small status response before the next request. The caller's
      // total download deadline still bounds preparation and the final ZIP body.
      if(response.headers.get('content-type')?.split(';')[0]!=='application/json')throw new ApiError(0,'DATA_UNAVAILABLE');
      const preparation:unknown=await response.json();
      if(!Value.Check(WorkpaperZipPreparationSchema,preparation)||preparation.progress&&(
        preparation.progress.completed_files>preparation.progress.total_files||
        preparation.progress.phase==='packaging'&&preparation.progress.completed_files!==preparation.progress.total_files
      ))throw new ApiError(0,'DATA_UNAVAILABLE');
      signal.throwIfAborted();onPreparation?.(preparation);
      const seconds=Number(response.headers.get('retry-after'));
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
        const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},Math.max(1,Math.min(5,Number.isFinite(seconds)&&seconds>0?seconds:2))*1000);
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      });
    }
    if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!=='application/zip')throw new ApiError(0,'DATA_UNAVAILABLE');
    const length=Number(response.headers.get('content-length')),encoding=response.headers.get('content-encoding');
    const total=Number.isSafeInteger(length)&&length>0&&(!encoding||encoding==='identity')?length:undefined;
    onProgress?.(0,total);
    let bytes:Blob;
    if(response.body&&onProgress){
      const reader=response.body.getReader(),chunks:Uint8Array<ArrayBuffer>[]=[];let received=0;
      try{while(true){const {done,value}=await reader.read();signal.throwIfAborted();if(done)break;chunks.push(new Uint8Array(value));received+=value.byteLength;onProgress(received,total);}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}
      finally{reader.releaseLock();}
      bytes=new Blob(chunks,{type:'application/zip'});
    }else bytes=await response.blob();
    signal.throwIfAborted();if(bytes.size<22||total!==undefined&&bytes.size!==total)throw new ApiError(0,'DATA_UNAVAILABLE');return bytes;
  }

  async workpaperExplanation(project:string,batch:string,item:string,signal:AbortSignal):Promise<Blob>{
    const response=await this.response('GET',`/projects/${encodeURIComponent(project)}/workpapers/batches/${encodeURIComponent(batch)}/explanations/${encodeURIComponent(item)}`,undefined,{},signal);
    if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!=='application/vnd.openxmlformats-officedocument.wordprocessingml.document')throw new ApiError(0,'DATA_UNAVAILABLE');
    const bytes=await response.blob();signal.throwIfAborted();if(bytes.size<22)throw new ApiError(0,'DATA_UNAVAILABLE');return bytes;
  }

  async m4ArtifactBytes(artifact: import('@bondbuddy/contracts').M4Artifact, signal?: AbortSignal): Promise<Blob> {
    const activeSignal = signal ?? this.controller.signal;
    const path = `/m4/artifacts/${encodeURIComponent(artifact.artifact_id)}/versions/${artifact.artifact_version}/bytes`;
    const response = await this.response('GET', path, undefined, {}, activeSignal);
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim() !== artifact.mime_type) throw new ApiError(0, 'DATA_UNAVAILABLE');
    const bytes = await response.arrayBuffer(); activeSignal.throwIfAborted();
    if (!bytes.byteLength || bytes.byteLength !== artifact.byte_size) throw new ApiError(0, 'DATA_UNAVAILABLE');
    const digest = await crypto.subtle.digest('SHA-256', bytes); activeSignal.throwIfAborted();
    if (Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') !== artifact.sha256) throw new ApiError(0, 'DATA_UNAVAILABLE');
    return new Blob([bytes], {type:artifact.mime_type});
  }

  me() { return this.request<Dto<'MeResponse'>>('GET', '/me'); }
  login(input: Dto<'LoginRequest'>) { return this.request<Dto<'SessionResponse'>>('POST', '/auth/login', input); }
  register(input: Dto<'RegisterRequest'>) { return this.request<Dto<'SessionResponse'>>('POST', '/auth/register', input); }
  agreement() { return this.request<AgreementResponse>('GET', '/auth/agreement'); }
  logout() { return this.request<void>('POST', '/auth/logout'); }
  recoveryInfo() { return this.request<Dto<'RecoveryInfoResponse'>>('GET', '/auth/recovery/info'); }
  recoveryAccount() { return this.request<Dto<'RecoveryAccountResponse'>>('GET', '/account/recovery'); }
  recoveryBind(input: Dto<'RecoveryBindingRequest'>) { return this.request<Dto<'RecoveryBindingResponse'>>('POST', '/account/recovery/bindings', input); }
  recoveryConfirm(id: string, code: string) { return this.request<Dto<'RecoveryAccountResponse'>>('POST', `/account/recovery/bindings/${encodeURIComponent(id)}/confirm`, { code }); }
  recoveryRequest(username: string) { return this.request<Dto<'RecoveryTicketResponse'>>('POST', '/auth/recovery/requests', { username }); }
  recoveryReset(token: string, new_password: string) { return this.request<Dto<'RecoveryResetResponse'>>('POST', '/auth/recovery/reset', { token, new_password }); }
  supportBinding(id: string) { return this.request<Dto<'RecoverySupportBindingResponse'>>('GET', `/admin/account-recovery/bindings/${encodeURIComponent(id)}`); }
  supportCode(id: string) { return this.request<Dto<'RecoverySupportCodeResponse'>>('POST', `/admin/account-recovery/bindings/${encodeURIComponent(id)}/code`); }
  supportTicket(id: string) { return this.request<Dto<'RecoverySupportTicketResponse'>>('GET', `/admin/account-recovery/tickets/${encodeURIComponent(id)}`); }
  supportIssue(id: string, binding_id: string) { return this.request<Dto<'RecoveryLinkResponse'>>('POST', `/admin/account-recovery/tickets/${encodeURIComponent(id)}/issue`, {binding_id, confirmed_original_channel:true}); }
  account() { return this.request<Dto<'AccountResponse'>>('GET', '/account'); }
  sessions() { return this.request<Dto<'AccountSessionListResponse'>>('GET', '/account/sessions'); }
  revokeSession(sessionId: string) { return this.request<void>('DELETE', `/account/sessions/${encodeURIComponent(sessionId)}`); }
  revokeOtherSessions() { return this.request<Dto<'SessionRevokeOthersResponse'>>('POST', '/account/sessions/revoke-others'); }
  changePassword(input: Dto<'PasswordChangeRequest'>) { return this.request<Dto<'PasswordChangeResponse'>>('POST', '/account/password', input); }
  closurePreview() { return this.request<Dto<'AccountClosurePreviewResponse'>>('GET', '/account/closure'); }
  closeAccount(input: Dto<'AccountClosureRequest'>) { return this.request<Dto<'AccountClosureResponse'>>('POST', '/account/closure', input); }
  projects(cursor?: string, filters: Dto<'ProjectListQuery'> = {}, signal?: AbortSignal) {
    const query = new URLSearchParams(filters);
    if (cursor) query.set('cursor', cursor);
    return this.request<Dto<'ProjectListResponse'>>('GET', `/projects${query.size ? `?${query}` : ''}`, undefined, {[PROJECT_TASK_COUNTS_CAPABILITY.header]:PROJECT_TASK_COUNTS_CAPABILITY.value}, signal);
  }
  archiveProject(id: string, archived: boolean) { return this.request<Dto<'ProjectResponse'>>('POST', `/projects/${encodeURIComponent(id)}/archive`, { archived }); }
  artifact(id: string, signal?: AbortSignal) { return this.request<Dto<'ArtifactResponse'>>('GET', `/artifacts/${encodeURIComponent(id)}`, undefined, {}, signal); }
  runAction(id: string, action: 'cancel' | 'resume' | 'pause', signal?: AbortSignal) {
    return this.request<Dto<'RunResponse'>>('POST', `/runs/${encodeURIComponent(id)}/${action}`, { reason: action === 'cancel' ? 'user_cancelled' : action === 'pause' ? 'user_paused' : 'user_resumed' }, {}, signal);
  }
  run(id: string, signal?: AbortSignal) { return this.request<Dto<'RunResponse'>>('GET', `/runs/${encodeURIComponent(id)}`, undefined, {}, signal); }
  inputRevision(id: string, revision: number, signal?: AbortSignal) {
    return this.request<Dto<'InputRevisionResponse'>>('GET', `/projects/${encodeURIComponent(id)}/input-revisions/${revision}`, undefined, {}, signal);
  }
  projectMessages(id: string, cursor?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    return this.request<Dto<'ProjectMessagePage'>>('GET', `/projects/${encodeURIComponent(id)}/messages?${query}`, undefined, {}, signal);
  }
  saveProjectMessage(id: string, input: Dto<'ProjectMessageSaveRequest'>, signal?: AbortSignal) {
    return this.request<Dto<'ProjectMessageSaveResponse'>>('POST', `/projects/${encodeURIComponent(id)}/messages`, input, {}, signal);
  }
  projectMessageVersion(id: string, messageId: string, version: number, signal?: AbortSignal) {
    return this.request<Dto<'ProjectMessage'>>('GET', `/projects/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/versions/${version}`, undefined, {}, signal);
  }
  createInputRevision(id: string, input: Dto<'InputRevisionCreateRequest'>, signal?: AbortSignal) {
    return this.request<Dto<'InputRevisionResponse'>>('POST', `/projects/${encodeURIComponent(id)}/input-revisions`, input, {}, signal);
  }
  preflight(id: string, input: Dto<'PreflightRequest'>, signal?: AbortSignal) {
    return this.request<Dto<'PreflightResponse'>>('POST', `/projects/${encodeURIComponent(id)}/preflight`, input, {}, signal);
  }
  execute(input: Dto<'ExecuteRequest'>, signal?: AbortSignal) {
    return this.request<Dto<'RunResponse'>>('POST', '/runs/execute', input, {}, signal);
  }
  runEvents(id: string, after: number, signal?: AbortSignal) {
    return this.request<Dto<'RunEventsResponse'>>('GET', `/runs/${encodeURIComponent(id)}/events?after=${after}`, undefined, {}, signal);
  }
  async artifactBytes(artifact: Dto<'ArtifactResponse'>, signal?: AbortSignal, progress?: DownloadProgress): Promise<Blob> {
    const activeSignal = signal ?? this.controller.signal;
    const url = new URL(artifact.download_url, location.origin);
    const path = `/api/v1/artifacts/${encodeURIComponent(artifact.artifact_id)}/download`;
    if (url.origin !== location.origin || url.pathname !== path || url.username || url.password || url.hash) {
      throw new ApiError(0, 'DATA_UNAVAILABLE');
    }
    const response = await this.response('GET', `${url.pathname.slice('/api/v1'.length)}${url.search}`, undefined, {}, activeSignal);
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim() !== artifact.media_type) throw new ApiError(0, 'DATA_UNAVAILABLE');
    const bytes = await readDownloadBytes(response, activeSignal, progress);
    activeSignal.throwIfAborted();
    if (!bytes.byteLength) throw new ApiError(0, 'DATA_UNAVAILABLE');
    // Check the bytes received by the browser against the freshly authorized metadata.
    // A matching MIME type alone cannot detect truncation or same-length corruption.
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    activeSignal.throwIfAborted();
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (sha256 !== artifact.sha256) throw new ApiError(0, 'DATA_UNAVAILABLE');
    return new Blob([bytes], { type: artifact.media_type });
  }
  dataPolicy() { return this.request<DataPolicy>('GET', '/data-policy'); }
  deleteProject(id: string) { return this.request<void>('DELETE', `/projects/${encodeURIComponent(id)}`); }
  async deleteMaterial(id: string, materialId: string) {
    try { await this.request<void>('DELETE', `/projects/${encodeURIComponent(id)}/materials/${encodeURIComponent(materialId)}`); }
    catch (error) {
      // A lost response may follow a successful tombstone. Reconcile before leaving
      // the removed file selected in a draft; do not retry a business operation.
      if (error instanceof ApiError && error.status > 0 && error.status < 500) throw error;
      try { await this.material(id, materialId); }
      catch (readError) { if (readError instanceof ApiError && readError.status === 404) return; }
      throw error;
    }
  }
  project(id: string, signal?: AbortSignal) { return this.request<Dto<'ProjectResponse'>>('GET', `/projects/${encodeURIComponent(id)}`, undefined, {}, signal); }
  updateWorkspace(id:string,signal?:AbortSignal){return this.request<Dto<'UpdateWorkspaceResponse'>>('POST',`/projects/${encodeURIComponent(id)}/update-workspace`,{}, {},signal);}
  prospectusVersions(id:string,signal?:AbortSignal){return this.request<Dto<'ProspectusVersionsResponse'>>('GET',`/projects/${encodeURIComponent(id)}/prospectus-versions`,undefined,{},signal);}
  saveProspectus(id:string,input:Dto<'ProspectusVersionSaveRequest'>,signal?:AbortSignal){return this.request<Dto<'ProspectusVersionsResponse'>>('POST',`/projects/${encodeURIComponent(id)}/prospectus-versions`,input,{},signal);}
  selectProspectus(id:string,input:Dto<'ProspectusVersionSelectRequest'>,signal?:AbortSignal){return this.request<Dto<'ProspectusVersionsResponse'>>('POST',`/projects/${encodeURIComponent(id)}/prospectus-versions/current`,input,{},signal);}
  material(id: string, materialId: string, signal?: AbortSignal,version?:number) {
    return this.request<Dto<'MaterialResponse'>>('GET', `/projects/${encodeURIComponent(id)}/materials/${encodeURIComponent(materialId)}${version?'?version='+version:''}`, undefined, {}, AbortSignal.any([signal ?? this.controller.signal, AbortSignal.timeout(30_000)]));
  }
  async integrityCaptureBytes(projectId:string,roundId:string,capture:import('@bondbuddy/contracts').IntegrityCapture,signal?:AbortSignal):Promise<Blob>{
    const response=await this.response('GET',`/projects/${encodeURIComponent(projectId)}/integrity/runs/${encodeURIComponent(roundId)}/captures/${encodeURIComponent(capture.id)}`,undefined,{},signal);
    if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!=='image/png')throw new ApiError(0,'DATA_UNAVAILABLE');
    const bytes=await response.arrayBuffer();signal?.throwIfAborted();
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    if(bytes.byteLength!==capture.byte_size||hash!==capture.screenshot_sha256)throw new ApiError(0,'DATA_UNAVAILABLE');
    return new Blob([bytes],{type:'image/png'});
  }
  async materialBytes(projectId: string, material: Dto<'MaterialResponse'>, signal?: AbortSignal): Promise<Blob> {
    const activeSignal = signal ?? this.controller.signal;
    // The owner-scoped route authorizes this project/material pair; the caller
    // has compared freshly fetched metadata with the report's immutable pin.
    if (material.state !== 'persisted') throw new ApiError(0, 'DATA_UNAVAILABLE');
    const response = await this.response('GET', `/projects/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(material.material_id)}/download?version=${material.material_version}`, undefined, {}, activeSignal);
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim() !== material.media_type) throw new ApiError(0, 'DATA_UNAVAILABLE');
    const bytes = await response.arrayBuffer();
    activeSignal.throwIfAborted();
    if (!bytes.byteLength || bytes.byteLength !== material.byte_size) throw new ApiError(0, 'DATA_UNAVAILABLE');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    activeSignal.throwIfAborted();
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (sha256 !== material.sha256) throw new ApiError(0, 'DATA_UNAVAILABLE');
    return new Blob([bytes], { type: material.media_type });
  }
  materialParseJob(id: string, materialId: string, signal?: AbortSignal) {
    return this.request<Dto<'MaterialParseJobResponse'>>('GET', `/projects/${encodeURIComponent(id)}/materials/${encodeURIComponent(materialId)}/parse-job`, undefined, {}, signal);
  }
  sourceProfile(id: string, materialId: string, signal?: AbortSignal) {
    return this.request<Dto<'RecognitionResponse'>>('GET', `/projects/${encodeURIComponent(id)}/materials/${encodeURIComponent(materialId)}/source-profile`, undefined, {}, signal);
  }
  factCandidates(id: string, cursor?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    return this.request<Dto<'FactCandidateListResponse'>>('GET', `/projects/${encodeURIComponent(id)}/facts/candidates?${query}`, undefined, {}, signal);
  }
  decideFact(id: string, input: FactDecisionRequest, signal?: AbortSignal) {
    return this.request<Dto<'FactDecisionResponse'>>('POST', `/projects/${encodeURIComponent(id)}/facts/decisions`, input, {}, signal);
  }
  correctSourceProfile(id: string, materialId: string, input: Dto<'RecognitionPatchRequest'>) {
    return this.request<Dto<'RecognitionResponse'>>('PATCH', `/projects/${encodeURIComponent(id)}/materials/${encodeURIComponent(materialId)}/source-profile`, input, { 'If-Match': String(input.profile_version) });
  }
  projectEvents(id: string, after: number, signal?: AbortSignal) {
    return this.request<Dto<'ProjectEventsResponse'>>('GET', `/projects/${encodeURIComponent(id)}/events?after=${after}`, undefined, {}, AbortSignal.any([signal ?? this.controller.signal, AbortSignal.timeout(30_000)]));
  }
  createUpload(id: string, input: Dto<'UploadCreateRequest'>, signal?: AbortSignal) {
    return this.request<Dto<'UploadSessionResponse'>>('POST', `/projects/${encodeURIComponent(id)}/materials/uploads`, input, {}, signal);
  }
  async completeUpload(id:string,uploadId:string,input:Dto<'UploadCompleteRequest'>,signal?:AbortSignal):Promise<Dto<'MaterialResponse'>>{
    const lifetime=AbortSignal.any([signal??this.controller.signal,AbortSignal.timeout(UPLOAD_CONFIRMATION_TIMEOUT_MS)]);
    const path=`/projects/${encodeURIComponent(id)}/materials/uploads/${encodeURIComponent(uploadId)}/complete`;
    let failures=0;
    for(;;){
      lifetime.throwIfAborted();
      let response:Response;
      try{response=await this.response('POST',path,input,{'Prefer':'respond-async'},AbortSignal.any([lifetime,AbortSignal.timeout(25_000)]));failures=0;}
      catch(error){
        if(lifetime.aborted||error instanceof ApiError&&error.status<500&&error.status!==0||++failures>3)throw error;
        await this.uploadConfirmationDelay(2,lifetime);continue;
      }
      if(response.headers.get('content-type')?.split(';')[0]!=='application/json')throw new ApiError(0,'DATA_UNAVAILABLE');
      const result:unknown=await response.json();
      if(response.status===200){
        if(!Value.Check(uploadSchemas.MaterialResponse,result)||result.sha256!==input.sha256||result.byte_size!==input.byte_size)throw new ApiError(0,'DATA_UNAVAILABLE');
        return result;
      }
      if(response.status!==202||!Value.Check(uploadSchemas.UploadConfirmationPending,result)||result.upload_id!==uploadId)throw new ApiError(0,'DATA_UNAVAILABLE');
      const retry=Number(response.headers.get('retry-after'));
      await this.uploadConfirmationDelay(Number.isFinite(retry)&&retry>0?Math.min(5,retry):2,lifetime);
    }
  }
  private uploadConfirmationDelay(seconds:number,signal:AbortSignal){
    return new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},Math.max(.05,seconds)*1000);
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  uploadBytes(uploadUrl: string, file: File, onProgress: (loaded: number, total: number) => void, signal: AbortSignal) {
    const target = new URL(uploadUrl, window.location.href);
    if (!['http:', 'https:'].includes(target.protocol)) return Promise.reject(new ApiError(0, 'DATA_UNAVAILABLE'));
    const sameOrigin = target.origin === window.location.origin;
    const send = () => new Promise<XMLHttpRequest>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', target.href);
      // Browser upload.load does not prove a buffering proxy's upstream received
      // the bytes. Bound the whole PUT, including its response, like complete.
      xhr.timeout = UPLOAD_CONFIRMATION_TIMEOUT_MS;
      xhr.withCredentials = sameOrigin;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      if (sameOrigin) {
        const csrf = document.cookie.split('; ').find(value => value.startsWith('bb_csrf='))?.slice('bb_csrf='.length);
        if (csrf) xhr.setRequestHeader('X-BB-CSRF', csrf);
      }
      xhr.upload.addEventListener('progress', event => {
        onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
      });
      const abort = () => xhr.abort();
      signal.addEventListener('abort', abort, { once: true });
      xhr.addEventListener('load', () => { signal.removeEventListener('abort', abort); resolve(xhr); }, { once: true });
      xhr.addEventListener('error', () => { signal.removeEventListener('abort', abort); reject(new ApiError(0, 'DATA_UNAVAILABLE')); }, { once: true });
      xhr.addEventListener('timeout', () => { signal.removeEventListener('abort', abort); reject(new ApiError(0, 'DATA_UNAVAILABLE')); }, { once: true });
      xhr.addEventListener('abort', () => {
        signal.removeEventListener('abort', abort);
        reject(new DOMException('Upload aborted', 'AbortError'));
      }, { once: true });
      if (signal.aborted) { signal.removeEventListener('abort', abort); reject(new DOMException('Upload aborted', 'AbortError')); return; }
      xhr.send(file);
    });
    return (async () => {
      let refreshed = false;
      for (;;) {
        const xhr = await send();
        if (xhr.status === 204) return;
        if (xhr.status === 401 && sameOrigin && !refreshed && document.cookie.includes('bb_csrf=')) {
          refreshed = true;
          await this.request<void>('POST', '/auth/refresh', undefined, {}, signal);
          signal.throwIfAborted();
          onProgress(0, file.size); // The next progress events describe the fresh, real retry attempt.
          continue;
        }
      let problem: unknown;
      try { problem = JSON.parse(xhr.responseText); } catch { /* response may be empty */ }
      throw parseApiError(xhr.status, problem);
      }
    })();
  }
  create(input: Dto<'ProjectCreateRequest'>) { return this.request<Dto<'ProjectResponse'>>('POST', '/projects', input); }
  patch(id: string, revision: number, input: Dto<'ProjectPatchRequest'>) {
    return this.request<Dto<'ProjectResponse'>>('PATCH', `/projects/${encodeURIComponent(id)}`, input, { 'If-Match': String(revision) });
  }
}
