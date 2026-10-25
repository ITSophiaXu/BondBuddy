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
  const clockPath=join(dir,'clock-check.png');
  // OCR the clock separately so page layout does not affect its segmentation.
  // This derivative is test-only; the collector's full-screen bytes stay intact.
  await promisify(execFile)(process.env.BONDBUDDY_TEST_PYTHON??'python3',['-c',
   'from PIL import Image,ImageOps; import sys; im=Image.open(sys.argv[1]); ImageOps.expand(im.crop((1200,944,1440,1000)),border=20,fill="black").resize((1120,384)).save(sys.argv[2])',path,clockPath],{timeout:15000});
  const {stdout:clockText}=await promisify(execFile)('tesseract',[clockPath,'stdout','-l','eng','--psm','6'],{timeout:15000});
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','/');
  assert.ok(clockText.includes(date),clockText);assert.match(clockText,/\d{2}:\d{2}:\d{2}/);
  assert.match(stdout,/chinatax\.gov\.cn/,'first native capture includes the rendered browser, not its blank startup window');
  await page.waitForTimeout(1200);assert.notDeepEqual(await desktop.capture(page),bytes);
  assert.equal(desktop.env.TZ,'Asia/Shanghai');
  assert.ok(!desktop.env.AZURE_STORAGE_CONNECTION_STRING&&!desktop.env.BB_COPILOT_OAUTH_FILE);
 }finally{
  await browser?.close();await desktop.close();
  await assert.rejects(access('/tmp/.X11-unix/X'+desktop.env.DISPLAY!.slice(1)));
  await rm(dir,{recursive:true,force:true});
 }
});
