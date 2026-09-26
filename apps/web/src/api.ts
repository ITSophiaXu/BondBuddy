import type { Static } from '@sinclair/typebox';
import type { schemas, SchemaName, DataPolicy, AgreementResponse } from '@bondbuddy/contracts';
import type { FactDecisionRequest } from '@bondbuddy/contracts';

export type Dto<K extends SchemaName> = Static<(typeof schemas)[K]>;
export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export function friendlyError(error: unknown): string {
  if (!(error instanceof ApiError)) return '连接中断，尚未确认保存。请检查网络后重试。';
  switch (error.code) {
    case 'INPUT_REVISION_CONFLICT': return '这个项目已在其他页面修改。你的输入仍保留，请查看最新版本后再修改。';
    case 'UNAUTHENTICATED': return '登录已失效，请重新登录。';
    case 'NOT_FOUND': return '无法访问这个项目，它可能已移除或不属于当前账号。';
    case 'RATE_LIMITED': return '尝试次数过多，请稍后再试。';
    case 'CSRF_DENIED': return '会话验证未通过，请刷新页面后重试。';
    case 'VALIDATION_FAILED': case 'INPUT_REQUIRED': return '请检查填写内容后重试。';
    case 'CAPABILITY_NOT_READY': return '这项功能暂未开放，请稍后再试。';
    case 'PASSWORD_INVALID': return '当前密码不正确。';
    case 'ACCOUNT_CLOSURE_BLOCKED': return '还有任务尚未结束，暂时不能注销账号。';
    case 'PROJECT_DELETE_BLOCKED': return '项目中还有任务尚未结束，暂时不能删除。';
    default: return '暂时无法完成操作，请稍后重试。';
  }
}

export class ApiClient {
  private controller = new AbortController();
  private refresh: Promise<void> | undefined;
  constructor(private sessionLost: () => void) {}

  reset() {
    this.controller.abort();
    this.controller = new AbortController();
    this.refresh = undefined;
  }

  private async send(method: string, path: string, body: unknown, headers: Record<string, string>, signal: AbortSignal) {
    const csrf = document.cookie.split('; ').find(value => value.startsWith('bb_csrf='))?.slice('bb_csrf='.length);
    return fetch(`/api/v1${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' || !csrf ? {} : { 'X-BB-CSRF': csrf }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signalOverride?: AbortSignal): Promise<T> {
    const signal = signalOverride ?? this.controller.signal;
    let response = await this.send(method, path, body, headers, signal);
    const authenticated = !path.startsWith('/auth/recovery/') && !['/auth/login', '/auth/register', '/auth/agreement'].includes(path);
    if (response.status === 401 && authenticated && document.cookie.includes('bb_csrf=')) {
      if (!this.refresh) {
        const pending = this.send('POST', '/auth/refresh', undefined, {}, signal).then(async res => {
          if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).code ?? 'UNAUTHENTICATED');
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
      response = await this.send(method, path, body, headers, signal);
    }
    signal.throwIfAborted();
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      if (response.status === 401 && authenticated) this.sessionLost();
      throw new ApiError(response.status, problem.code ?? 'DATA_UNAVAILABLE');
    }
    return response.status === 204 ? undefined as T : response.json();
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
    return this.request<Dto<'ProjectListResponse'>>('GET', `/projects${query.size ? `?${query}` : ''}`, undefined, {}, signal);
  }
  archiveProject(id: string, archived: boolean) { return this.request<Dto<'ProjectResponse'>>('POST', `/projects/${encodeURIComponent(id)}/archive`, { archived }); }
  artifact(id: string) { return this.request<Dto<'ArtifactResponse'>>('GET', `/artifacts/${encodeURIComponent(id)}`); }
  dataPolicy() { return this.request<DataPolicy>('GET', '/data-policy'); }
  deleteProject(id: string) { return this.request<void>('DELETE', `/projects/${encodeURIComponent(id)}`); }
  deleteMaterial(id: string, materialId: string) { return this.request<void>('DELETE', `/projects/${encodeURIComponent(id)}/materials/${encodeURIComponent(materialId)}`); }
  project(id: string) { return this.request<Dto<'ProjectResponse'>>('GET', `/projects/${encodeURIComponent(id)}`); }
  material(id: string, materialId: string, signal?: AbortSignal) {
    return this.request<Dto<'MaterialResponse'>>('GET', `/projects/${encodeURIComponent(id)}/materials/${encodeURIComponent(materialId)}`, undefined, {}, signal);
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
    return this.request<Dto<'ProjectEventsResponse'>>('GET', `/projects/${encodeURIComponent(id)}/events?after=${after}`, undefined, {}, signal);
  }
  createUpload(id: string, input: Dto<'UploadCreateRequest'>, signal?: AbortSignal) {
    return this.request<Dto<'UploadSessionResponse'>>('POST', `/projects/${encodeURIComponent(id)}/materials/uploads`, input, {}, signal);
  }
  completeUpload(id: string, uploadId: string, input: Dto<'UploadCompleteRequest'>, signal?: AbortSignal) {
    return this.request<Dto<'MaterialResponse'>>('POST', `/projects/${encodeURIComponent(id)}/materials/uploads/${encodeURIComponent(uploadId)}/complete`, input, {}, signal);
  }
  uploadBytes(uploadUrl: string, file: File, onProgress: (loaded: number, total: number) => void, signal: AbortSignal) {
    const target = new URL(uploadUrl, window.location.href);
    if (!['http:', 'https:'].includes(target.protocol)) return Promise.reject(new ApiError(0, 'DATA_UNAVAILABLE'));
    const sameOrigin = target.origin === window.location.origin;
    const send = () => new Promise<XMLHttpRequest>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', target.href);
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
      xhr.addEventListener('abort', () => {
        signal.removeEventListener('abort', abort);
        reject(new DOMException('Upload aborted', 'AbortError'));
      }, { once: true });
      if (signal.aborted) { abort(); return; }
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
      let code = 'DATA_UNAVAILABLE';
      try { code = JSON.parse(xhr.responseText).code ?? code; } catch { /* response may be empty */ }
      throw new ApiError(xhr.status, code);
      }
    })();
  }
  create(input: Dto<'ProjectCreateRequest'>) { return this.request<Dto<'ProjectResponse'>>('POST', '/projects', input); }
  patch(id: string, revision: number, input: Dto<'ProjectPatchRequest'>) {
    return this.request<Dto<'ProjectResponse'>>('PATCH', `/projects/${encodeURIComponent(id)}`, input, { 'If-Match': String(revision) });
  }
}
