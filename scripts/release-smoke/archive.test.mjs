import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertArchiveSupport,extractArchive,gitArchive} from './archive.mjs';
import {hostEnvironment} from './platform.mjs';
import {sha256} from './support.mjs';

const windows={skip:process.platform!=='win32'};
const fixture=String.raw`
import io,json,sys,tarfile
with tarfile.open(sys.argv[1], "w", format=tarfile.PAX_FORMAT) as archive:
 for entry in json.loads(sys.argv[2]):
  item=tarfile.TarInfo(entry["name"])
  kind=entry.get("type", "file")
  if kind=="file":
   data=bytes.fromhex(entry.get("hex", "00ff0d0a"));item.size=len(data)
   archive.addfile(item, io.BytesIO(data))
  else:
   item.type={"symlink":tarfile.SYMTYPE,"hardlink":tarfile.LNKTYPE,"fifo":tarfile.FIFOTYPE}[kind]
   item.linkname=entry.get("target", "")
   archive.addfile(item)
`;
function makeFixture(t,entries){
 const prefix=join(tmpdir(),'bb-archive-'),root=mkdtempSync(prefix),archive=join(root,'input.tar'),destination=join(root,'output');
 t.after(()=>{assert.ok(root.startsWith(prefix)&&root.length>prefix.length);rmSync(root,{recursive:true,force:true});});mkdirSync(destination);
 const env=hostEnvironment();
 execFileSync(process.env.BB_RELEASE_TEST_PYTHON||'python',['-I','-c',fixture,archive,JSON.stringify(entries)],{env,stdio:'pipe',windowsHide:true});
 return {archive,destination,env};
}
test('Windows extracts Chinese, spaced and long Git paths without changing archive or file bytes',windows,t=>{
 const long='中文 带空格/'+('long directory name/'.repeat(15))+'样本.docx';
 const entries=[{name:'目录 空格/原稿.txt',hex:'e4b8ade696870d0a0a00ff'},{name:long,hex:'504b030400000d0a'}];
 const {archive,destination,env}=makeFixture(t,entries),hash=sha256(readFileSync(archive));
 assertArchiveSupport(env);extractArchive(archive,destination,env);
 for(const entry of entries)assert.deepEqual(readFileSync(join(destination,entry.name)),Buffer.from(entry.hex,'hex'));
 assert.equal(sha256(readFileSync(archive)),hash);
});
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
test('Windows refuses pre-existing destination junctions that point outside extraction root',windows,t=>{
 const {archive,destination,env}=makeFixture(t,[{name:'safe.txt'},{name:'linked/sentinel.txt'}]);
 const outside=join(destination,'..','outside');mkdirSync(outside);writeFileSync(join(outside,'sentinel.txt'),'original');
 symlinkSync(outside,join(destination,'linked'),'junction');
 assert.throws(()=>extractArchive(archive,destination,env));
 assert.equal(readFileSync(join(outside,'sentinel.txt'),'utf8'),'original');
 assert.deepEqual(readdirSync(destination),['linked']);
});
test('Windows rejects traversal, aliases, links and special files before writing any member',windows,t=>{
 const attacks=[
  {name:'../outside.txt'},{name:'/outside.txt'},{name:'C:/outside.txt'},{name:'C:outside.txt'},
  {name:'folder/../../outside.txt'},{name:'..\\outside.txt'},{name:'file.txt:secret'},
  {name:'CON'},{name:'folder./alias.txt'},{name:'folder /alias.txt'},
  {name:'link',type:'symlink',target:'../outside.txt'},{name:'link',type:'hardlink',target:'../outside.txt'},
  {name:'safe-link',type:'symlink',target:'safe.txt'},{name:'pipe',type:'fifo'},
 ];
 for(const entry of attacks){
  const {archive,destination,env}=makeFixture(t,[{name:'safe.txt'},entry]);
  assert.throws(()=>extractArchive(archive,destination,env),undefined,JSON.stringify(entry));
  assert.deepEqual(readdirSync(destination),[],JSON.stringify(entry));
 }
});
