import type { Static } from '@sinclair/typebox';
import { schemas, type Project } from '@bondbuddy/contracts';

export type ProjectCreate = Static<typeof schemas.ProjectCreateRequest>;
export type ProjectPatch = Static<typeof schemas.ProjectPatchRequest>;
export type Session = Static<typeof schemas.MeResponse>;
export type ProjectList = Static<typeof schemas.ProjectListResponse>;
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
type Fetch = typeof fetch;
export class ApiClient {
  private refresh: Promise<void> | undefined;
  constructor(private transport: Fetch = fetch, private cookies: () => string = () => document.cookie) {}
  private csrf(): string {
    const match = this.cookies().split(';').map(part => part.trim()).find(part => part.startsWith('bb_csrf='));
    try { return match ? decodeURIComponent(match.slice('bb_csrf='.length)) : ''; } catch { return ''; }
  }
  async request<T>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, retry = true): Promise<T> {
    if (!path.startsWith('/api/v1/')) throw new Error('API path must stay on the current origin.');
    const response = await this.transport(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'X-BB-CSRF': this.csrf() }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (response.status === 401 && retry && !path.startsWith('/api/v1/auth/')) {
      this.refresh ??= this.request<void>('/api/v1/auth/refresh', 'POST', undefined, {}, false).finally(() => { this.refresh = undefined; });
      await this.refresh;
      return this.request<T>(path, method, body, headers, false);
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiError(response.status, error.code ?? 'DATA_UNAVAILABLE', error.message ?? '请求未完成');
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  me() { return this.request<Session>('/api/v1/me'); }
  login(username: string, password: string) { return this.request<Session>('/api/v1/auth/login', 'POST', { username, password }); }
  logout() { return this.request<void>('/api/v1/auth/logout', 'POST'); }
  list(cursor?: string) { return this.request<ProjectList>(`/api/v1/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`); }
  project(id: string) { return this.request<Project>(`/api/v1/projects/${encodeURIComponent(id)}`); }
  save(draft: ProjectCreate, current: Project | null) {
    if (!current) return this.request<Project>('/api/v1/projects', 'POST', draft);
    const { kind: _kind, ...patch } = draft;
    return this.request<Project>(`/api/v1/projects/${encodeURIComponent(current.project_id)}`, 'PATCH', patch, { 'If-Match': String(current.draft_revision) });
  }
}
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '登录已过期，请重新登录；尚未保存的内容会为当前账号保留在本页面。';
    if (error.code === 'INPUT_REVISION_CONFLICT') return '项目已在其他页面修改。本页内容尚未覆盖，请先查看已保存版本，再决定如何合并。';
    if (error.status === 404) return '项目不存在或当前账号无法访问。';
    if (error.code === 'RATE_LIMITED') return '尝试次数较多，请稍后重试。';
    if (error.code === 'CSRF_DENIED') return '会话校验未通过，请重新登录后再试。';
    if (error.status === 422) return '填写内容未通过校验，请核对日期、金额、单位和文字长度。';
  }
  return '请求未完成，填写内容仍保留。请检查连接后重试。';
}
