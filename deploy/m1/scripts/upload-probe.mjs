#!/usr/bin/env node
// Upload capacity probe (synthetic data only). Registers a throwaway user, creates a project and
// uploads N copies of a generated file concurrently through create -> PUT bytes -> complete.
// Usage: node upload-probe.mjs <base-url> <origin> <terms-version> <bytes> [count=1] [type=txt|pdf|docx|xlsx]
// docx/xlsx need BB_PROBE_FILE (see office-sample.mjs). BB_PROBE_DOWNLOAD=1 downloads each saved material
// again and checks its streamed sha256.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const [base, origin, terms, sizeArg, countArg = '1', type = 'txt'] = process.argv.slice(2);
if (!base || !origin || !terms || !sizeArg) { console.error('usage: upload-probe.mjs <base-url> <origin> <terms> <bytes> [count] [txt|pdf]'); process.exit(2); }
let size = Number(sizeArg);
const count = Number(countArg);
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
async function call(method, path, { json, file, bytes, headers = {} } = {}) {
  const h = { Origin: origin, Cookie: cookieHeader(), ...headers };
  if (method !== 'GET' && jar.get('bb_csrf')) h['X-BB-CSRF'] = jar.get('bb_csrf');
  let body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (file) { h['Content-Type'] = 'application/octet-stream'; h['Content-Length'] = String(bytes); body = Readable.toWeb(createReadStream(file)); }
  const r = await fetch(base + path, { method, headers: h, body, duplex: 'half' });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, data };
}

