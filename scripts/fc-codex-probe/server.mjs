import http from 'node:http';
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 9000);
const limit = 16 * 1024;

function run(command, args, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: '/app',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const collect = (kind, chunk) => {
      const current = kind === 'stdout' ? stdout : stderr;
      const remaining = Math.max(0, limit - current.length);
      if (chunk.length > remaining) truncated = true;
      const next = current + chunk.toString('utf8').slice(0, remaining);
      if (kind === 'stdout') stdout = next;
      else stderr = next;
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.code || error.message, elapsed_ms: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, signal, elapsed_ms: Date.now() - started,
        stdout, stderr, truncated });
    });
  });
}

function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') return respond(res, 200, { ok: true, probe: 'fc-codex' });
  if (req.method !== 'POST') return respond(res, 405, { error: 'method_not_allowed' });
  let bytes = 0;
  let body = '';
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 4096) return respond(res, 413, { error: 'payload_too_large' });
      body += chunk.toString('utf8');
    }
    const input = body ? JSON.parse(body) : {};
    const mode = input.mode || 'platform';
    if (!['platform', 'sandbox', 'model'].includes(mode))
      return respond(res, 400, { error: 'invalid_mode' });

    if (mode === 'model' && (process.env.BB_FC_PROBE_ALLOW_MODEL !== '1' || !process.env.DEEPSEEK_API_KEY))
      return respond(res, 412, { error: 'model_probe_not_configured',
        required_environment: ['BB_FC_PROBE_ALLOW_MODEL=1', 'DEEPSEEK_API_KEY'] });

    const results = {};
    if (mode === 'platform') {
      results.codex = await run('codex', ['--version'], 10_000);
      results.bwrap = await run('bwrap', ['--version'], 10_000);
      results.user_namespace = await run('unshare', ['-Ur', 'true'], 10_000);
      results.bwrap_namespace = await run('bwrap', ['--unshare-user', '--unshare-pid',
        '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc',
        '--', '/bin/true'], 10_000);
    } else if (mode === 'sandbox') {
      results.file_sandbox = await run('node', ['/opt/fc-codex-probe/diagnose-file-sandbox.mjs'], 35_000);
    } else if (mode === 'model') {
      results.model_runtime = await run('node', [
        '/app/apps/worker/dist/codex-probe-cli.js',
        '--prompt-file', '/opt/fc-codex-probe/model-prompt.txt',
        '--timeout-ms', '90000',
      ], 100_000);
    }
    respond(res, Object.values(results).every(result => result.ok) ? 200 : 500,
      { mode, results });
  } catch (error) {
    respond(res, 400, { error: 'invalid_request', detail: String(error.message || error) });
  }
});

server.listen(port, '0.0.0.0');
