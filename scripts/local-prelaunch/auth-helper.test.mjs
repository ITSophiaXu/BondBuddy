import assert from 'node:assert/strict';
import test from 'node:test';
import {chmodSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,rmdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateLocalAuthHelperBinds} from './runtime.mjs';

const service=(source,extra={})=>({environment:{BB_CODEX_AUTH_MODE:'copilot_enterprise'},
  volumes:[{type:'bind',source,target:'/usr/local/bin/bb-copilot-token',read_only:true,...extra}]});

test('Windows-style Git archives preserve the image auth helper shebang and tracked bytes',t=>{
  const temporaryRoot=realpathSync(tmpdir()),directory=mkdtempSync(join(temporaryRoot,'bb-auth-helper-archive-'));
  const relative='deploy/m1/scripts/copilot-token.mjs',helper=join(directory,relative);
  const git=(...args)=>{
    const result=spawnSync('git',args,{cwd:directory,windowsHide:true});
    assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr?.toString());
    return result.stdout;
  };
  try {
    git('init','--quiet');
    writeFileSync(join(directory,'.gitattributes'),readFileSync(new URL('../../.gitattributes',import.meta.url)));
    mkdirSync(dirname(helper),{recursive:true});
    writeFileSync(helper,readFileSync(new URL('../../'+relative,import.meta.url)));
    // This private fixture intentionally normalizes checkout bytes before testing archive conversion.
    git('-c','core.autocrlf=true','-c','core.safecrlf=false','add','--','.gitattributes',relative);
    const tree=git('write-tree').toString().trim(),tracked=git('show',`${tree}:${relative}`);
    const tar=git('-c','core.autocrlf=true','archive','--format=tar',tree,relative);
    let archived;
    for(let offset=0;offset+512<=tar.length;) {
      const header=tar.subarray(offset,offset+512),name=header.subarray(0,100).toString().replace(/\0.*$/s,'');
      const size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim()||'0',8);
      if(name===relative){archived=tar.subarray(offset+512,offset+512+size);break;}
      offset+=512+Math.ceil(size/512)*512;
    }
    assert.ok(archived,'exact helper member must exist in the Git archive');
    assert.deepEqual(archived,tracked,'autocrlf=true must not rewrite the tracked helper bytes');
    assert.equal(archived.includes(13),false,'the Linux helper must contain LF, including its shebang');
    const shebang=archived.subarray(0,archived.indexOf(10)+1).toString();
    assert.equal(shebang,'#!/usr/local/bin/node\n');
    t.diagnostic('archived helper SHA256 '+createHash('sha256').update(archived).digest('hex'));
    if(process.platform==='linux') {
      // Execute only a synthetic body, using the archived line ending and this host's Node path.
      const synthetic=join(directory,'synthetic-helper.mjs'),bad=join(directory,'synthetic-crlf-helper.mjs');
      const header=shebang.replace('/usr/local/bin/node',process.execPath),body="process.stdout.write('synthetic-helper-ok\\n');\n";
      writeFileSync(synthetic,header+body,{mode:0o700});
      writeFileSync(bad,header.replace('\n','\r\n')+body,{mode:0o700});
      const options={encoding:'utf8',env:{},timeout:5000};
      const success=spawnSync(synthetic,[],options),failure=spawnSync(bad,[],options);
      assert.equal(success.error,undefined);assert.equal(success.status,0,success.stderr);
      assert.equal(success.stdout,'synthetic-helper-ok\n');
      assert.equal(failure.error?.code,'ENOENT','CRLF makes the Linux interpreter path invalid');
      t.diagnostic('Linux synthetic helper executed; CRLF negative control returned ENOENT; no credential or network access');
    }
  }finally {
    // The fixture owns this new repository; verify its resolved parent before recursive cleanup.
    assert.equal(dirname(realpathSync(directory)),temporaryRoot);
    rmSync(directory,{recursive:true,force:true});
  }
});

test('helper checks do not reject image-provided helpers or unrelated mounts',()=>{
  assert.doesNotThrow(()=>validateLocalAuthHelperBinds({worker:{environment:{BB_CODEX_AUTH_MODE:'copilot_enterprise'}}}));
  assert.doesNotThrow(()=>validateLocalAuthHelperBinds({worker:{...service('/absent'),environment:{BB_CODEX_AUTH_MODE:'api_key'}}}));
  assert.doesNotThrow(()=>validateLocalAuthHelperBinds({worker:service('/absent',{target:'/run/credentials'})}));
  assert.doesNotThrow(()=>validateLocalAuthHelperBinds({worker:service('/absent',{type:'volume'})}));
});

test('a helper override must be a read-only bind before inspecting its source',()=>{
  for(const read_only of [false,undefined])assert.throws(
    ()=>validateLocalAuthHelperBinds({worker:service('/absent',{read_only})}),/worker must be read-only/);
});

test('Linux checks real R/X access without executing or changing the public helper',
  {skip:process.platform!=='linux'},()=>{
    const directory=mkdtempSync(join(tmpdir(),'bb-auth-helper-'));
    const helper=join(directory,'helper'),notFile=join(directory,'directory');
    // Root bypasses file read bits, so test actual access as an unprivileged user.
    const identity=process.getuid()===0?{uid:65534,gid:65534}:{};
    const invoke=source=>spawnSync(process.execPath,['--input-type=module','-e',`
      import {validateLocalAuthHelperBinds} from ${JSON.stringify(new URL('./runtime.mjs',import.meta.url).href)};
      try{validateLocalAuthHelperBinds(JSON.parse(process.argv[1]));process.stdout.write('accepted');}
      catch(error){process.stdout.write(error.message);process.exitCode=2;}
    `,JSON.stringify({worker:service(source)})],{encoding:'utf8',...identity});
    try {
      chmodSync(directory,0o755);mkdirSync(notFile);
      writeFileSync(helper,'#!/bin/sh\nexit 99\n');
      for(const mode of [0o644,0o444,0o111]) {
        chmodSync(helper,mode);
        const result=invoke(helper);
        assert.equal(result.error,undefined);
        assert.equal(result.status,2,`${mode.toString(8)}: ${result.stderr}`);
        assert.match(result.stdout,/worker must be an existing readable executable file/);
        assert.equal(result.stdout.includes(helper),false,'diagnostics do not disclose the source path');
      }
      chmodSync(helper,0o555);
      const accepted=invoke(helper);
      assert.equal(accepted.error,undefined);assert.equal(accepted.status,0,accepted.stderr);
      assert.equal(accepted.stdout,'accepted');
      for(const source of [join(directory,'missing'),notFile]) {
        const result=invoke(source);
        assert.equal(result.error,undefined);assert.equal(result.status,2,result.stderr);
        assert.match(result.stdout,/existing readable executable file/);
      }
    }finally {
      // Delete only the exact temporary fixture paths, without recursive cleanup.
      rmSync(helper,{force:true});rmdirSync(notFile);rmdirSync(directory);
    }
  });
