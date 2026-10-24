import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {startIntegrityDesktop} from './integrity-desktop.js';
import {integrityBrowserEnvironment} from './integrity-browser.js';
import {integrityWebsiteFixture} from './integrity-browser-fixture.js';

test('private native desktop captures browser and live Beijing clock, then closes its X socket',
 {skip:!process.env.BB_TEST_INTEGRITY_DESKTOP,timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bb-desktop-test-'));
 const desktop=await startIntegrityDesktop(dir,integrityBrowserEnvironment(dir));
 let browser;
 try{
  browser=await chromium.launch({headless:false,chromiumSandbox:true,env:desktop.env as Record<string,string>});
  const context=await browser.newContext({viewport:null});
  await integrityWebsiteFixture(context,'zero');
  const page=await context.newPage();await page.goto('https://www.chinatax.gov.cn/');
  const bytes=await desktop.capture(page),path=join(dir,'proof.png');
  assert.equal(bytes.readUInt32BE(16),1440);assert.equal(bytes.readUInt32BE(20),1000);
  await writeFile(path,bytes);
  const {stdout}=await promisify(execFile)('tesseract',[path,'stdout','-l','eng'],{timeout:15000});
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','/');
  assert.ok(stdout.includes(date),stdout);assert.match(stdout,/\d{2}:\d{2}:\d{2}/);
  await page.waitForTimeout(1200);assert.notDeepEqual(await desktop.capture(page),bytes);
  assert.equal(desktop.env.TZ,'Asia/Shanghai');
  assert.ok(!desktop.env.AZURE_STORAGE_CONNECTION_STRING&&!desktop.env.BB_COPILOT_OAUTH_FILE);
 }finally{
  await browser?.close();await desktop.close();
  await assert.rejects(access('/tmp/.X11-unix/X'+desktop.env.DISPLAY!.slice(1)));
  await rm(dir,{recursive:true,force:true});
 }
});
