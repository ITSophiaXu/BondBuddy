// #994 model request measurement and optional byte-budget enforcement.
//
// One loopback listener per Codex process. Codex sends its Responses API requests here
// (base_url=http://127.0.0.1:<port>) and every request is forwarded unchanged to the
// configured provider, through the same allow-list egress proxy the child would use.
// The gateway records sizes, counts, status codes, safe identifiers and usage only.
// Content is inspected transiently in memory, never persisted. Allowed Responses
// requests retain the configured origin/base path and are forwarded unchanged.
// Enforcement blocks oversized or unverifiable bodies before forwarding and
// stops after provider 413; the gateway never retries or compresses requests.
import { createServer, request as httpRequest, Agent as HttpAgent, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest, type AgentOptions as HttpsAgentOptions, type RequestOptions as HttpsRequestOptions } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import * as zlib from 'node:zlib';

export const MODEL_GATEWAY_MODES = ['off', 'measure', 'enforce'] as const;
export type ModelGatewayMode = typeof MODEL_GATEWAY_MODES[number];
export const MODEL_GATEWAY_RECORD_VERSION = 'model-gateway-measure-v1';
/** Appended after the Codex [stdout]/[stderr] sections of a private attempt exec log. */
export const MODEL_GATEWAY_EXEC_LOG_MARKER = '\n[bondbuddy-model-gateway]\n';
/** Requests at or above this size are also reported in the live worker log. */
export const MODEL_GATEWAY_LARGE_REQUEST_BYTES = 4 * 1024 * 1024;

export const MODEL_GATEWAY_MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = MODEL_GATEWAY_MAX_REQUEST_BYTES;
const MAX_DECODED_REQUEST_BYTES = 256 * 1024 * 1024;
const MAX_SSE_LINE_CHARS = 16 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_IMAGES_LISTED = 16;
const MAX_RECORDS = 5000;
const IMAGE_HEADER_BASE64_CHARS = 87384; // about 64 KiB decoded: PNG/GIF headers and most JPEG SOF markers
const PROXY_CONNECT_TIMEOUT_MS = 60_000;
// Longer than the client's idle-pool timeout, so the server never closes a reused
// keep-alive connection just as Codex starts its next request.
const SERVER_KEEP_ALIVE_MS = 15 * 60_000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const safeToken = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9._:-]+$/.test(v);
const safeKey = (v: unknown): string => typeof v === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : 'other';
const count = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
const jsonBytes = (v: unknown): number => { try { return Buffer.byteLength(JSON.stringify(v) ?? ''); } catch { return 0; } };

export type ModelGatewayImage = { location: string; mime: string | null; data_url_bytes: number; decoded_bytes: number; width: number | null; height: number | null };
export type ModelGatewayRequestShape = {
  analysis: 'parsed' | 'encoded' | 'not_json' | 'empty';
  content_encoding: string | null;
  json_bytes: number | null;
  model: string | null;
  stream: boolean | null;
  input_items: number | null;
  /** Item type (with role for messages) -> count and serialized bytes. */
  items: Record<string, { count: number; bytes: number }>;
  largest_item: { type: string; bytes: number } | null;
  instructions_bytes: number;
  tools_bytes: number;
  tool_count: number;
  image_count: number;
  /** Bytes the inline images occupy in the request body (data URL characters). */
  image_data_url_bytes: number;
  image_decoded_bytes: number;
  max_image_data_url_bytes: number;
  /** Images referenced by URL or file id rather than inline bytes. */
  image_refs: number;
  images: ModelGatewayImage[];
  images_omitted: number;
};
export type ModelGatewayUsage = { input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null; reasoning_tokens: number | null; total_tokens: number | null };
export type ModelGatewayResponseShape = {
  status: number;
  content_type: 'event-stream' | 'json' | 'html' | 'text' | 'other' | null;
  content_encoding: string | null;
  bytes: number;
  upstream_request_id: string | null;
  response_id: string | null;
  sse_events: number;
  terminal_event: string | null;
  usage: ModelGatewayUsage | null;
  error_type: string | null;
  error_code: string | null;
  parse: 'ok' | 'skipped' | 'incomplete';
};
export type ModelGatewayRecord = {
  kind: 'request'; v: string; seq: number; started_at: string; duration_ms: number;
  method: string; path: string; request_bytes: number;
  request: ModelGatewayRequestShape | null;
  response: ModelGatewayResponseShape | null;
  outcome: 'completed' | 'client_closed' | 'upstream_error' | 'gateway_rejected';
  gateway_error: string | null;
};
export type ModelGatewaySummary = {
  kind: 'summary'; v: string; mode: 'measure' | 'enforce'; upstream_host: string; proxied: boolean;
  requests: number; completed: number; client_closed: number; upstream_errors: number; gateway_rejected: number;
  status_counts: Record<string, number>;
  total_request_bytes: number; max_request_bytes: number; max_request_seq: number | null; last_request_bytes: number | null;
  max_image_count: number; max_image_data_url_bytes: number;
  first_413_seq: number | null; first_413_request_bytes: number | null;
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_tokens: number; responses_with_usage: number };
  records_retained: number; records_dropped: number;
};

