import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,copyFileSync,writeFileSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';

const root=process.cwd(),local=resolve(root,'.local/supplement-input');
const target=resolve(root,'docs/acceptance/desktop-ux-coverage-20261026/supplement-input');
assert(existsSync(join(target,'README.md')),'Write the final acceptance boundaries before collecting');
assert(readdirSync(target).every(name=>name==='README.md'),'Never overwrite a prior evidence directory');
const copy=(source,destination)=>{mkdirSync(resolve(destination,'..'),{recursive:true});copyFileSync(source,destination);};
for(const name of readdirSync(local)){
 if(/\.(?:json|log)$/.test(name))copy(join(local,name),join(target,'records',name));
 if(/^(?:browser-real|browser-ui|inflight-test)-evidence(?:-\d+)?$/.test(name)){
  for(const file of readdirSync(join(local,name)))if(file.endsWith('.png')||file.endsWith('-assertions.json'))
   copy(join(local,name,file),join(target,'browser',name,file));
 }
}
copy(join(local,'verify.mjs'),join(target,'reproduce','verify.mjs'));
copy(join(local,'summarize.mjs'),join(target,'reproduce','summarize.mjs'));
copy(join(local,'collect-evidence.mjs'),join(target,'reproduce','collect-evidence.mjs'));
writeFileSync(join(target,'.gitattributes'),'# Preserve exact recorded bytes and their manifest hashes.\n* -text\nrecords/** -diff\n*.png binary\n');
const firstFailure=join(local,'browser-ui-results/run-supplement-draft-unacc-dda12-fter-receipt-says-not-found/error-context.md');
if(existsSync(firstFailure))copy(firstFailure,join(target,'records','first-ui-race-error-context.md'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),files=[];
const walk=directory=>{for(const item of readdirSync(directory,{withFileTypes:true})){const file=join(directory,item.name);if(item.isDirectory())walk(file);else if(item.isFile()){const bytes=readFileSync(file);files.push({path:relative(target,file).replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});}}};
walk(target);files.sort((a,b)=>a.path.localeCompare(b.path));
writeFileSync(join(target,'manifest.json'),JSON.stringify({synthetic:true,baseline_commit:'4386a62e',
 includes_private_byte_store:false,files},null,2)+'\n');
console.log(`Collected ${files.length} evidence files without private-byte stores or generated Word artifacts.`);
