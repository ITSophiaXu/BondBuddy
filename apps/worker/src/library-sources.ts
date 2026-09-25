import { createHash } from 'node:crypto';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import type { LibrarySourceInput } from '@bondbuddy/api/library';

// #78 source adapters. Each adapter only discovers and fetches; dedupe, parse, classify and review are
// the shared pipeline's job, so the operator import and public-disclosure sources behave identically.

export type DiscoveredItem = {
  /** Stable per revision; the sync log key. */
  itemKey: string;
  externalKey: string; issuerKey: string; issuerName: string; title: string;
  sourceRevision: string; sourceRevisionRank: number;
  mediaType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  sourceUrl: string | null; disclosedAt: string | null; market: 'sse' | 'szse' | 'nafmii' | null;
  /** Adapter-private fetch locator (URL or staged blob key); never user material. */
  locator: string; expectedSha256?: string;
};
export type Discovery = { items: DiscoveredItem[]; cursorAfter: Record<string, unknown> };
export interface LibrarySourceAdapter {
  readonly sourceId: string;
  readonly mode: 'scheduled' | 'import';
  discover(cursor: Record<string, unknown>, checkpoint: Record<string, any>): Promise<Discovery>;
  fetch(item: DiscoveredItem): Promise<Buffer>;
}
export class SourceError extends Error {
  constructor(public code: 'LIBRARY_SOURCE_UNREACHABLE' | 'LIBRARY_FETCH_FAILED' | 'LIBRARY_BYTES_INVALID', public retryable: boolean, public detail: string | null = null) { super(code); }
}

// ---------------------------------------------------------------- SSE bond project platform
export const SSE_BOND_SOURCE: LibrarySourceInput = {
  id: 'sse_bond_project_platform', kind: 'public_disclosure', market: 'sse',
  displayName: '上海证券交易所 公司债券项目信息平台（募集说明书）',
  // Recorded verbatim from the site legal notice checked 2026-09-25: non-commercial browsing/downloading is
  // permitted; use for profit needs written permission from 上证所信息网络有限公司. Hence evaluation_only.
  authorizationBasis: 'sse.com.cn legal notice: non-commercial browse/download permitted; commercial use requires written permission from SSE Infonet. Registered evaluation_only until a licence is recorded.',
  termsUrl: 'https://www.sse.com.cn/home/legal/', usageRights: 'evaluation_only', staleAfterSeconds: 2 * 86400, syncIntervalSeconds: 86400,
};
const SSE_QUERY = 'https://query.sse.com.cn/commonSoaQuery.do';
const SSE_FILES = 'https://static.sse.com.cn/bond';
const PROSPECTUS_FILE_TYPE = 11; // "1-1 …募集说明书"
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<any> }>;

export type SseOptions = {
  fetch?: FetchLike; maxProjects?: number; maxPages?: number; pageSize?: number; delayMs?: number; timeoutMs?: number;
  /** bond_type filter. ABS (2) is not a prospectus target; non-public projects (1,6) expose no files on the platform (observed 2026-09-25). */
  bondTypes?: string;
};

