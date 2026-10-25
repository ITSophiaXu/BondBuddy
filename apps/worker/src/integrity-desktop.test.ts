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

test('stock XFCE screen includes the browser and operating-system clock and closes its private X socket',
 {skip:!process.env.BB_TEST_INTEGRITY_DESKTOP,timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bb-desktop-test-'));
 const desktop=await startIntegrityDesktop(dir,integrityBrowserEnvironment(dir));
 let browser;
 try{
  browser=await chromium.launch({headless:false,chromiumSandbox:true,env:desktop.env as Record<string,string>});
  const context=await browser.newContext({viewport:null});
  await integrityWebsiteFixture(context,'zero');
  const page=await context.newPage();await page.goto('https://www.chinatax.gov.cn/');
  const clockTime=()=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'}).format(new Date());
  const before=clockTime();
  const bytes=await desktop.capture(page),path=join(dir,'proof.png');
  const after=clockTime();
  assert.equal(bytes.readUInt32BE(16),1440);assert.equal(bytes.readUInt32BE(20),1000);
  await writeFile(path,bytes);
  // Read the stock two-line clock as one block. Sparse full-panel OCR misses its second line.
  // Crop/enlarge only a QA copy; the captured evidence remains unchanged.
  const ocrPath=join(dir,'ocr-only.png');
  await promisify(execFile)(process.env.BONDBUDDY_TEST_PYTHON??'python3',['-c','from PIL import Image; import sys; im=Image.open(sys.argv[1]); im.crop((im.width-140,0,im.width-35,27)).resize((420,108)).save(sys.argv[2])',path,ocrPath],{timeout:5000});
  const {stdout}=await promisify(execFile)('tesseract',[ocrPath,'stdout','-l','eng','--psm','6'],{timeout:15000});
  assert.ok([before,after].some(time=>stdout.includes(time)),stdout);
  const windows=await promisify(execFile)('wmctrl',['-l','-x'],{env:desktop.env,timeout:5000});
  assert.match(windows.stdout,/xfce4-panel/i);assert.match(windows.stdout,/chromium/i);
  const {stdout:pageText}=await promisify(execFile)('tesseract',[path,'stdout','-l','eng'],{timeout:15000});
  assert.match(pageText,/chinatax\.gov\.cn/,'first native capture includes the rendered browser, not its blank startup window');
  assert.equal(desktop.env.TZ,'Asia/Shanghai');
  assert.ok(!desktop.env.AZURE_STORAGE_CONNECTION_STRING&&!desktop.env.BB_COPILOT_OAUTH_FILE);
 }finally{
  await browser?.close();await desktop.close();
  await assert.rejects(access('/tmp/.X11-unix/X'+desktop.env.DISPLAY!.slice(1)));
  await rm(dir,{recursive:true,force:true});
 }
});
