import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('CSP permits only the configured private Blob origin alongside same-origin connections',()=>{
 const config=read('nginx/security-headers.conf');
 const csp=config.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];assert.ok(csp);
 const directives=new Map(csp.split(';').map(d=>d.trim().split(/\s+/)).filter(d=>d[0]).map(([k,...v])=>[k,v]));
 assert.deepEqual(directives.get('connect-src'),["'self'",'https://myopenhands.blob.core.windows.net']);
 assert.deepEqual(directives.get('frame-ancestors'),["'none'"]);
 assert.deepEqual(directives.get('default-src'),["'self'"]);
 const locations=[...read('nginx/default.conf').matchAll(/^\s*location[^\n{]+\{\s*\n([\s\S]*?)^  \}/gm)].map(match=>match[1]);
 assert.ok(locations.length);assert.ok(locations.every(l=>l.includes('include /etc/nginx/conf.d/snippets/security-headers.conf;')));
});
test('direct upload feature flag defaults off in both deployment roles',()=>{
 for(const name of ['compose.yaml','compose.main.yaml'])assert.match(read(name),/BB_DIRECT_BLOB_UPLOADS: \$\{BB_DIRECT_BLOB_UPLOADS:-0\}/);
});
