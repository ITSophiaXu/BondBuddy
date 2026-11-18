import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from './support.mjs';
import {loadFixedFixtures,assertFixtureBindings} from './fixtures.mjs';
function fixture(){
 const samples=mkdtempSync(join(tmpdir(),'release-fixed-fixtures-')),git=new Map(),old='tests/samples/2026-09-25',recent='tests/samples/2026-11-05';
 const write=(path,bytes)=>{mkdirSync(dirname(join(samples,path)),{recursive:true});writeFileSync(join(samples,path),bytes);};
 const json=(path,body)=>{const bytes=Buffer.from(JSON.stringify(body));git.set(path,bytes);write(path,bytes);};
 const historical=Buffer.from('synthetic original');write(old+'/original.docx',historical);json(old+'/manifest.json',{cases:[{case_id:'rq-202509',files:[{path:'original.docx',upload_role:'historical',sha256:sha256(historical)}]}]});
 const assets=['009','012','013','014','015','016'].map(n=>{const path='originals/'+n+'.bin',bytes=Buffer.from('synthetic fixture '+n);write(recent+'/'+path,bytes);return {file_id:'nov05-f'+n,path,sha256:sha256(bytes)};});json(recent+'/manifest.json',{assets});
 for(const id of ['integrity-dongying','workpaper-dongying'])json(recent+'/cases/'+id+'/input.json',{case_id:id,requirements:'Synthetic fixed recipe'});
 return {samples,git,write,options:{samples,readGit:path=>git.get(path)},cleanup(){assert.ok(resolve(samples).startsWith(resolve(tmpdir())+sep));rmSync(samples,{recursive:true,force:true});}};
}
test('resume anchors file bytes and both recipes to fixed Git manifests',()=>{
 const f=fixture();try{const locked=loadFixedFixtures(f.options);assertFixtureBindings({fixtures:locked.fixtures},{fixtureHashes:locked.fixtureHashes},locked);
  f.write('tests/samples/2026-11-05/originals/012.bin',Buffer.from('changed original'));assert.throws(()=>loadFixedFixtures(f.options),/hash mismatch/);
 }finally{f.cleanup();}
});
test('edited local manifest or recipe cannot become a new expected hash',()=>{
 for(const relative of ['tests/samples/2026-11-05/manifest.json','tests/samples/2026-11-05/cases/integrity-dongying/input.json','tests/samples/2026-11-05/cases/workpaper-dongying/input.json']){
  const f=fixture();try{f.write(relative,Buffer.from('{}'));assert.throws(()=>loadFixedFixtures(f.options),/hash mismatch/);}finally{f.cleanup();}
 }
});
test('private runtime paths and recorded hashes cannot redirect resumed uploads',()=>{
 const f=fixture();try{const locked=loadFixedFixtures(f.options),data={fixtures:structuredClone(locked.fixtures)},report={fixtureHashes:locked.fixtureHashes};data.fixtures.dongying='different-authorized-file.docx';assert.throws(()=>assertFixtureBindings(data,report,locked),/resume refused/);assert.throws(()=>assertFixtureBindings({fixtures:locked.fixtures},{fixtureHashes:[]},locked),/resume refused/);}finally{f.cleanup();}
});
