import assert from 'node:assert/strict';
import test from 'node:test';
import {chmodSync,mkdtempSync,mkdirSync,rmSync,rmdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateLocalAuthHelperBinds} from './runtime.mjs';

const service=(source,extra={})=>({environment:{BB_CODEX_AUTH_MODE:'copilot_enterprise'},
  volumes:[{type:'bind',source,target:'/usr/local/bin/bb-copilot-token',read_only:true,...extra}]});

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
