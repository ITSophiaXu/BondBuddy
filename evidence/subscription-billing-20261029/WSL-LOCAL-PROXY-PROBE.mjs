import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';

const [keyFile, certFile] = process.argv.slice(2);
assert.ok(keyFile && certFile, 'synthetic local certificate paths are required');
const sockets = new Set();
const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
let connects = 0;
let originHits = 0;
const origin = createHttpsServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (_req, res) => {
  originHits++;
  res.writeHead(200, { connection: 'close' });
  res.end('synthetic-local-only');
});
origin.on('connection', track);
const proxy = createHttpServer();
proxy.on('connection', track);
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
const originPort = origin.address().port;
proxy.on('connect', (req, client, head) => {
  assert.equal(req.url, `127.0.0.1:${originPort}`, 'proxy must only serve our local origin');
  connects++;
  const upstream = connect(originPort, '127.0.0.1');
  track(upstream);
  upstream.on('connect', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const target = `https://127.0.0.1:${originPort}/`;
async function childFetch(proxyAddress, bypass) {
  const code = `fetch(${JSON.stringify(target)}, {signal: AbortSignal.timeout(2000)}).then(async r => {if(r.status !== 200 || await r.text() !== 'synthetic-local-only') throw Error('unexpected response'); process.stdout.write('ok');}, () => {process.stdout.write('rejected');process.exitCode=2;});`;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', code], { env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      NODE_USE_ENV_PROXY: '1', NODE_EXTRA_CA_CERTS: certFile,
      HTTPS_PROXY: proxyAddress, https_proxy: proxyAddress,
      NO_PROXY: bypass, no_proxy: bypass,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
try {
  const via = await childFetch(proxyUrl, '');
  assert.equal(via.code, 0, `local CONNECT failed: ${via.stdout}`);
  assert.equal(connects, 1);
  assert.equal(originHits, 1);
  const broken = await childFetch('http://127.0.0.1:1', '');
  assert.equal(broken.code, 2, 'unreachable proxy must reject');
  assert.equal(originHits, 1, 'unreachable proxy must never fall back to direct origin');
  const direct = await childFetch(proxyUrl, 'localhost,127.0.0.1');
  assert.equal(direct.code, 0, `loopback bypass failed: ${direct.stdout}`);
  assert.equal(connects, 1, 'NO_PROXY must bypass the recording proxy');
  assert.equal(originHits, 2);
  console.log(JSON.stringify({ node: process.version, releaseSha: process.env.BB_RELEASE_SHA ?? null, passed: true, checks: { httpsConnect: true, unavailableProxyRejectsWithoutDirectFallback: true, noProxyLoopback: true, syntheticCertificateValidated: true }, connects, originHits, externalRequests: 0 }));
} finally {
  for (const socket of sockets) socket.destroy();
  proxy.close(); origin.close();
}
