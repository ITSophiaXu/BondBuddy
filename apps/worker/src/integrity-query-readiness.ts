import type { BrowserContext, Frame, Request, Response } from 'playwright';
import type { IntegritySite } from '@bondbuddy/contracts';
import { integrityBrowserUrlAllowed } from './integrity-browser-network.js';

// Production durations are independent of the overall deadline. A short deadline
// must time out, never shorten the evidence requirements to make a zero pass.
export const INTEGRITY_RESULT_STABLE_MS = 2000;
export const INTEGRITY_ZERO_CONFIRM_MS = 5000;
const MAX_RESPONSE_BYTES = 2_000_000;
const telemetry =
  /(?:^|\/)(?:analytics|telemetry|beacon|collect|tracking|track|statistics)(?:\/|$)/i;
export function integrityRequestCarriesQuery(
  request: Request,
  site: IntegritySite,
  query: string,
): boolean {
  try {
    if (
      !['document', 'xhr', 'fetch'].includes(request.resourceType()) ||
      !integrityBrowserUrlAllowed(site, request.url())
    )
      return false;
    if (telemetry.test(new URL(request.url()).pathname)) return false;
    let body = request.postData() ?? '';
    try {
      body = JSON.stringify(JSON.parse(body));
    } catch {
      /* Form data. */
    }
    return decodeURIComponent((request.url() + ' ' + body).replace(/\+/g, ' ')).includes(query);
  } catch {
    return false;
  }
}

/** Only explicit totals/result arrays are evidence; an empty object or HTTP 200 is not zero. */
export function integrityResponseCount(value: unknown): { count?: number; invalid?: boolean } {
  if (Array.isArray(value)) return { count: value.length };
  if (!value || typeof value !== 'object') return {};
  const root = value as Record<string, unknown>;
  if (
    root.success === false ||
    (root.error && root.error !== '0') ||
    (typeof root.code === 'number' && root.code >= 400)
  )
    return { invalid: true };
  const counts: number[] = [],
    lengths: number[] = [];
  const visit = (object: Record<string, unknown>, depth: number) => {
    for (const key of [
      'total',
      'totalCount',
      'total_count',
      'totalHits',
      'numFound',
      'recordsTotal',
    ]) {
      const raw = object[key],
        n =
          typeof raw === 'number'
            ? raw
            : typeof raw === 'string' && /^\d+$/.test(raw)
              ? Number(raw)
              : undefined;
      if (n !== undefined && Number.isSafeInteger(n) && n >= 0) counts.push(n);
    }
    for (const key of ['list', 'rows', 'records', 'items', 'results', 'content'])
      if (Array.isArray(object[key])) lengths.push(object[key].length);
    if (depth < 3)
      for (const key of ['data', 'result', 'page', 'pagination', 'response']) {
        const child = object[key];
        if (child && typeof child === 'object' && !Array.isArray(child))
          visit(child as Record<string, unknown>, depth + 1);
      }
  };
  visit(root, 0);
  if (counts.length) {
    if (counts.some((n) => n !== counts[0]) || (counts[0] === 0 && lengths.some((n) => n > 0)))
      return { invalid: true };
    return { count: counts[0] };
  }
  if (lengths.length && lengths.every((n) => n === lengths[0])) return { count: lengths[0] };
  return {};
}