// Text: ASCII lines. PDF: one valid page followed by a large comment-free binary-safe stream object.
async function generate(path) {
  const out = createWriteStream(path);
  const hash = createHash('sha256');
  const write = chunk => new Promise(resolve => { hash.update(chunk); out.write(chunk) ? resolve() : out.once('drain', resolve); });
  if (type === 'txt') {
    const line = Buffer.from('BondBuddy synthetic capacity probe line 0123456789 abcdefghijklmnopqrstuvwxyz\n');
    const block = Buffer.concat(Array(Math.ceil(1024 * 1024 / line.length)).fill(line)).subarray(0, 1024 * 1024);
    let left = size;
    while (left > 0) { const part = block.subarray(0, Math.min(left, block.length)); await write(part); left -= part.length; }
  } else {
    const objs = [];
    const head = '%PDF-1.4\n';
    const parts = [head];
    let offset = head.length;
    const add = s => { objs.push(offset); parts.push(s); offset += Buffer.byteLength(s, 'latin1'); };
    add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    add('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    add('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n');
    const content = 'BT /F1 12 Tf 10 100 Td ET\n';
    add(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
    const fixedTail = 400;
    const padLength = size - offset - fixedTail;
    const padHead = `5 0 obj\n<< /Length ${padLength} >>\nstream\n`;
    const padTail = '\nendstream\nendobj\n';
    const padBytes = padLength - padHead.length - padTail.length;
    await write(Buffer.from(parts.join(''), 'latin1'));
    objs.push(offset);
    await write(Buffer.from(padHead, 'latin1'));
    const block = Buffer.alloc(1024 * 1024, 0x41);
    let left = padBytes;
    while (left > 0) { const part = block.subarray(0, Math.min(left, block.length)); await write(part); left -= part.length; }
    await write(Buffer.from(padTail, 'latin1'));
    offset += padLength - (padLength - padHead.length - padTail.length - padBytes);
    const xrefAt = offset + 0;
    let xref = `xref\n0 6\n0000000000 65535 f \n${objs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n`;
    const current = size - fixedTail;
    xref = xref + `${current}\n%%EOF\n`;
    const pad = fixedTail - Buffer.byteLength(xref, 'latin1');
    if (pad < 0) throw new Error('PDF tail too small');
    // Pad before xref with whitespace; startxref points at the xref keyword.
    const final = ' '.repeat(pad) + xref.replace(`startxref\n${current}`, `startxref\n${current + pad}`);
    await write(Buffer.from(final.slice(0, fixedTail), 'latin1'));
    void xrefAt;
  }
  await new Promise(resolve => out.end(resolve));
  return hash.digest('hex');
}

// BB_PROBE_WRITE=<path>: only generate the file (for local inspection measurements).
if (process.env.BB_PROBE_WRITE) { console.log(await generate(process.env.BB_PROBE_WRITE)); process.exit(0); }
const dir = await mkdtemp(join(tmpdir(), 'bb-upload-probe-'));
try {
  // BB_PROBE_FILE=<path>: upload an existing synthetic file instead of generating one (size arg is ignored).
  const file = process.env.BB_PROBE_FILE || join(dir, `probe.${type}`);
  const sha256 = process.env.BB_PROBE_FILE ? createHash('sha256').update(readFileSync(file)).digest('hex') : await generate(file);
  if (process.env.BB_PROBE_FILE) size = statSync(file).size;
  if (statSync(file).size !== size) throw new Error(`generated ${statSync(file).size} bytes, wanted ${size}`);
  const user = `probe_${randomBytes(4).toString('hex')}`;
  const reg = await call('POST', '/api/v1/auth/register', { json: { username: user, password: randomBytes(12).toString('hex'), accepted_terms_version: terms } });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`register ${reg.status} ${JSON.stringify(reg.data)}`);
  const proj = await call('POST', '/api/v1/projects', { json: { name: 'capacity probe', kind: 'update', issuer_name: null, market: null, offering: null } });
  if (proj.status !== 201) throw new Error(`project ${proj.status} ${JSON.stringify(proj.data)}`);
  const projectId = proj.data.project_id;
  const mediaType = { txt: 'text/plain', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[type];
  if (!mediaType || ((type === 'docx' || type === 'xlsx') && !process.env.BB_PROBE_FILE)) throw new Error(`unsupported probe type ${type}`);
  const role = type === 'txt' ? 'audit' : 'historical';
  const one = async i => {
    const started = Date.now();
    const created = await call('POST', `/api/v1/projects/${projectId}/materials/uploads`, { json: { filename: `probe-${i}.${type}`, media_type: mediaType, byte_size: size, sha256, role } });
    if (created.status !== 201) return { i, step: 'create', status: created.status, body: created.data };
    const put = await call('PUT', created.data.upload_url, { file, bytes: size });
    const putMs = Date.now() - started;
    if (put.status !== 204) return { i, step: 'put', status: put.status, body: put.data, ms: putMs };
    const done = await call('POST', `/api/v1/projects/${projectId}/materials/uploads/${created.data.upload_id}/complete`, { json: { byte_size: size, sha256 } });
    let download;
    if (process.env.BB_PROBE_DOWNLOAD && (done.status === 200 || done.status === 201)) {
      const began = Date.now();
      const r = await fetch(`${base}/api/v1/projects/${projectId}/materials/${done.data.material_id}/download`, { headers: { Origin: origin, Cookie: cookieHeader() } });
      const hash = createHash('sha256');
      let received = 0;
      try { for await (const chunk of r.body) { received += chunk.length; hash.update(chunk); } } catch (error) { download = { error: String(error) }; }
      download = { status: r.status, received, sha256_match: hash.digest('hex') === sha256, ms: Date.now() - began, ...download };
    }
    return { i, step: 'complete', status: done.status, download, body: done.status === 201 || done.status === 200 ? { state: done.data?.state, byte_size: done.data?.byte_size } : done.data, put_ms: putMs, total_ms: Date.now() - started };
  };
  const results = await Promise.all(Array.from({ length: count }, (_, i) => one(i).catch(error => ({ i, error: String(error) }))));
  console.log(JSON.stringify({ type, size, count, results }, null, 1));
} finally {
  await rm(dir, { recursive: true, force: true });
}
