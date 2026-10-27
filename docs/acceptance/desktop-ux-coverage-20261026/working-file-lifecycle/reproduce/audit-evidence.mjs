import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,relative,join,isAbsolute,dirname} from 'node:path';
const root=process.cwd(),base='docs/acceptance/desktop-ux-coverage-20261026/working-file-lifecycle',target=resolve(root,base);
const manifest=JSON.parse(readFileSync(join(target,'manifest.json'),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),files=[];
const walk=dir=>{for(const item of readdirSync(dir,{withFileTypes:true})){const path=join(dir,item.name);assert(!item.isSymbolicLink());if(item.isDirectory())walk(path);else{assert(lstatSync(path).isFile());files.push(relative(target,path).replaceAll('\\','/'));}}};walk(target);
assert.equal(manifest.includes_private_byte_store,false);assert.equal(manifest.includes_generated_word,false);
assert.deepEqual(files.filter(path=>path!=='manifest.json').sort(),manifest.files.map(file=>file.path).sort());
for(const file of manifest.files){
 const path=resolve(target,file.path),part=relative(target,path);assert(part&&!part.startsWith('..')&&!isAbsolute(part));
 assert(!/(?:private-bytes|\.docx$|\.pdf$)/i.test(file.path));
 const bytes=readFileSync(path);assert.equal(bytes.length,file.bytes,file.path);assert.equal(sha(bytes),file.sha256,file.path);
}
let links=0;const readme=join(target,'README.md');
for(const match of readFileSync(readme,'utf8').matchAll(/\]\(([^)]+)\)/g)){
 const link=match[1].replace(/^<|>$/g,'').split('#')[0];if(!link||/^[a-z]+:\/\//i.test(link))continue;
 assert(existsSync(resolve(dirname(readme),decodeURIComponent(link))),`Missing README link: ${link}`);links++;
}
if(process.argv.includes('--staged'))for(const file of files){
 const checked=spawnSync('git',['show',`:${base}/${file}`],{windowsHide:true,maxBuffer:64*1024*1024});
 assert.equal(checked.status,0,`Missing staged evidence: ${file}`);assert.equal(sha(checked.stdout),sha(readFileSync(join(target,file))),`Staged bytes differ: ${file}`);
}
console.log(JSON.stringify({manifest_files:manifest.files.length,total_files:files.length,readme_links:links,staged_bytes_checked:process.argv.includes('--staged'),generated_or_private_files:0},null,2));