// ---------------------------------------------------------------- request analysis

type DecodedBody = { kind: 'decoded'; body: Buffer } | { kind: 'too_large' | 'unverifiable' };
function decodeBody(body: Buffer, encoding: string, maxBytes = MAX_DECODED_REQUEST_BYTES): DecodedBody {
  const options = { maxOutputLength: maxBytes };
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return { kind: 'decoded', body: zlib.gunzipSync(body, options) };
    if (encoding === 'deflate') return { kind: 'decoded', body: zlib.inflateSync(body, options) };
    if (encoding === 'br') return { kind: 'decoded', body: zlib.brotliDecompressSync(body, options) };
    const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer, o: object) => Buffer }).zstdDecompressSync;
    if (encoding === 'zstd' && zstd) return { kind: 'decoded', body: zstd(body, options) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') return { kind: 'too_large' };
  }
  // Unsupported/stacked encodings, unavailable decoders and malformed bytes cannot
  // establish a decoded byte budget. Measurement still reports these as encoded.
  return { kind: 'unverifiable' };
}

/** Best-effort width/height from the image header; never decodes the whole image. */
export function imageDimensions(header: Buffer): { width: number; height: number } | null {
  if (header.length >= 24 && header.readUInt32BE(0) === 0x89504e47 && header.readUInt32BE(4) === 0x0d0a1a0a)
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  if (header.length >= 10 && header.toString('latin1', 0, 4) === 'GIF8')
    return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) };
  if (header.length >= 4 && header[0] === 0xff && header[1] === 0xd8) {
    let i = 2;
    while (i + 9 < header.length) {
      if (header[i] !== 0xff) { i++; continue; }
      const marker = header[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: header.readUInt16BE(i + 7), height: header.readUInt16BE(i + 5) };
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + header.readUInt16BE(i + 2);
    }
  }
  return null;
}

function measureImageUrl(url: string, location: string): ModelGatewayImage | null {
  if (!url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const mime = meta.split(';')[0].toLowerCase();
  const payloadChars = url.length - comma - 1;
  const base64 = /;base64$/i.test(meta);
  let decoded = payloadChars;
  let dims: { width: number; height: number } | null = null;
  if (base64) {
    const padding = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0;
    decoded = Math.max(0, Math.floor(payloadChars * 3 / 4) - padding);
    const take = Math.min(payloadChars, IMAGE_HEADER_BASE64_CHARS);
    try { dims = imageDimensions(Buffer.from(url.slice(comma + 1, comma + 1 + take - (take % 4)), 'base64')); } catch { dims = null; }
  }
  return { location, mime: /^image\/[a-z0-9.+-]{1,32}$/.test(mime) ? mime : null, data_url_bytes: Buffer.byteLength(url), decoded_bytes: decoded,
    width: dims?.width ?? null, height: dims?.height ?? null };
}

function collectImages(node: unknown, location: string, shape: ModelGatewayRequestShape, depth: number) {
  if (depth > 24 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) collectImages(child, location, shape, depth + 1); return; }
  const o = node as Record<string, unknown>;
  const nested = o.image_url && typeof o.image_url === 'object' ? (o.image_url as Record<string, unknown>).url : undefined;
  const url = typeof o.image_url === 'string' ? o.image_url : typeof nested === 'string' ? nested : null;
  if (o.type === 'input_image' || url !== null) {
    const image = url === null ? null : measureImageUrl(url, location);
    if (!image) { shape.image_refs++; return; }
    shape.image_count++;
    shape.image_data_url_bytes += image.data_url_bytes;
    shape.image_decoded_bytes += image.decoded_bytes;
    shape.max_image_data_url_bytes = Math.max(shape.max_image_data_url_bytes, image.data_url_bytes);
    if (shape.images.length < MAX_IMAGES_LISTED) shape.images.push(image); else shape.images_omitted++;
    return;
  }
  for (const value of Object.values(o)) if (value && typeof value === 'object') collectImages(value, location, shape, depth + 1);
}

