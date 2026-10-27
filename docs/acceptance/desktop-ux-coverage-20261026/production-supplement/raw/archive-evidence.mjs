import {createHash} from 'node:crypto';
import {mkdir,readdir,readFile,stat,writeFile,copyFile} from 'node:fs/promises';
import {resolve,dirname,join,relative} from 'node:path';
const root=process.cwd(),source=resolve(root,'.local/production-supplement-20261027');
const target=resolve(root,'docs/acceptance/desktop-ux-coverage-20261026/production-supplement');
if(!target.startsWith(root+requireSeparator()))throw Error('Target outside workspace');
function requireSeparator(){return process.platform==='win32'?'\\':'/';}
const allowed=/\.(?:json|jsonl|log|txt|mjs|ps1|png|md)$/i;
const excluded=[],copied=[];
async function walk(dir,prefix=''){
 for(const ent of await readdir(dir,{withFileTypes:true})){
  const rel=prefix?prefix+'/'+ent.name:ent.name,full=join(dir,ent.name);
  if(ent.isDirectory()){
   if(/^(?:private-bytes-|worker-work-|__pycache__)/.test(ent.name)){excluded.push({path:rel,reason:'Private synthetic bytes / generated worker workspace remain local'});continue;}
   await walk(full,rel);
  } else if(ent.isFile()) {
   if(!allowed.test(ent.name)){excluded.push({path:rel,reason:'Generated Word, trace/binary, or unsupported runtime output remain local'});continue;}
   const dest=join(target,'raw',...rel.split('/'));await mkdir(dirname(dest),{recursive:true});await copyFile(full,dest);
   copied.push(rel);
  }
 }
}
await mkdir(target,{recursive:true});await walk(source);
await writeFile(join(target,'archive-selection.json'),JSON.stringify({source:'.local/production-supplement-20261027',mode:'Exact byte copies; no line ending normalization',copied,excluded},null,2));
console.log(JSON.stringify({target,copied:copied.length,excluded:excluded.length}));
