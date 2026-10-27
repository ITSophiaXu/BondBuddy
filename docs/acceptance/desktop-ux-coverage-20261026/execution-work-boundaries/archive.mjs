import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';

const local=dirname(fileURLToPath(import.meta.url)),root=resolve(local,'../..');
const output=join(root,'docs/acceptance/desktop-ux-coverage-20261026/execution-work-boundaries');
assert(!existsSync(output),'Never overwrite an existing evidence archive');
mkdirSync(output,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=[],raw=[],runs=[];
const save=(name,bytes,source)=>{
  const path=join(output,name);mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,bytes,{flag:'wx'});manifest.push({path:name,bytes:bytes.length,sha256:hash(bytes),...(source?{source}: {})});
};
function archive(directory){
  for(const item of readdirSync(directory,{withFileTypes:true})){
    const path=join(directory,item.name);
    assert(!item.isSymbolicLink(),'Evidence cannot skip symlinks');
    if(item.isDirectory()){archive(path);continue;}
    assert(item.isFile());
    const bytes=readFileSync(path),name=relative(local,path).replaceAll('\\','/');
    const compressed=gzipSync(bytes,{level:9});assert(gunzipSync(compressed).equals(bytes));
    save(`${name}.gz`,compressed,{path:relative(root,path).replaceAll('\\','/'),bytes:bytes.length,sha256:hash(bytes)});
    raw.push({path:name,bytes:bytes.length,sha256:hash(bytes),archive:`${name}.gz`});
  }
}
for(const name of readdirSync(join(local,'runs')).sort()){
  const directory=join(local,'runs',name),result=JSON.parse(readFileSync(join(directory,'result.json'),'utf8'));
  assert(result.finished,'Only completed invocations can be archived');
  const log=readFileSync(join(directory,'run.log'),'utf8');
  const count=key=>{const matches=[...log.matchAll(new RegExp(`^(?:# |ℹ )${key} (\\d+)$`,'gm'))];return matches.length?Number(matches.at(-1)[1]):null;};
  runs.push({id:name,mode:result.mode,status:result.status,finished:result.finished,
    ...(count('tests')!==null?{tests:count('tests'),pass:count('pass'),fail:count('fail'),skipped:count('skipped')}: {})});
}
archive(join(local,'runs'));
for(const name of ['verify.mjs','archive.mjs'])save(name,readFileSync(join(local,name)),relative(root,join(local,name)).replaceAll('\\','/'));
save('raw-files.json',Buffer.from(JSON.stringify(raw,null,2)+'\n'));
save('summary.json',Buffer.from(JSON.stringify({scope:'Execution stage and provider-call recovery boundaries. V1 only; no adoption, quote, charge or final supplemental Word journey.',runs},null,2)+'\n'));
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({output,files:manifest.length+1,runs:runs.length,failed:runs.filter(r=>r.status!==0).map(r=>r.id)})+'\n');
