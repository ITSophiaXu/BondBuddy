import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const base='docs/acceptance/desktop-ux-coverage-20261026/production-supplement';
const bytes=await readFile(base+'/manifest.json');const manifest=JSON.parse(bytes);const sha=b=>createHash('sha256').update(b).digest('hex');
const entries=[...manifest.entries,{path:'manifest.json',bytes:bytes.length,sha256:sha(bytes)}];
const child=spawn('git',['cat-file','--batch'],{windowsHide:true,stdio:['pipe','pipe','pipe']});const chunks=[],err=[];
child.stdout.on('data',d=>chunks.push(d));child.stderr.on('data',d=>err.push(d));
child.stdin.end(entries.map(e=>':'+base+'/'+e.path).join('\n')+'\n');
const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0,Buffer.concat(err).toString());
const all=Buffer.concat(chunks);let offset=0;const checked=[];
for(const entry of entries){const end=all.indexOf(10,offset);assert.ok(end>=offset,'Missing git blob header');const header=all.subarray(offset,end).toString('utf8');const match=header.match(/^([a-f0-9]{40,64}) blob (\d+)$/);assert.ok(match,header);
 const count=Number(match[2]);offset=end+1;const body=all.subarray(offset,offset+count);offset+=count;assert.equal(all[offset++],10);
 assert.equal(count,entry.bytes,entry.path);assert.equal(sha(body),entry.sha256,entry.path);checked.push({path:entry.path,blob:match[1],bytes:count,sha256:entry.sha256});}
assert.equal(offset,all.length,'Unexpected extra git blobs');const result={verifiedAt:new Date().toISOString(),stage:'index',files:checked.length,allBytesAndSha256Match:true,checked};
await writeFile('.local/production-supplement-20261027/staged-archive-verification.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({files:checked.length,allBytesAndSha256Match:true}));