type ObservedRequest = {
  request: Request;
  frame?: Frame;
  document: string;
  key: string;
  navigation: boolean;
  pending: boolean;
  ok: boolean;
  finishedAt: number;
  count?: number;
  jsonUnknown?: boolean;
  invalid?: boolean;
  requiresData?: boolean;
  status?: number;
  error?: string;
};
/** Query-scoped network evidence, kept alive through the final screenshot check. */
export function observeIntegrityQuery(context: BrowserContext, site: IntegritySite, query: string) {
  const records = new Map<Request, ObservedRequest>(),
    queryDocuments = new Map<Frame, string>();
  let revision = 0,
    closed = false;
  const startedAt = Date.now();
  const started = (request: Request) => {
    try {
      const type = request.resourceType();
      if (
        !['document', 'xhr', 'fetch'].includes(type) ||
        !integrityBrowserUrlAllowed(site, request.url()) ||
        telemetry.test(new URL(request.url()).pathname)
      )
        return;
      const navigation = type === 'document' && request.isNavigationRequest();
      let frame: Frame | undefined;
      try {
        frame = request.frame();
      } catch {
        if (!navigation) return;
      }
      const prior = request.redirectedFrom(),
        redirect = prior ? records.get(prior) : undefined;
      const carries = integrityRequestCarriesQuery(request, site, query);
      // Popup navigation can precede its Frame object. Keep the request pending and
      // bind it only to the exact document once the browser exposes that frame.
      if (frame && !queryDocuments.has(frame)) {
        const opened = [...records.values()].find(
          (r) => r.navigation && r.document === frame!.url() && (!r.frame || r.frame === frame),
        );
        if (opened) {
          opened.frame = frame;
          queryDocuments.set(frame, opened.document);
        }
      }
      // Token/cookie based result APIs need not repeat the name. Associate them only
      // with a document that was itself opened by this query, never the homepage feed.
      if (
        !carries &&
        !redirect &&
        !(type !== 'document' && frame && queryDocuments.get(frame) === frame.url())
      )
        return;
      if (redirect) {
        records.delete(redirect.request);
      }
      if (navigation && frame) queryDocuments.set(frame, request.url());
      else if (carries && frame) queryDocuments.set(frame, frame.url());
      records.set(request, {
        request,
        frame,
        document: navigation ? request.url() : frame!.url(),
        key: request.method() + ' ' + request.url() + ' ' + (request.postData() ?? ''),
        navigation,
        pending: true,
        ok: false,
        finishedAt: 0,
      });
      revision++;
    } catch {
      /* Detached frames are not visible evidence. */
    }
  };
  const response = (response: Response) => {
    const record = records.get(response.request());
    if (record) {
      record.ok = response.ok();
      record.status = response.status();
    }
  };
  const finished = async (request: Request) => {
    const record = records.get(request);
    if (!record) return;
    try {
      const response = await request.response();
      record.ok = !!response?.ok();
      record.status = response?.status();
      if (record.ok && response && record.navigation) {
        // A scripted search shell's initial zero is not server-rendered evidence.
        // Wait for data even when initialization schedules the first API call later.
        // Scripted sites without recognizable data remain unverified, not zero.
        record.requiresData = true;
        if (Number(response.headers()['content-length'] ?? 0) <= MAX_RESPONSE_BYTES) {
          const body = await response.body();
          if (body.length <= MAX_RESPONSE_BYTES) {
            const source = body
              .toString('utf8')
              .replace(/<!--[^]*?-->/g, '')
              .replace(
                /<script\b[^>]*type\s*=\s*["']application\/(?:ld\+)?json["'][^>]*>[^]*?<\/script\s*>/gi,
                '',
              )
              .replace(/<script\s*>\s*<\/script\s*>/gi, '');
            record.requiresData = /<script\b|<iframe\b|\bonload\s*=/i.test(source);
          }
        }
      } else if (record.ok && response) {
        const headers = response.headers(),
          type = headers['content-type'] ?? '';
        if (/json/i.test(type)) {
          record.jsonUnknown = true;
          if (Number(headers['content-length'] ?? 0) <= MAX_RESPONSE_BYTES) {
            const body = await response.body();
            if (body.length <= MAX_RESPONSE_BYTES) {
              const parsed = integrityResponseCount(JSON.parse(body.toString('utf8')));
              Object.assign(record, parsed);
              record.jsonUnknown = parsed.count === undefined;
            }
          }
        }
      }
    } catch {
      record.invalid = true;
    } finally {
      if (!closed) {
        record.pending = false;
        record.finishedAt = Date.now();
        revision++;
      }
    }
  };
  const failed = (request: Request) => {
    const record = records.get(request);
    if (record) {
      record.pending = false;
      record.ok = false;
      record.error = request.failure()?.errorText.match(/net::[A-Z_]+/)?.[0];
      record.finishedAt = Date.now();
      revision++;
    }
  };
  context.on('request', started);
  context.on('response', response);
  context.on('requestfinished', finished);
  context.on('requestfailed', failed);
  return {
    startedAt,
    snapshot(frames: Frame[]) {
      // A later response cannot hide another result API's failure. Only a new
      // identical request in the same document can replace its outcome. Different
      // query/body parameters may select different datasets at the same endpoint.
      const latest = new Map<string, ObservedRequest>();
      for (const r of records.values())
        if (!r.frame && r.navigation) {
          const matches = frames.filter((f) => f.url() === r.document);
          if (matches.length === 1) {
            r.frame = matches[0];
            queryDocuments.set(r.frame, r.document);
          }
        }
      const active = [...records.values()].filter(
        (r): r is ObservedRequest & { frame: Frame } =>
          !!r.frame && frames.includes(r.frame) && r.frame.url() === r.document,
      );
      for (const r of active) latest.set(frames.indexOf(r.frame) + ' ' + r.key, r);
      const current = [...latest.values()],
        data = current.filter((r) => !r.navigation),
        pending = active.some((r) => r.pending);
      const failure = current.find((r) => !r.pending && !r.ok),
        failed = !!failure;
      const success = current.some((r) => !r.pending && r.ok);
      const finishedAt = Math.max(0, ...current.map((r) => r.finishedAt));
      return {
        revision,
        pending,
        failed,
        httpStatus: failure?.status,
        error: failure?.error,
        ready: success && !pending && !failed,
        finishedAt,
        freshDocument: current.some((r) => r.navigation && !r.pending && r.ok),
        explicitZero: data.length > 0 && data.every((r) => r.count === 0 && !r.invalid),
        countConflict: data.some((r) => r.invalid),
        zeroAllowed:
          !(current.some((r) => r.navigation && r.requiresData) && !data.length) &&
          !data.some((r) => r.invalid || r.jsonUnknown || (r.count !== undefined && r.count !== 0)),
        positiveAllowed:
          !data.some((r) => r.invalid) && (!data.length || !data.every((r) => r.count === 0)),
      };
    },
    close() {
      closed = true;
      context.off('request', started);
      context.off('response', response);
      context.off('requestfinished', finished);
      context.off('requestfailed', failed);
    },
  };
}
