import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const site=join(root,'public');
let html=await readFile(join(site,'index.html'),'utf8');
const css=await readFile(join(site,'website.css'),'utf8');
const js=await readFile(join(site,'website.js'),'utf8');
html=html.replace('<link rel="stylesheet" href="website.css">',()=>`<style>${css}</style>`);
html=html.replace('  <script src="website.js" defer></script>','');
const assets=[...new Set([...html.matchAll(/(?:src|href)="(assets\/[^\"]+)"/g)].map(match=>match[1]))];
for(const asset of assets){const data=await readFile(join(site,asset));html=html.replaceAll(`"${asset}"`,`"data:image/svg+xml;base64,${data.toString('base64')}"`);}
html=html.replace('</body>',()=>`<script>${js}</script>\n</body>`);
await mkdir(join(root,'exports'),{recursive:true});
await writeFile(join(root,'exports','bondbuddy-landing.html'),html);
console.log('Exported exports/bondbuddy-landing.html with embedded styles, script and illustrations.');