function itemKey(item: unknown): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'other';
  const o = item as Record<string, unknown>;
  const type = o.type === undefined && typeof o.role === 'string' ? 'message' : safeKey(o.type);
  return type === 'message' && typeof o.role === 'string' ? type + ':' + safeKey(o.role) : type;
}

/** Shape of one Responses API request body. Content is inspected in memory and discarded. */
export function analyzeModelRequest(body: Buffer, contentEncoding?: string | null): ModelGatewayRequestShape {
  const encoding = contentEncoding ? contentEncoding.trim().toLowerCase() : null;
  const shape: ModelGatewayRequestShape = { analysis: 'empty', content_encoding: encoding ? (safeToken(encoding, 32) ? encoding : 'other') : null,
    json_bytes: null, model: null, stream: null, input_items: null, items: {}, largest_item: null, instructions_bytes: 0, tools_bytes: 0, tool_count: 0,
    image_count: 0, image_data_url_bytes: 0, image_decoded_bytes: 0, max_image_data_url_bytes: 0, image_refs: 0, images: [], images_omitted: 0 };
  if (!body.length) return shape;
  let json = body;
  if (encoding && encoding !== 'identity') {
    const decoded = decodeBody(body, encoding);
    if (decoded.kind !== 'decoded') return { ...shape, analysis: 'encoded' };
    json = decoded.body;
  }
  shape.json_bytes = json.length;
  let parsed: unknown;
  try { parsed = JSON.parse(json.toString('utf8')); } catch { return { ...shape, analysis: 'not_json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...shape, analysis: 'not_json' };
  const p = parsed as Record<string, unknown>;
  shape.analysis = 'parsed';
  shape.model = safeToken(p.model) ? p.model : null;
  shape.stream = typeof p.stream === 'boolean' ? p.stream : null;
  shape.instructions_bytes = typeof p.instructions === 'string' ? Buffer.byteLength(p.instructions) : 0;
  if (Array.isArray(p.tools)) { shape.tool_count = p.tools.length; shape.tools_bytes = jsonBytes(p.tools); }
  const add = (key: string, bytes: number) => {
    const entry = shape.items[key] ??= { count: 0, bytes: 0 };
    entry.count++; entry.bytes += bytes;
    if (!shape.largest_item || bytes > shape.largest_item.bytes) shape.largest_item = { type: key, bytes };
  };
  if (typeof p.input === 'string') { shape.input_items = 1; add('text', Buffer.byteLength(p.input)); }
  else if (Array.isArray(p.input)) {
    shape.input_items = p.input.length;
    for (const item of p.input) { const key = itemKey(item); add(key, jsonBytes(item)); collectImages(item, key, shape, 0); }
  }
  return shape;
}

// ---------------------------------------------------------------- response metering

function contentKind(value: string | undefined): ModelGatewayResponseShape['content_type'] {
  if (!value) return null;
  const v = value.toLowerCase();
  return v.includes('event-stream') ? 'event-stream' : v.includes('json') ? 'json' : v.includes('html') ? 'html' : v.startsWith('text/') ? 'text' : 'other';
}

function requestIdHeader(headers: IncomingHttpHeaders): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (!/(^|-)(request|trace)-?id$/i.test(name)) continue;
    const v = Array.isArray(value) ? value[0] : value;
    if (safeToken(v)) return v;
  }
  return null;
}

function usageOf(raw: unknown): ModelGatewayUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const detail = (k: string, f: string) => { const d = u[k]; return d && typeof d === 'object' ? count((d as Record<string, unknown>)[f]) : null; };
  return { input_tokens: count(u.input_tokens), cached_input_tokens: detail('input_tokens_details', 'cached_tokens'),
    output_tokens: count(u.output_tokens), reasoning_tokens: detail('output_tokens_details', 'reasoning_tokens'), total_tokens: count(u.total_tokens) };
}

