import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'design-previews/update-workspace.fragment.html');
const pagePath = path.join(root, 'public/previews/update-workspace.html');
const source = fs.readFileSync(sourcePath, 'utf8').trim();
const page = fs.readFileSync(pagePath, 'utf8');
const start = '<!-- BOND_BUDDY_UPDATE_PREVIEW_START -->';
const end = '<!-- BOND_BUDDY_UPDATE_PREVIEW_END -->';
const escape = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]));

if (!source.startsWith(start) || !source.endsWith(end)) throw new Error('Preview source boundary markers are missing.');
if (/<(?:!doctype|html|head|body)(?:\s|>)/i.test(source)) throw new Error('Preview source must remain an HTML fragment.');
const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (scripts.length !== 1) throw new Error('Expected one local preview script.');
new vm.Script(scripts[0][1], { filename: sourcePath });

const encodedStart = escape(start), encodedEnd = escape(end);
const startAt = page.indexOf(encodedStart), endAt = page.indexOf(encodedEnd);
if (startAt < 0 || endAt < startAt || page.indexOf(encodedStart, startAt + 1) !== -1 || page.indexOf(encodedEnd, endAt + 1) !== -1) {
  throw new Error('Expected one encoded preview fragment in the standalone page.');
}
const next = page.slice(0, startAt) + escape(source) + page.slice(endAt + encodedEnd.length);
if (process.argv.includes('--check')) {
  if (next !== page) throw new Error('Standalone preview is stale. Run node scripts/build-update-workspace-preview.mjs.');
  console.log('Preview source syntax and standalone synchronization: OK');
} else {
  if (next !== page) fs.writeFileSync(pagePath, next, 'utf8');
  console.log('Standalone preview synchronized: public/previews/update-workspace.html');
}
