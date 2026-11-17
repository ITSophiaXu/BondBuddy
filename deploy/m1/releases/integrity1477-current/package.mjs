import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {brotliDecompressSync,gzipSync} from 'node:zlib';
import {bootstrapUserData} from '../../../tencent-elasticity/bootstrap.mjs';
const root=new URL('../../../../',import.meta.url),dir=new URL('./',import.meta.url);
const read=p=>readFileSync(new URL(p,root));
const out=process.argv[2];if(!out?.startsWith('/data/workspaces/'))throw Error('output directory');mkdirSync(out,{recursive:true,mode:0o700});
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(readFileSync(new URL('files.json',dir)));
const files=Object.fromEntries(Object.entries(manifest).map(([p,m])=>{const b=read(p);if(b.length!==m.bytes||sha(b)!==m.sha256)throw Error('artifact drift '+p);return[p,b.toString('base64')]}));
const write=(name,v)=>writeFileSync(out+'/'+name,JSON.stringify(v,null,2)+'\n',{mode:0o600});
const source=process.argv[3] || execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();if(!/^[a-f0-9]{40}$/.test(source))throw Error('source commit');
const renderer=read('deploy/m1/releases/managed-db1484/main-cutover-adapter.py');
if(sha(renderer)!=='59818258171123633d3c4d5a7cc8037e4ec2082a997bf18e7bfefd7a54849a4c')throw Error('renderer drift');
write('stage-input.json',{source_commit:source,manifest,files,renderer:renderer.toString('base64')});
const config=JSON.parse(read('deploy/m1/releases/fine-step1420/managed-node-eight/boot-public-config.json'));config.business_overlay_sha256='c9449fc3294e0a1590ddc5081d99cb9387ea439acf4d096db4ea41e790391770';
const script=bootstrapUserData(config,{account_id:config.account_id,region:config.region,source_sha256:'1'.repeat(64),image_sha256:config.image_sha256,services:config.services},0),encoded=script.match(/base64\.b85decode\('([^']+)'\)/)[1];
const packed=execFileSync('python3',['-c','import base64,sys;sys.stdout.buffer.write(base64.b85decode(sys.stdin.read()))'],{input:encoded});const program=brotliDecompressSync(packed);writeFileSync(out+'/public-installer.py',program,{mode:0o600});
const expected=readFileSync(new URL('install-node.py',dir),'utf8').match(/^PROGRAM_SHA='([a-f0-9]{64})'$/m)?.[1];if(sha(program)!==expected)throw Error('installer program drift '+sha(program));
const payload={program_gzip_base64:gzipSync(program,{mtime:0}).toString('base64')};write('install-input.json',payload);
for(const name of ['arm-next-boot','install-node']){
 const code=readFileSync(new URL(name+'.py',dir),'utf8');const content='#!/bin/sh\nset -eu\npython3 - <<\'BB_INTEGRITY_SCRIPT\'\n'+(name==='install-node'?'import io,sys\nsys.stdin=io.StringIO('+JSON.stringify(JSON.stringify(payload))+')\n':'')+code+'\nBB_INTEGRITY_SCRIPT\n';
 write(name+'-request.json',{CommandName:'bb-integrity1477-'+name,CommandType:'SHELL',Content:Buffer.from(content).toString('base64'),Timeout:120,InstanceIds:['ins-p4i0pcub'],SaveCommand:false});
}
write('artifacts.json',Object.fromEntries(['stage-input.json','public-installer.py','install-input.json','arm-next-boot-request.json','install-node-request.json'].map(n=>{const b=readFileSync(out+'/'+n);return[n,{bytes:b.length,sha256:sha(b)}]})));
