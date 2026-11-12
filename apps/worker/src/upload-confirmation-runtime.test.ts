import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {confirmationConfig} from './upload-confirmation-runtime.js';
import {acquireConfirmationSpool} from './upload-confirmation-spool.js';

const env={DATABASE_URL:'postgresql://synthetic@127.0.0.1/synthetic',AZURE_STORAGE_CONNECTION_STRING:'synthetic',BB_UPLOAD_CONFIRMATION_ENABLED:'1',BB_UPLOAD_SPOOL_DIR:'/synthetic/confirmation',BB_UPLOAD_SPOOL_MAX_BYTES:'134217728'};
test('confirmation entry is opt-in, bounded and rejects execution/model settings',()=>{
  assert.throws(()=>confirmationConfig({}));
  assert.equal(confirmationConfig(env).smallSlot,false);
  assert.equal(confirmationConfig({...env,BB_UPLOAD_CONFIRMATION_SMALL_SLOT:'1'}).smallSlot,true);
  assert.equal(confirmationConfig({...env,BB_LIBRARY_CONTAINER:'unrelated-library'}).container,'bondbuddy-private');
  assert.equal(confirmationConfig({...env,BB_UPLOAD_CONFIRMATION_CONTAINER:'synthetic-materials'}).container,'synthetic-materials');
  for(const change of [{BB_UPLOAD_CONFIRMATION_ENABLED:'0'},{DATABASE_URL:''},{AZURE_STORAGE_CONNECTION_STRING:''},{BB_UPLOAD_CONFIRMATION_SMALL_SLOT:'yes'},{BB_UPLOAD_SPOOL_MAX_BYTES:'1073741824'},{BB_UPLOAD_SPOOL_DIR:'relative'},{BB_UPLOAD_CONFIRMATION_POLL_MS:'0'},{BB_UPLOAD_CONFIRMATION_CONTAINER:'invalid--name'},{BB_WORKER_JOB_KINDS:'parse'},{BB_WORKER_RUN_KINDS:'update'},{BB_CODEX_BIN:'synthetic'},{OPENAI_API_KEY:'synthetic'},{COPILOT_TOKEN:'synthetic'}])
    assert.throws(()=>confirmationConfig({...env,...change}),JSON.stringify(Object.keys(change)));
});

test('dedicated spool locks exclude a second process and only clean managed private files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bb-confirmation-lock-'));
  let release:(()=>Promise<void>)|undefined;
  try{
    const stale=join(root,randomUUID()+'.blob');await writeFile(stale,'synthetic',{mode:0o600});
    release=await acquireConfirmationSpool(root,128*1024*1024);
    await assert.rejects(readFile(stale),{code:'ENOENT'});
    const active=join(root,randomUUID()+'.blob');await writeFile(active,'synthetic-active',{mode:0o600});
    await assert.rejects(acquireConfirmationSpool(root,128*1024*1024));
    assert.equal(await readFile(active,'utf8'),'synthetic-active');
    await release();release=undefined;
    const foreign=join(root,'parser-owned.data');await writeFile(foreign,'synthetic-foreign',{mode:0o600});
    await assert.rejects(acquireConfirmationSpool(root,128*1024*1024));
    assert.equal(await readFile(active,'utf8'),'synthetic-active','validate all files before any cleanup');
    assert.equal(await readFile(foreign,'utf8'),'synthetic-foreign');
  }finally{await release?.();await rm(root,{recursive:true,force:true});}
});
