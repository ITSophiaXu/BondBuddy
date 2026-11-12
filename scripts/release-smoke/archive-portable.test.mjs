import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractArchive,gitArchive} from './archive.mjs';
import {hostEnvironment} from './platform.mjs';

// Keep the original common case in the Linux core as well as in the complete Windows host file.
// extractArchive therefore still exercises real tar on Linux; the Windows file remains byte-identical.
test('Git archives ignore host autocrlf and preserve committed text/binary blobs for source and sample paths',t=>{
 const prefix=join(tmpdir(),'bb-archive-git-'),root=mkdtempSync(prefix),env=hostEnvironment();
 t.after(()=>{assert.ok(root.startsWith(prefix)&&root.length>prefix.length);rmSync(root,{recursive:true,force:true});});
 const git=args=>execFileSync('git',args,{cwd:root,env,stdio:'pipe',windowsHide:true});
 git(['init','--initial-branch=main']);git(['config','core.autocrlf','true']);git(['config','core.eol','crlf']);
 git(['config','user.name','Synthetic Archive Test']);git(['config','user.email','archive-test@example.invalid']);
 mkdirSync(join(root,'tests','samples'),{recursive:true});
 writeFileSync(join(root,'helper.mjs'),'#!/usr/bin/env node\nconsole.log("original");\n');
 writeFileSync(join(root,'tests','samples','manifest.json'),'{}\n');
 writeFileSync(join(root,'tests','samples','sample.bin'),Buffer.from('00ff0d0a','hex'));
 git(['add','.']);git(['-c','commit.gpgsign=false','commit','-m','synthetic archive fixture']);
 for(const paths of [[],['tests/samples']]){
  const out=join(root,paths.length?'samples-out':'source-out');mkdirSync(out);
  const archive=join(root,paths.length?'samples.tar':'source.tar');writeFileSync(archive,gitArchive(root,'HEAD',env,paths));
  extractArchive(archive,out,env);
  for(const file of paths.length?['tests/samples/manifest.json','tests/samples/sample.bin']:['helper.mjs','tests/samples/manifest.json','tests/samples/sample.bin']){
   assert.deepEqual(readFileSync(join(out,file)),git(['cat-file','blob','HEAD:'+file]),file);
  }
 }
 assert.equal(git(['config','--local','core.autocrlf']).toString().trim(),'true');
 assert.equal(git(['config','--local','core.eol']).toString().trim(),'crlf');
});
