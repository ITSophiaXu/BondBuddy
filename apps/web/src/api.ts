import type { Static } from '@sinclair/typebox';
import type { schemas, SchemaName } from '@bondbuddy/contracts';

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

  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const signal = this.controller.signal;
    let response = await this.send(method, path, body, headers, signal);
    const authenticated = !['/auth/login', '/auth/register'].includes(path);
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
  logout() { return this.request<void>('POST', '/auth/logout'); }
  projects(cursor?: string) { return this.request<Dto<'ProjectListResponse'>>('GET', `/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`); }
  project(id: string) { return this.request<Dto<'ProjectResponse'>>('GET', `/projects/${encodeURIComponent(id)}`); }
  create(input: Dto<'ProjectCreateRequest'>) { return this.request<Dto<'ProjectResponse'>>('POST', '/projects', input); }
  patch(id: string, revision: number, input: Dto<'ProjectPatchRequest'>) {
    return this.request<Dto<'ProjectResponse'>>('PATCH', `/projects/${encodeURIComponent(id)}`, input, { 'If-Match': String(revision) });
  }
}
