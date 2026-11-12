import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {assertControllerCandidate} from './controller.mjs';
test('controller uses committed bytes, accepts checkout EOL only, and rejects hidden extra modules',()=>{
 const repo=mkdtempSync(join(tmpdir(),'release-controller-')),directory=join(repo,'scripts/release-smoke');
 const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
 try{
  mkdirSync(directory,{recursive:true});git(['init','-q']);git(['config','core.autocrlf','false']);writeFileSync(join(directory,'run.mjs'),'export const example=1;\n');git(['add','scripts']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','synthetic']);const sha=git(['rev-parse','HEAD']);
  writeFileSync(join(directory,'run.mjs'),'export const example=1;\r\n');const result=assertControllerCandidate({repo,directory,sha});assert.equal(result[0].checkoutEolNormalized,true);
  writeFileSync(join(directory,'run.mjs'),'export const example=2;\n');assert.throws(()=>assertControllerCandidate({repo,directory,sha}),/differs/);
  writeFileSync(join(directory,'run.mjs'),'export const example=1;\n');writeFileSync(join(directory,'shadow.mjs'),'export {};');assert.throws(()=>assertControllerCandidate({repo,directory,sha}),/files differ/);
 }finally{rmSync(repo,{recursive:true,force:true});}
});
