import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// A real unhandled rejection is necessary: rejecting the collection promise alone
// does not exercise Playwright's fire-and-forget transport callback.
test('CDP transport rejection fails concurrent collections, cleans up and preserves unrelated fail-fast', () => {
  const url = new URL('./integrity-browser-boundary.js', import.meta.url).href;
  const source = `
 import assert from 'node:assert/strict';
 import {integrityBrowserBoundary} from ${JSON.stringify(url)};
 const before=process.listenerCount('unhandledRejection');let cleaned=0;
 const jobs=Array.from({length:2},()=>integrityBrowserBoundary(new AbortController().signal,async signal=>{
   try{await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
   finally{cleaned++;}
 }));
 const error=new Error('synthetic protocol assertion');
 error.stack='Error: synthetic\\n    at assert (/app/node_modules/playwright-core/lib/coreBundle.js:838:11)\\n    at _CRSession._onMessage (/app/node_modules/playwright-core/lib/coreBundle.js:35014:11)\\n    at CRConnection._onMessage (/app/node_modules/playwright-core/lib/coreBundle.js:34951:20)';
 setImmediate(()=>{void Promise.reject(error);});
 const result=await Promise.allSettled(jobs);
 assert.equal(cleaned,2);assert.ok(result.every(r=>r.status==='rejected'&&r.reason.message==='INTEGRITY_BROWSER_RUNTIME_FAILED'));
 assert.equal(process.listenerCount('unhandledRejection'),before);
 process.stdout.write('collections_failed=2 cleanup=2 listeners_restored=true\\n');
 `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cleanup=2/);
  const unrelated = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
 import {integrityBrowserBoundary} from ${JSON.stringify(url)};
 void integrityBrowserBoundary(new AbortController().signal,async()=>{
  setImmediate(()=>{void Promise.reject(Error('synthetic unrelated rejection'));});
  await new Promise(resolve=>setTimeout(resolve,2000));
 });`,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(unrelated.status, 1, unrelated.stderr);
  assert.match(unrelated.stderr, /synthetic unrelated rejection/);
});