/** Observes the bytes Codex receives. Parsing is bounded and can never alter the stream. */
export class ModelGatewayResponseMeter {
  private readonly shape: ModelGatewayResponseShape;
  private readonly decoder = new StringDecoder('utf8');
  private line = '';
  private overflow = false;
  private body: Buffer[] = [];
  private bodyBytes = 0;
  private readonly mode: 'sse' | 'body' | 'skip';
  private readonly bodyLimit: number;
  constructor(status: number, headers: IncomingHttpHeaders) {
    const rawEncoding = headers['content-encoding'];
    const encoding = typeof rawEncoding === 'string' ? rawEncoding.toLowerCase().trim() : null;
    const kind = contentKind(typeof headers['content-type'] === 'string' ? headers['content-type'] : undefined);
    this.shape = { status, content_type: kind, content_encoding: encoding ? (safeToken(encoding, 32) ? encoding : 'other') : null, bytes: 0,
      upstream_request_id: requestIdHeader(headers), response_id: null, sse_events: 0, terminal_event: null, usage: null, error_type: null, error_code: null,
      parse: 'ok' };
    const compressed = !!encoding && encoding !== 'identity';
    this.mode = compressed ? 'skip' : kind === 'event-stream' ? 'sse' : kind === 'json' ? 'body' : 'skip';
    this.bodyLimit = status >= 400 ? MAX_ERROR_BODY_BYTES : MAX_JSON_RESPONSE_BYTES;
    if (this.mode === 'skip') this.shape.parse = 'skipped';
  }
  push(chunk: Buffer) {
    this.shape.bytes += chunk.length;
    if (this.mode === 'sse') this.sse(this.decoder.write(chunk));
    else if (this.mode === 'body' && this.bodyBytes <= this.bodyLimit) { this.body.push(chunk); this.bodyBytes += chunk.length; }
  }
  private sse(text: string) {
    let start = 0;
    for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', start)) {
      if (!this.overflow) this.event(this.line + text.slice(start, nl));
      this.line = ''; this.overflow = false; start = nl + 1;
    }
    if (this.overflow) return;
    const rest = text.slice(start);
    if (this.line.length + rest.length > MAX_SSE_LINE_CHARS) { this.line = ''; this.overflow = true; this.shape.parse = 'incomplete'; return; }
    this.line += rest;
  }
  private event(line: string) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let e: unknown;
    try { e = JSON.parse(payload); } catch { this.shape.parse = 'incomplete'; return; }
    this.shape.sse_events++;
    this.apply(e);
  }
  private apply(e: unknown) {
    if (!e || typeof e !== 'object') return;
    const o = e as Record<string, unknown>;
    const response = o.response && typeof o.response === 'object' ? o.response as Record<string, unknown> : o.object === 'response' ? o : null;
    if (response && safeToken(response.id)) this.shape.response_id = response.id;
    const type = typeof o.type === 'string' ? o.type : null;
    if (type && ['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(type)) this.shape.terminal_event = type;
    if (response?.usage) this.shape.usage = usageOf(response.usage);
    const error = response?.error && typeof response.error === 'object' ? response.error : o.error && typeof o.error === 'object' ? o.error : type === 'error' ? o : null;
    if (error) {
      const err = error as Record<string, unknown>;
      if (safeToken(err.type, 64)) this.shape.error_type = err.type;
      if (safeToken(err.code, 64)) this.shape.error_code = err.code;
    }
  }
  finish(): ModelGatewayResponseShape {
    if (this.mode === 'sse') { const tail = this.line + this.decoder.end(); if (tail && !this.overflow) this.event(tail); this.line = ''; }
    if (this.mode === 'body') {
      if (this.bodyBytes > this.bodyLimit) this.shape.parse = 'incomplete';
      else if (this.bodyBytes) { try { this.apply(JSON.parse(Buffer.concat(this.body).toString('utf8'))); } catch { this.shape.parse = 'incomplete'; } }
      this.body = [];
    }
    return { ...this.shape, usage: this.shape.usage ? { ...this.shape.usage } : null };
  }
}

// ---------------------------------------------------------------- upstream transport

function bypassProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const h = host.toLowerCase();
  return noProxy.split(',').map(e => e.trim().toLowerCase()).filter(Boolean).some(entry => {
    if (entry === '*') return true;
    const name = entry.replace(/:\d+$/, '').replace(/^\*?\./, '');
    return h === name || h.endsWith('.' + name);
  });
}

/** The same HTTPS proxy selection the Codex child receives through its environment. */
export function selectModelGatewayProxy(upstream: URL, env: Record<string, string>): URL | null {
  if (upstream.protocol !== 'https:') return null;
  const raw = env.HTTPS_PROXY || env.https_proxy;
  if (!raw || bypassProxy(upstream.hostname, env.NO_PROXY || env.no_proxy)) return null;
  const proxy = new URL(raw);
  if (proxy.protocol !== 'http:' || proxy.username || proxy.password) throw new Error('MODEL_GATEWAY_PROXY_UNSUPPORTED');
  return proxy;
}