export class SseBondProjectAdapter implements LibrarySourceAdapter {
  readonly sourceId = SSE_BOND_SOURCE.id;
  readonly mode = 'scheduled' as const;
  private readonly http: FetchLike;
  constructor(private readonly options: SseOptions = {}) { this.http = options.fetch ?? (globalThis.fetch as unknown as FetchLike); }
  private async pause() { if (this.options.delayMs ?? 700) await new Promise(r => setTimeout(r, this.options.delayMs ?? 700)); }
  private async get(url: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 180_000);
    try {
      return await this.http(url, { headers: { 'User-Agent': 'BondBuddy-reference-library/0.1 (+ops contact in runbook)', Referer: 'https://bond.sse.com.cn/' }, signal: controller.signal });
    } finally { clearTimeout(timer); }
  }
  private async query(params: Record<string, string>) {
    const url = `${SSE_QUERY}?${new URLSearchParams(params)}`;
    let response;
    try { response = await this.get(url); } catch { throw new SourceError('LIBRARY_SOURCE_UNREACHABLE', true); }
    if (!response.ok) throw new SourceError('LIBRARY_SOURCE_UNREACHABLE', response.status >= 500 || response.status === 429);
    try { return await response.json(); } catch { throw new SourceError('LIBRARY_SOURCE_UNREACHABLE', true); }
  }

  /**
   * Projects are listed newest PUBLISH_DATE first. The cursor is the highest PUBLISH_DATE fully seen; the
   * next run rescans that date again (overlap), so late same-day files are caught and repeats dedupe to unchanged.
   */
  async discover(cursor: Record<string, unknown>, _checkpoint: Record<string, any> = {}): Promise<Discovery> {
    const since = typeof cursor.publish_date === 'string' ? cursor.publish_date : null;
    const maxProjects = this.options.maxProjects ?? 5, pageSize = this.options.pageSize ?? 20, maxPages = this.options.maxPages ?? 5;
    const projects: any[] = [];
    let highWater = since;
    for (let page = 1; page <= maxPages && projects.length < maxProjects; page++) {
      const body = await this.query({ isPagination: 'true', sqlId: 'ZQ_XMLB', bond_type: this.options.bondTypes ?? '0,3,5,7', 'pageHelp.pageSize': String(pageSize), 'pageHelp.pageNo': String(page) });
      const rows: any[] = body?.pageHelp?.data ?? [];
      if (!rows.length) break;
      let reachedCursor = false;
      for (const row of rows) {
        if (since && String(row.PUBLISH_DATE) < since) { reachedCursor = true; break; }
        if (!highWater || String(row.PUBLISH_DATE) > highWater) highWater = String(row.PUBLISH_DATE);
        projects.push(row);
        if (projects.length >= maxProjects) break;
      }
      if (reachedCursor) break;
      await this.pause();
    }
    const items: DiscoveredItem[] = [];
    for (const project of projects) {
      await this.pause();
      const body = await this.query({ isPagination: 'false', sqlId: 'ZQ_GGJG', bond_type: '0,1,2,3,5,6,7', audit_id: String(project.BOND_NUM) });
      const files: any[] = (body?.result ?? []).filter((f: any) => Number(f.FILE_TYPE) === PROSPECTUS_FILE_TYPE && /募集说明书/.test(String(f.FILE_TITLE)) && /\.pdf$/i.test(String(f.FILE_PATH)));
      // FILE_VERSION restarts per upload batch (seen live: two different "v1" files), so the revision
      // order is (FILE_TIME, FILE_VERSION) and the item identity is the immutable file path.
      const rank = (f: any) => Number(String(f.FILE_TIME).replaceAll('-', '')) * 100 + Number(f.FILE_VERSION);
      for (const file of files.filter((f: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(f.FILE_TIME))).sort((a, b) => rank(a) - rank(b))) {
        const fileId = String(file.FILE_PATH).split('/').pop()!.replace(/\.pdf$/i, '');
        items.push({
          itemKey: `${project.BOND_NUM}:${fileId}`, externalKey: String(project.BOND_NUM),
          issuerKey: String(project.ISSUER_ID || project.FULL_NAME), issuerName: String(project.FULL_NAME), title: String(project.AUDIT_NAME),
          sourceRevision: `${file.FILE_TIME}#v${file.FILE_VERSION}#${fileId}`, sourceRevisionRank: rank(file),
          mediaType: 'application/pdf', sourceUrl: `${SSE_FILES}${file.FILE_PATH}`, disclosedAt: String(file.FILE_TIME),
          market: 'sse', locator: `${SSE_FILES}${file.FILE_PATH}`,
        });
      }
    }
    return { items, cursorAfter: highWater ? { publish_date: highWater } : { ...cursor } };
  }

  async fetch(item: DiscoveredItem): Promise<Buffer> {
    if (!item.locator.startsWith(`${SSE_FILES}/`)) throw new SourceError('LIBRARY_FETCH_FAILED', false);
    let response;
    try { response = await this.get(item.locator); } catch (error) { throw new SourceError('LIBRARY_FETCH_FAILED', true, error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network'); }
    if (!response.ok) throw new SourceError('LIBRARY_FETCH_FAILED', response.status >= 500 || response.status === 429 || response.status === 404, `http_${response.status}`);
    let bytes: Buffer;
    try { bytes = Buffer.from(await response.arrayBuffer()); } catch { throw new SourceError('LIBRARY_FETCH_FAILED', true, 'body_interrupted'); }
    if (bytes.length > 150 * 1024 * 1024) throw new SourceError('LIBRARY_BYTES_INVALID', false);
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new SourceError('LIBRARY_BYTES_INVALID', true, 'not_pdf');
    return bytes;
  }
}

// ---------------------------------------------------------------- operator bulk import
import { OPERATOR_IMPORT_SOURCE } from '@bondbuddy/api/library';
export { OPERATOR_IMPORT_SOURCE };

/** Reads items staged by POST /api/v1/admin/library/imports (library/import-staging/<sha256>). */
export class OperatorImportAdapter implements LibrarySourceAdapter {
  readonly sourceId = OPERATOR_IMPORT_SOURCE.id;
  readonly mode = 'import' as const;
  constructor(private readonly blobs: PrivateBlobs) {}
  async discover(cursor: Record<string, unknown>, checkpoint: Record<string, any>): Promise<Discovery> {
    const staged: any[] = Array.isArray(checkpoint.import_items) ? checkpoint.import_items : [];
    return {
      cursorAfter: { ...cursor },
      items: staged.map(s => ({
        itemKey: `${s.external_key}:${s.source_revision}:${String(s.sha256).slice(0, 12)}`, externalKey: s.external_key, issuerKey: s.issuer_key, issuerName: s.issuer_name, title: s.title,
        sourceRevision: s.source_revision, sourceRevisionRank: Number(s.source_revision_rank) || 1, mediaType: s.media_type, sourceUrl: null,
        disclosedAt: s.disclosed_at ?? null, market: s.market ?? null, locator: s.staged_key, expectedSha256: s.sha256,
      })),
    };
  }
  async fetch(item: DiscoveredItem): Promise<Buffer> {
    if (!/^library\/import-staging\/[a-f0-9]{64}$/.test(item.locator)) throw new SourceError('LIBRARY_FETCH_FAILED', false);
    const bytes = await this.blobs.getIfExists(item.locator);
    if (!bytes) throw new SourceError('LIBRARY_FETCH_FAILED', false);
    if (item.expectedSha256 && createHash('sha256').update(bytes).digest('hex') !== item.expectedSha256) throw new SourceError('LIBRARY_BYTES_INVALID', false);
    return bytes;
  }
}
