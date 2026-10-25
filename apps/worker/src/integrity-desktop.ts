import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes, randomInt} from 'node:crypto';
import type {Page} from 'playwright';

const exec = promisify(execFile);
const screen = {width:1440,height:1000};
export type IntegrityDesktop = {
 env:NodeJS.ProcessEnv;
 capture:(page:Page)=>Promise<Buffer>;
 close:()=>Promise<void>;
};

/** Each collection owns an authenticated X display. Never captures the user's desktop.
 * tint2 reads the operating-system clock live; the PNG is a root-window capture,
 * not a webpage with injected text or a timestamp composited onto evidence.
 */
export async function startIntegrityDesktop(directory:string, base:NodeJS.ProcessEnv):Promise<IntegrityDesktop>{
 if(process.platform!=='linux')throw Error('INTEGRITY_DESKTOP_REQUIRES_LINUX');
 const display=':'+randomInt(1000,60000), authority=join(directory,'Xauthority');
 const env={...base,HOME:directory,DISPLAY:display,XAUTHORITY:authority,TZ:'Asia/Shanghai'};
 const children:ChildProcess[]=[];
 const start=(file:string,args:string[])=>{const p=spawn(file,args,{env,stdio:'ignore'});p.on('error',()=>{});children.push(p);return p;};
 const close=async()=>{for(const p of children.reverse()){
  if(p.exitCode!==null||p.signalCode!==null)continue;
  await new Promise<void>(resolve=>{const timer=setTimeout(()=>{p.kill('SIGKILL');resolve();},2000);p.once('exit',()=>{clearTimeout(timer);resolve();});p.kill('SIGTERM');});
 }};
 try{
  await writeFile(authority,'',{mode:0o600});
  await exec('xauth',['-f',authority,'add',display,'MIT-MAGIC-COOKIE-1',randomBytes(16).toString('hex')],{env,timeout:5000});
  const server=start('Xvfb',[display,'-screen','0',`${screen.width}x${screen.height}x24`,'-nolisten','tcp','-auth',authority]);
  let ready=false;
  for(let i=0;i<30;i++){
   if(server.exitCode!==null)throw Error('INTEGRITY_DISPLAY_START_FAILED');
   try{await exec('xdpyinfo',[],{env,timeout:1000,maxBuffer:200000});ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}
  }
  if(!ready)throw Error('INTEGRITY_DISPLAY_UNAVAILABLE');
  const config=join(directory,'tint2rc');
  await writeFile(config,[
   'panel_items = TC','panel_size = 100% 56','panel_position = bottom center horizontal',
   'panel_layer = top','panel_margin = 0 0','panel_padding = 14 2 0','panel_background_id = 1',
   'rounded = 0','border_width = 0','background_color = #20252d 100',
   'time1_format = %H:%M:%S','time2_format = %Y/%m/%d','time1_timezone = Asia/Shanghai',
   'time2_timezone = Asia/Shanghai','time1_font = Sans 18','time2_font = Sans 14',
   'clock_font_color = #ffffff 100','clock_padding = 8 0','clock_background_id = 0',
   'autohide = 0','strut_policy = follow_size','disable_transparency = 1',
  ].join('\n'),{mode:0o600});
  start('openbox',['--sm-disable']);
  const panel=start('tint2',['-c',config]);
  await new Promise(r=>setTimeout(r,400));
  if(panel.exitCode!==null)throw Error('INTEGRITY_CLOCK_START_FAILED');
  let sequence=0;
  return {env,close,capture:async(page)=>{
   if(server.exitCode!==null||panel.exitCode!==null)throw Error('INTEGRITY_DESKTOP_LOST');
   await page.bringToFront();
   await exec('wmctrl',['-r',':ACTIVE:','-b','add,maximized_vert,maximized_horz'],{env,timeout:3000});
   // A mapped/maximized X window can still contain Chromium's blank startup frame.
   // Synchronize its compositor before capturing the native desktop; this buffer
   // is discarded, and the saved evidence remains the untouched scrot image.
   const deadline=Date.now()+10000;
   for(;;){
    try{await page.screenshot({timeout:Math.max(1,deadline-Date.now()),caret:'initial',animations:'allow'});break;}
    catch(error){
     if(!String(error).includes('Unable to capture screenshot')||Date.now()>=deadline)throw error;
     await page.waitForTimeout(100);
    }
   }
   // Allow the native window manager to apply its bounds without altering website content.
   await page.waitForTimeout(200);
   const path=join(directory,`screen-${++sequence}.png`);
   await exec('scrot',['--overwrite',path],{env,timeout:10000});
   return readFile(path);
  }};
 }catch(error){await close();throw error;}
}