type TunnelCallback = (error: Error | null, socket: Duplex) => void;
/** HTTPS keep-alive pool whose sockets are TLS sessions inside an HTTP CONNECT tunnel. */
class ProxyTunnelAgent extends HttpsAgent {
  private readonly proxy: URL;
  constructor(proxy: URL, options: HttpsAgentOptions) { super(options); this.proxy = proxy; }
  // Node's agent accepts an asynchronous socket through the callback when this returns undefined.
  override createConnection(options: HttpsRequestOptions, callback?: TunnelCallback): Duplex | null | undefined {
    const host = String(options.host ?? options.hostname);
    const port = Number(options.port ?? 443);
    const authority = host + ':' + port;
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; callback?.(error, undefined as unknown as Duplex); } };
    const connect = httpRequest({ host: this.proxy.hostname, port: Number(this.proxy.port || 80), method: 'CONNECT', path: authority,
      headers: { host: authority }, agent: false, timeout: PROXY_CONNECT_TIMEOUT_MS });
    connect.once('connect', (response: IncomingMessage, socket: Socket, head: Buffer) => {
      if (response.statusCode !== 200) { socket.destroy(); fail(Object.assign(new Error('proxy CONNECT refused'), { code: 'PROXY_CONNECT_' + (response.statusCode ?? 0) })); return; }
      socket.setTimeout(0);
      if (head?.length) socket.unshift(head);
      const servername = typeof options.servername === 'string' && options.servername ? options.servername : host;
      const tls = tlsConnect({ socket, servername, ALPNProtocols: ['http/1.1'], ca: options.ca as string | Buffer | undefined,
        rejectUnauthorized: options.rejectUnauthorized !== false });
      settled = true;
      callback?.(null, tls);
    });
    connect.once('timeout', () => connect.destroy(Object.assign(new Error('proxy CONNECT timeout'), { code: 'PROXY_CONNECT_TIMEOUT' })));
    connect.once('error', error => fail(error));
    connect.end();
    return undefined;
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,48}$/.test(code) ? code : 'UPSTREAM_ERROR';
}

function forwardRequestHeaders(headers: IncomingHttpHeaders, host: string, length: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(n) || n === 'host' || n === 'content-length' || n === 'expect') continue;
    out[name] = value;
  }
  out.host = host;
  out['content-length'] = String(length);
  return out;
}

function forwardResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  return out;
}

function safePath(url: string | undefined): string {
  const path = (url ?? '').split('?')[0];
  return /^\/[A-Za-z0-9._\/-]{0,128}$/.test(path) ? path : '/other';
}

/** Validate the raw request target before WHATWG URL can normalize an authority or
 * path traversal. A final origin/path check also pins the configured provider base. */
