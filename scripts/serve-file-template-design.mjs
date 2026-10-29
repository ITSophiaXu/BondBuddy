import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local design preview only. No product API, credentials, tasks, uploads or billing.
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = await realpath(resolve(option('--dir', fileURLToPath(new URL('../product-prototype/public', import.meta.url)))));
const port = Number(option('--port', '4379'));
const allowed = new Set(['file-templates-v2.html', 'file-templates-v2.css', 'file-templates-v2.js', 'file-templates-v2-data.js']);
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript; charset=utf-8', '.png':'image/png' };
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    if (!['127.0.0.1', 'localhost'].includes((req.headers.host ?? '').split(':')[0])) { res.writeHead(403).end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\//, '');
    const name = pathname || 'file-templates-v2.html';
    if (!allowed.has(name) && !/^assets\/[\w-]+\.png$/.test(name)) { res.writeHead(404).end(); return; }
    const target = await realpath(resolve(root, name));
    if (!target.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[extname(target)], 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404).end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Design preview: http://127.0.0.1:${port}/file-templates-v2.html`));
