import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root=process.cwd();
const input=resolve('.local/billing-segments-20261027');
const output=resolve('docs/acceptance/desktop-ux-coverage-20261026/original-billing-segments');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const final=json(join(input,'final-evidence.json')),stop=json(join(input,'pg-stop.json'));
assert.equal(final.success,true);assert.equal(stop.success,true);
assert.equal(stop.processGone,true);assert.equal(stop.listenersAfter,0);
assert(!existsSync(resolve('.local/test-successor-postgres/data/postmaster.pid')));
const sources=json(join(input,'sources-final.json'));assert.equal(sources.length,1429);
for(const file of sources){const bytes=readFileSync(resolve(file.path));assert.equal(bytes.length,file.bytes,file.path);assert.equal(sha(bytes),file.sha256,file.path);}
assert(!existsSync(join(output,'records')),'Never overwrite sealed records');
assert(!existsSync(join(output,'manifest.json')),'Never overwrite sealed manifest');
const manifest=[];
function save(path,bytes){const target=join(output,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx'});manifest.push({path,bytes:bytes.length,sha256:sha(bytes)});}
function walk(directory){for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  assert(!entry.isSymbolicLink(),'Unexpected evidence symlink');const path=join(directory,entry.name);
  if(entry.isDirectory())walk(path);else{assert(entry.isFile());save('records/'+relative(input,path).replaceAll('\\','/'),readFileSync(path));}
}}
walk(input);
const readme=readFileSync(join(output,'README.md'));manifest.push({path:'README.md',bytes:readme.length,sha256:sha(readme)});
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
for(const file of manifest){const bytes=readFileSync(join(output,file.path));assert.equal(bytes.length,file.bytes);assert.equal(sha(bytes),file.sha256);}
process.stdout.write(JSON.stringify({success:true,output,files:manifest.length,sourceEntries:sources.length,adopted:Object.fromEntries(Object.entries(final.accepted).map(([k,v])=>[k,v.totals]))})+'\n');
