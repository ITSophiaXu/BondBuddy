import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const port = Number(process.env.PORT || 4321);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(root + sep) || !mime[extname(target)] || !(await stat(target)).isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const content = await readFile(target);
    res.writeHead(200, { 'Content-Type': mime[extname(target)], 'Content-Length': content.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`BondBuddy landing page: http://127.0.0.1:${server.address().port}`));
