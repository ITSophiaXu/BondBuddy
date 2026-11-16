import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {bootstrapUserData} from './boot-bound/bootstrap.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
const base=JSON.parse(read('./boot-public-config.json'));
const summary=JSON.parse(read('./package-summary.json')),config={...base,business_overlay_sha256:summary.archive_sha256};
const request={account_id:config.account_id,region:config.region,source_sha256:summary.source_sha256,image_sha256:config.image_sha256,services:config.services};
const slots=[0,1].map(slot=>{const data=bootstrapUserData(config,request,slot),size=Buffer.byteLength(data);return {slot,bytes:size,limit:16384,within_bound:size<=16384,sha256:hash(data),public_only:true};});
const proof={version:'managed-performance-bootstrap-user-data-bound-v1',host_files:Object.fromEntries(['bootstrap.mjs','node-adapter.mjs','compose.yaml','policy.mjs','business-overlay.mjs'].map(n=>[n,hash(read('./boot-bound/'+n))])),source_sha256:summary.source_sha256,business_overlay_sha256:summary.archive_sha256,image_sha256:config.image_sha256,slots,production_called:false,secrets_read_or_written:false};
writeFileSync(new URL('./bootstrap-user-data-bound.json',import.meta.url),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));if(slots.some(s=>!s.within_bound))process.exitCode=1;
