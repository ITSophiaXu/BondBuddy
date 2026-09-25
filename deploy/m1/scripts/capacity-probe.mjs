#!/usr/bin/env node
// #35 capacity probe against a deployed M1 stack (synthetic accounts and data only; never calls models).
// Usage:
//   node capacity-probe.mjs auth <base> <origin> <concurrency> [rounds=6]
//   node capacity-probe.mjs upload <base> <origin> <file> <txt|pdf|docx> [count=1]
//   node capacity-probe.mjs trial-projects <base> <origin> [attempts=25]
//   node capacity-probe.mjs trial-uploads <base> <origin> [attempts=130]
// Every mode registers fresh throwaway users. It exits non-zero after 3 responses >= 500 (5xx burst).
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';

const [mode, base, origin, ...rest] = process.argv.slice(2);
if (!mode || !base || !origin) { console.error('see usage in header'); process.exit(2); }
let fiveXX = 0;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] : null; };
const stats = xs => ({ n: xs.length, p50_ms: pct(xs, 50), p95_ms: pct(xs, 95), max_ms: xs.length ? Math.max(...xs) : null });

function client() {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function call(method, path, { json, file, bytes } = {}) {
    const h = { Origin: origin, Cookie: cookie() };
    if (method !== 'GET' && jar.get('bb_csrf')) h['X-BB-CSRF'] = jar.get('bb_csrf');
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (file) { h['Content-Type'] = 'application/octet-stream'; h['Content-Length'] = String(bytes); body = Readable.toWeb(createReadStream(file)); }
    const t = performance.now();
    const r = await fetch(base + path, { method, headers: h, body, duplex: 'half' });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text();
    const ms = Math.round(performance.now() - t);
    if (r.status >= 500 && ++fiveXX >= 3) { console.error(JSON.stringify({ abort: '5xx burst', path, status: r.status })); process.exit(3); }
    let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, data, ms };
  }
  return { call, jar, cookie };
}
const terms = async () => (await (await fetch(`${base}/api/v1/auth/agreement`)).json()).terms_version;
async function register(c, tv) {
  const username = `cap_${randomBytes(5).toString('hex')}`, password = randomBytes(12).toString('hex');
  const r = await c.call('POST', '/api/v1/auth/register', { json: { username, password, accepted_terms_version: tv } });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register ${r.status} ${JSON.stringify(r.data)}`);
  return { username, password, ms: r.ms };
}
const project = c => c.call('POST', '/api/v1/projects', { json: { name: 'capacity probe (synthetic)', kind: 'update', issuer_name: null, market: null, offering: null } });

// Reads the parse-job SSE stream until a terminal job state is seen, reconnecting when the proxy closes it.
async function waitParse(c, projectId, materialId, timeoutMs = Number(process.env.BB_PARSE_WAIT_MS ?? 180_000)) {
  const t = performance.now(); let r, reconnects = 0;
  do { r = await waitParseOnce(c, projectId, materialId, timeoutMs - (performance.now() - t)); if (!r.timeout_or_closed) break; reconnects++; await new Promise(res => setTimeout(res, 10_000)); } while (performance.now() - t < timeoutMs);
  return { ...r, reconnects, ms: Math.round(performance.now() - t) };
}
async function waitParseOnce(c, projectId, materialId, timeoutMs = Number(process.env.BB_PARSE_WAIT_MS ?? 180_000)) {
  const t = performance.now();
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let last = null;
  try {
    const r = await fetch(`${base}/api/v1/projects/${projectId}/materials/${materialId}/parse-job/stream`, { headers: { Origin: origin, Cookie: c.cookie(), Accept: 'text/event-stream' }, signal: ctl.signal });
    if (r.status !== 200) return { status: r.status, ms: Math.round(performance.now() - t) };
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = ev.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        try { const d = JSON.parse(data); const s = d.state ?? d.payload?.state; if (s) last = { state: s, stage: d.stage ?? null, outcome: d.outcome ?? null, parse_status: d.parse_status ?? null, error_code: d.error_code ?? null }; } catch { /* keepalive */ }
        if (last && ['succeeded', 'failed', 'cancelled'].includes(last.state)) { ctl.abort(); return { ...last, ms: Math.round(performance.now() - t) }; }
      }
    }
  } catch (e) { if (!ctl.signal.aborted) return { error: String(e), last, ms: Math.round(performance.now() - t) }; }
  finally { clearTimeout(timer); }
  return { timeout_or_closed: true, last, ms: Math.round(performance.now() - t) };
}

if (mode === 'auth') {
  const conc = Number(rest[0]), rounds = Number(rest[1] ?? 6), tv = await terms();
  const reg = [], login = [], list = [], errors = [];
  const worker = async () => {
    for (let k = 0; k < rounds; k++) {
      try {
        const u = await register(client(), tv); reg.push(u.ms);
        const c = client();
        const l = await c.call('POST', '/api/v1/auth/login', { json: { username: u.username, password: u.password } });
        if (l.status !== 200) { errors.push({ step: 'login', status: l.status, code: l.data?.code }); continue; }
        login.push(l.ms);
        const p = await c.call('GET', '/api/v1/projects');
        if (p.status !== 200) errors.push({ step: 'projects', status: p.status, code: p.data?.code }); else list.push(p.ms);
      } catch (e) { errors.push({ error: String(e).slice(0, 200) }); }
    }
  };
  const t = performance.now();
  await Promise.all(Array.from({ length: conc }, worker));
  console.log(JSON.stringify({ mode, concurrency: conc, rounds, wall_ms: Math.round(performance.now() - t), register: stats(reg), login: stats(login), get_projects: stats(list), errors }));
} else if (mode === 'upload') {
  const [file, type, countArg = '1'] = rest, count = Number(countArg);
  const size = statSync(file).size, sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const mediaType = { txt: 'text/plain', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }[type];
  const role = type === 'txt' ? 'audit' : 'historical';
  const c = client(); await register(c, await terms());
  const p = await project(c); if (p.status !== 201) throw new Error(`project ${p.status} ${JSON.stringify(p.data)}`);
  const pid = p.data.project_id;
  const one = async i => {
    const t = performance.now();
    const cr = await c.call('POST', `/api/v1/projects/${pid}/materials/uploads`, { json: { filename: `cap-${i}.${type}`, media_type: mediaType, byte_size: size, sha256, role } });
    if (cr.status !== 201) return { i, step: 'create', status: cr.status, code: cr.data?.code };
    const put = await c.call('PUT', cr.data.upload_url, { file, bytes: size });
    if (put.status !== 204) return { i, step: 'put', status: put.status, code: put.data?.code, ms: put.ms };
    const done = await c.call('POST', `/api/v1/projects/${pid}/materials/uploads/${cr.data.upload_id}/complete`, { json: { byte_size: size, sha256 } });
    const uploadMs = Math.round(performance.now() - t);
    if (done.status !== 200 && done.status !== 201) return { i, step: 'complete', status: done.status, code: done.data?.code, put_ms: put.ms, upload_ms: uploadMs };
    const parse = await waitParse(c, pid, done.data.material_id);
    return { i, status: done.status, material_state: done.data.state ?? null, put_ms: put.ms, complete_ms: done.ms, upload_ms: uploadMs, parse, end_to_end_ms: Math.round(performance.now() - t) };
  };
  const t = performance.now();
  const results = await Promise.all(Array.from({ length: count }, (_, i) => one(i).catch(e => ({ i, error: String(e).slice(0, 300) }))));
  console.log(JSON.stringify({ mode, type, size, count, wall_ms: Math.round(performance.now() - t), results }));
} else if (mode === 'trial-projects' || mode === 'trial-uploads') {
  const attempts = Number(rest[0] ?? (mode === 'trial-projects' ? 25 : 130));
  const c = client(); await register(c, await terms());
  let pid;
  if (mode === 'trial-uploads') { const p = await project(c); pid = p.data.project_id; }
  const body = randomBytes(64), sha256 = createHash('sha256').update(body).digest('hex');
  let ok = 0;
  for (let k = 1; k <= attempts; k++) {
    const r = mode === 'trial-projects' ? await project(c)
      : await c.call('POST', `/api/v1/projects/${pid}/materials/uploads`, { json: { filename: `guard-${k}.txt`, media_type: 'text/plain', byte_size: body.length, sha256, role: 'audit' } });
    if (r.status === 201) { ok++; continue; }
    console.log(JSON.stringify({ mode, accepted_before_rejection: ok, rejected_attempt: k, status: r.status, code: r.data?.code, detail: r.data?.detail ?? r.data?.message ?? r.data?.title, body: r.data }));
    process.exit(0);
  }
  console.log(JSON.stringify({ mode, accepted: ok, attempts, tripped: false }));
} else { console.error('unknown mode'); process.exit(2); }