function modelRequestTarget(raw: string | undefined, upstream: URL, prefix: string): URL | null {
  if (!raw || /[\\#\u0000-\u0020\u007f]/.test(raw)) return null;
  const path = raw.split('?')[0];
  if (path !== '/responses' && path !== '/responses/compact') return null;
  try {
    const target = new URL(prefix + raw, upstream.origin);
    return target.origin === upstream.origin && target.pathname === prefix + path
      && !target.username && !target.password && !target.hash ? target : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- gateway

export type ModelGatewayPayloadRejection = {
  source: 'local' | 'upstream';
  reason: 'wire_bytes' | 'decoded_bytes' | 'encoding_unverifiable' | 'upstream_413';
  code: 'MODEL_REQUEST_BUDGET_EXCEEDED' | 'MODEL_REQUEST_ENCODING_INVALID' | 'MODEL_PROVIDER_PAYLOAD_TOO_LARGE';
  status: 413 | 415;
  request_bytes: number;
  max_request_bytes: number;
};
export type ModelGatewayOptions = {
  upstreamBaseUrl: string;
  proxyEnv?: Record<string, string>;
  mode?: 'measure' | 'enforce';
  /** Test-only trust anchor for a synthetic TLS upstream; production uses the system store. */
  tlsCa?: string | Buffer;
  onRecord?: (record: ModelGatewayRecord) => void;
  /** Exactly once after the first enforcement rejection; the gateway remains latched. */
  onPayloadRejected?: (rejection: ModelGatewayPayloadRejection) => void;
  /** Required in enforce mode; applies to both wire bytes and decoded body bytes. */
  maxRequestBytes?: number;
};
export type ModelGateway = {
  readonly baseUrl: string;
  readonly proxied: boolean;
  records(): ModelGatewayRecord[];
  summary(): ModelGatewaySummary;
  close(): Promise<void>;
};

export async function startModelGateway(options: ModelGatewayOptions): Promise<ModelGateway> {
  const mode = options.mode ?? 'measure';
  if (!['measure', 'enforce'].includes(mode) || mode === 'enforce' &&
      (!Number.isSafeInteger(options.maxRequestBytes) || options.maxRequestBytes! < 1 || options.maxRequestBytes! > DEFAULT_MAX_REQUEST_BYTES))
    throw new Error('MODEL_GATEWAY_BUDGET_INVALID');
  const upstream = new URL(options.upstreamBaseUrl);
  if (!['https:', 'http:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash)
    throw new Error('MODEL_GATEWAY_UPSTREAM_INVALID');
  const prefix = upstream.pathname.replace(/\/+$/, '');
  const proxy = selectModelGatewayProxy(upstream, options.proxyEnv ?? {});
  const tlsOptions: HttpsAgentOptions = { keepAlive: true, maxSockets: 16, ...(options.tlsCa ? { ca: options.tlsCa } : {}) };
  const agent = upstream.protocol === 'http:' ? new HttpAgent({ keepAlive: true, maxSockets: 16 })
    : proxy ? new ProxyTunnelAgent(proxy, tlsOptions) : new HttpsAgent(tlsOptions);
  const send = upstream.protocol === 'http:' ? httpRequest : httpsRequest;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;

  const records: ModelGatewayRecord[] = [];
  let seq = 0, dropped = 0;
  const summary: ModelGatewaySummary = { kind: 'summary', v: MODEL_GATEWAY_RECORD_VERSION, mode, upstream_host: upstream.host, proxied: !!proxy,
    requests: 0, completed: 0, client_closed: 0, upstream_errors: 0, gateway_rejected: 0, status_counts: {},
    total_request_bytes: 0, max_request_bytes: 0, max_request_seq: null, last_request_bytes: null, max_image_count: 0, max_image_data_url_bytes: 0,
    first_413_seq: null, first_413_request_bytes: null,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, responses_with_usage: 0 }, records_retained: 0, records_dropped: 0 };
  const upstreamRequests = new Set<ReturnType<typeof httpRequest>>();
  let payloadRejection: ModelGatewayPayloadRejection | null = null;
  const latchPayloadRejection = (rejection: ModelGatewayPayloadRejection) => {
    if (payloadRejection) return;
    payloadRejection = rejection;
    // The budget remains enforced even if a lifecycle observer fails.
    try { options.onPayloadRejected?.(structuredClone(rejection)); } catch { /* already latched */ }
  };

  const keep = (record: ModelGatewayRecord) => {
    summary.requests++;
    if (record.outcome === 'completed') summary.completed++;
    else if (record.outcome === 'client_closed') summary.client_closed++;
    else if (record.outcome === 'upstream_error') summary.upstream_errors++;
    else summary.gateway_rejected++;
    summary.total_request_bytes += record.request_bytes;
    summary.last_request_bytes = record.request_bytes;
    if (summary.max_request_seq === null || record.request_bytes > summary.max_request_bytes) { summary.max_request_bytes = record.request_bytes; summary.max_request_seq = record.seq; }
    if (record.request) {
      summary.max_image_count = Math.max(summary.max_image_count, record.request.image_count);
      summary.max_image_data_url_bytes = Math.max(summary.max_image_data_url_bytes, record.request.image_data_url_bytes);
    }
    const status = record.response?.status;
    if (status) {
      summary.status_counts[String(status)] = (summary.status_counts[String(status)] ?? 0) + 1;
      if (status === 413 && summary.first_413_seq === null) { summary.first_413_seq = record.seq; summary.first_413_request_bytes = record.request_bytes; }
    }
    const usage = record.response?.usage;
    if (usage && usage.input_tokens !== null) {
      summary.usage.responses_with_usage++;
      summary.usage.input_tokens += usage.input_tokens; summary.usage.cached_input_tokens += usage.cached_input_tokens ?? 0;
      summary.usage.output_tokens += usage.output_tokens ?? 0; summary.usage.reasoning_tokens += usage.reasoning_tokens ?? 0;
    }
    if (records.length < MAX_RECORDS) records.push(record); else dropped++;
    try { options.onRecord?.(structuredClone(record)); } catch { /* observers cannot affect forwarding */ }
  };

  const reject = (res: ServerResponse, status: number, code: string) => {
    if (res.headersSent) { res.destroy(); return; }
    const body = JSON.stringify({ error: { type: 'model_gateway_error', code } });
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const t0 = process.hrtime.bigint();
    const record: ModelGatewayRecord = { kind: 'request', v: MODEL_GATEWAY_RECORD_VERSION, seq: ++seq, started_at: new Date().toISOString(), duration_ms: 0,
      method: safeToken(req.method, 16) ? req.method : 'OTHER', path: safePath(req.url), request_bytes: 0, request: null, response: null,
      outcome: 'completed', gateway_error: null };
    let meter: ModelGatewayResponseMeter | null = null;
    let done = false;
    const finalize = (outcome: ModelGatewayRecord['outcome'], gatewayError: string | null) => {
      if (done) return;
      done = true;
      record.outcome = outcome;
      record.gateway_error ??= gatewayError;
      try { record.response = meter ? meter.finish() : null; } catch { record.response = null; }
      record.duration_ms = Number((process.hrtime.bigint() - t0) / 1000000n);
      keep(record);
    };
    if (!['GET', 'POST'].includes(req.method ?? '')) { req.resume(); reject(res, 405, 'METHOD_NOT_ALLOWED'); finalize('gateway_rejected', 'METHOD_NOT_ALLOWED'); return; }
    const target = modelRequestTarget(req.url, upstream, prefix);
    if (!target) { req.resume(); reject(res, 400, 'PATH_INVALID'); finalize('gateway_rejected', 'PATH_INVALID'); return; }

    const chunks: Buffer[] = [];
    let received = 0, tooLarge = false;
    const rejectPayload = (rejection: ModelGatewayPayloadRejection, first: boolean) => {
      chunks.length = 0;
      record.request_bytes = received;
      reject(res, rejection.status, rejection.code);
      finalize('gateway_rejected', rejection.code);
      if (first) latchPayloadRejection(rejection);
    };
    if (payloadRejection) { req.resume(); rejectPayload(payloadRejection, false); return; }
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      received += chunk.length;
      if (payloadRejection) { rejectPayload(payloadRejection, false); return; }
      if (received > maxRequestBytes) {
        tooLarge = true;
        if (mode === 'enforce') rejectPayload({ source: 'local', reason: 'wire_bytes', code: 'MODEL_REQUEST_BUDGET_EXCEEDED', status: 413,
          request_bytes: received, max_request_bytes: maxRequestBytes }, true);
      } else chunks.push(chunk);
    });
    req.on('close', () => { if (!req.complete) { record.request_bytes = received; finalize('client_closed', null); } });
    req.on('end', () => {
      if (done) return;
      record.request_bytes = received;
      if (payloadRejection) { rejectPayload(payloadRejection, false); return; }
      if (tooLarge) {
        chunks.length = 0; reject(res, 413, 'GATEWAY_REQUEST_LIMIT'); finalize('gateway_rejected', 'GATEWAY_REQUEST_LIMIT');
        return;
      }
      const body = Buffer.concat(chunks);
      chunks.length = 0;
      const encoding = typeof req.headers['content-encoding'] === 'string' ? req.headers['content-encoding'].trim().toLowerCase() : null;
      if (mode === 'enforce' && encoding && encoding !== 'identity') {
        const decoded = decodeBody(body, encoding, maxRequestBytes);
        if (decoded.kind !== 'decoded') {
          const tooLarge = decoded.kind === 'too_large';
          rejectPayload({ source: 'local', reason: tooLarge ? 'decoded_bytes' : 'encoding_unverifiable',
            code: tooLarge ? 'MODEL_REQUEST_BUDGET_EXCEEDED' : 'MODEL_REQUEST_ENCODING_INVALID', status: tooLarge ? 413 : 415,
            request_bytes: received, max_request_bytes: maxRequestBytes }, true);
          return;
        }
      }
      const upstreamReq = send(target, { method: req.method, headers: forwardRequestHeaders(req.headers, upstream.host, body.length), agent });
      upstreamRequests.add(upstreamReq);
      upstreamReq.once('close', () => upstreamRequests.delete(upstreamReq));
      upstreamReq.on('response', (ures: IncomingMessage) => {
        meter = new ModelGatewayResponseMeter(ures.statusCode ?? 0, ures.headers);
        res.writeHead(ures.statusCode ?? 502, ures.statusMessage, forwardResponseHeaders(ures.headers));
        ures.on('data', (chunk: Buffer) => { try { meter?.push(chunk); } catch { /* metering never interrupts the stream */ } });
        ures.on('end', () => finalize('completed', null));
        ures.on('close', () => { if (!ures.complete) { res.destroy(); finalize('upstream_error', 'UPSTREAM_STREAM_ABORTED'); } });
        ures.on('error', () => { res.destroy(); finalize('upstream_error', 'UPSTREAM_STREAM_ERROR'); });
        ures.pipe(res);
        if (mode === 'enforce' && ures.statusCode === 413) {
          // Retain the authoritative response classification if the callback stops
          // Codex before the provider finishes its body or connection cleanup.
          record.gateway_error = 'MODEL_PROVIDER_PAYLOAD_TOO_LARGE';
          latchPayloadRejection({ source: 'upstream', reason: 'upstream_413', code: 'MODEL_PROVIDER_PAYLOAD_TOO_LARGE',
            status: 413, request_bytes: received, max_request_bytes: maxRequestBytes });
        }
      });
      upstreamReq.on('error', error => {
        if (!meter) reject(res, 502, errorCode(error)); else res.destroy();
        finalize('upstream_error', errorCode(error));
      });
      res.on('close', () => { if (!res.writableFinished) { upstreamReq.destroy(); finalize('client_closed', null); } });
      upstreamReq.end(body);
      // Analysis runs after the bytes are handed to the upstream socket.
      try { record.request = analyzeModelRequest(body, encoding); } catch { record.request = null; }
    });
  };

  const server = createServer({ requestTimeout: 0, keepAliveTimeout: SERVER_KEEP_ALIVE_MS }, handle);
  server.headersTimeout = 60_000;
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => { socket.end('HTTP/1.1 501 Not Implemented\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); });
  server.on('clientError', (_error: Error, socket: Duplex) => { try { socket.destroy(); } catch { /* already closed */ } });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | null = null;
  return {
    baseUrl: 'http://127.0.0.1:' + port,
    proxied: !!proxy,
    records: () => records.map(r => structuredClone(r)),
    summary: () => ({ ...structuredClone(summary), records_retained: records.length, records_dropped: dropped }),
    close: () => closing ??= new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
      for (const upstreamReq of upstreamRequests) upstreamReq.destroy();
      agent.destroy();
    }).then(() => new Promise<void>(resolve => setImmediate(resolve))),
  };
}

// ---------------------------------------------------------------- reporting

/** Bounded exec-log appendix: the summary always survives; middle request lines go first. */
export function formatModelGatewayExecLogSection(summary: ModelGatewaySummary, records: ModelGatewayRecord[], maxBytes: number): Buffer {
  const marker = Buffer.from(MODEL_GATEWAY_EXEC_LOG_MARKER);
  const head = Buffer.from(JSON.stringify(summary) + '\n');
  if (marker.length + head.length > maxBytes) return Buffer.alloc(0);
  const lines = records.map(r => Buffer.from(JSON.stringify(r) + '\n'));
  const total = lines.reduce((n, l) => n + l.length, 0);
  if (marker.length + head.length + total <= maxBytes) return Buffer.concat([marker, head, ...lines]);
  const omittedLine = (n: number) => Buffer.from(JSON.stringify({ kind: 'omitted', v: MODEL_GATEWAY_RECORD_VERSION, requests: n }) + '\n');
  let room = maxBytes - marker.length - head.length - omittedLine(lines.length).length;
  const first: Buffer[] = [], last: Buffer[] = [];
  for (let i = 0; i < Math.min(10, lines.length) && lines[i].length <= room; i++) { first.push(lines[i]); room -= lines[i].length; }
  for (let i = lines.length - 1; i >= first.length && lines[i].length <= room; i--) { last.unshift(lines[i]); room -= lines[i].length; }
  return Buffer.concat([marker, head, ...first, omittedLine(lines.length - first.length - last.length), ...last]);
}

export type ModelGatewayTrace = { run_id: string; call_id: string; logical_call_id: string; attempt_no: number };

/** Compact, content-free worker log line for a request worth seeing live; null otherwise. */
export function modelGatewayRequestLog(record: ModelGatewayRecord, trace?: ModelGatewayTrace): Record<string, unknown> | null {
  const status = record.response?.status ?? null;
  if (record.outcome === 'completed' && status !== null && status < 400 && record.request_bytes < MODEL_GATEWAY_LARGE_REQUEST_BYTES) return null;
  const r = record.request;
  return { kind: 'model_gateway', event: 'request', ...(trace ?? {}), seq: record.seq, outcome: record.outcome, gateway_error: record.gateway_error,
    status, request_bytes: record.request_bytes, input_items: r?.input_items ?? null, image_count: r?.image_count ?? null,
    image_data_url_bytes: r?.image_data_url_bytes ?? null, max_image_data_url_bytes: r?.max_image_data_url_bytes ?? null,
    largest_item: r?.largest_item ?? null, upstream_request_id: record.response?.upstream_request_id ?? null, duration_ms: record.duration_ms };
}
