import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync,readFileSync,writeFileSync,mkdirSync,copyFileSync } from 'node:fs';
import { join,resolve,relative } from 'node:path';
const source=resolve('.local/supplement-b1-20261027');
const dest=resolve('docs/acceptance/desktop-ux-coverage-20261026/supplement-b1-quotes');
const json=path=>JSON.parse(readFileSync(join(source,path),'utf8').replace(/^\uFEFF/,''));
assert.equal(json('final-evidence.json').success,true);assert.equal(json('pg-stop.json').success,true);
writeFileSync(join(source,'pg-start-terminal.json'),JSON.stringify({sessionId:7603,exitCode:1,
  error:'Start identity verification failed; see saved record',
  interpretation:'Startup output pipe returned only after verified graceful stop. Authoritative running identity is pg-start-observed.json. Startup pg_ctl exit was 0; final late identity check saw no process after shutdown.'},null,2));
const records=join(dest,'records');mkdirSync(records,{recursive:false});
const files=[];
function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())walk(path);else if(item.isFile())files.push(path);}}
walk(source);
const manifest=[];
for(const path of files.sort()){
  const name=relative(source,path),target=join(records,name);mkdirSync(join(target,'..'),{recursive:true});copyFileSync(path,target);
  const bytes=readFileSync(target);manifest.push({path:`records/${name.replaceAll('\\','/')}`,bytes:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex')});
}
writeFileSync(join(dest,'manifest.json'),JSON.stringify({sealedAt:new Date().toISOString(),files:manifest},null,2));
process.stdout.write(JSON.stringify({files:manifest.length,bytes:manifest.reduce((sum,file)=>sum+file.bytes,0),dest})+'\n');
