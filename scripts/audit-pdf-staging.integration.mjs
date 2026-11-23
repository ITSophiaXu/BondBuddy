
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,chmod,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
const moduleUrl=process.env.BB_AUDIT_TEST_MODULE??new URL('../apps/worker/dist/material-parser.js',import.meta.url).href;
const {inspectAuthorizedPdf}=await import(moduleUrl);
const {inspectPdfQuality}=await import(new URL('./pdf-quality.js',moduleUrl).href);
function raster(dpi){
 const width=1200,height=1600,w=width*72/dpi,h=height*72/dpi,image=deflateSync(Buffer.alloc(width*height,255)),content=Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
 const stream=(d,b)=>Buffer.concat([Buffer.from(`<< ${d} /Length ${b.length} >>\nstream\n`),b,Buffer.from('\nendstream')]);
 const objs=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,image),stream('',content)];
 let b=Buffer.from('%PDF-1.4\n% synthetic staged quality test\n');const offsets=[];for(const [i,o]of objs.entries()){offsets.push(b.length);b=Buffer.concat([b,Buffer.from(`${i+1} 0 obj\n`),o,Buffer.from('\nendobj\n')]);}const start=b.length;return Buffer.concat([b,Buffer.from('xref\n0 6\n0000000000 65535 f \n'+offsets.map(v=>String(v).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`)]);
}
test('audit quality works repeatedly with real Linux managed staging and releases failed inspections',{skip:process.platform!=='linux'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'bb-audit-staging-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
 const input={ownerUserId:'synthetic-owner',projectId:'synthetic-project',materialId:'synthetic-audit',version:1,requestId:'synthetic-probe',requiredRole:'audit'};
 const probe=async(dpi,inspector=path=>inspectPdfQuality(path,{repoRoot:fileURLToPath(new URL('../../../',moduleUrl))}))=>{const bytes=raster(dpi);const row={id:input.materialId,owner_user_id:input.ownerUserId,project_id:input.projectId,version:1,byte_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'application/pdf',object_key:'synthetic/private/pdf',role:'audit'};
 return inspectAuthorizedPdf({tempRoot:root,pool:{query:async()=>({rows:[row]})},blobs:{getPrivate:async()=>bytes}},input,inspector);};
 const clean=async()=>{assert.equal((await readdir(root)).filter(n=>n.startsWith('bb-material-')).length,0);assert.deepEqual(JSON.parse(await readFile(join(root,'.bb-parse-registry.json'),'utf8')).entries,{});};
 const restartSweep=()=>{const child=spawnSync(process.execPath,['--input-type=module','-e',`import {sweepParseStaging} from ${JSON.stringify(new URL('./parse-staging.js',moduleUrl).href)}; await sweepParseStaging(process.argv[1]);`,root],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);};
 await t.test('clear PDF preserves complete measurement and releases staging',async()=>{const q=await probe(200);assert.equal(q.status,'complete');assert.equal(q.checked_pages,1);assert.deepEqual(q.low_resolution_pages,[]);await clean();});
 await t.test('restart sweep accepts the clean staging volume before the next PDF',async()=>{restartSweep();const q=await probe(144);assert.equal(q.status,'complete');assert.deepEqual(q.low_resolution_pages,[{page:1,dpi:144}]);await clean();});
 await t.test('inspection exception releases staging and allows another inspection',async()=>{await assert.rejects(probe(200,async()=>{throw Error('SYNTHETIC_INSPECT_FAILURE');}),/SYNTHETIC_INSPECT_FAILURE/);await clean();assert.equal((await probe(200)).status,'complete');await clean();});
 await t.test('restart sweep accepts the volume after a failed inspection',async()=>{restartSweep();await clean();});
});
