import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile, readFile, mkdir, copyFile} from 'node:fs/promises';
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

/** Each collection owns an authenticated local X display with Openbox and stock XFCE panels.
 * Use the distribution's unmodified panel/clock, not an application-designed clock bar.
 * scrot captures the root screen directly; no timestamp, frame or overlay is composited.
 * This is an isolated server desktop, not the user's existing interactive session.
 */
export async function startIntegrityDesktop(directory:string, base:NodeJS.ProcessEnv):Promise<IntegrityDesktop>{
 if(process.platform!=='linux')throw Error('INTEGRITY_DESKTOP_REQUIRES_LINUX');
 const display=':'+randomInt(1000,60000), authority=join(directory,'Xauthority');
 const env:NodeJS.ProcessEnv={...base,HOME:directory,DISPLAY:display,XAUTHORITY:authority,TZ:'Asia/Shanghai',XDG_CONFIG_HOME:join(directory,'.config'),XDG_RUNTIME_DIR:join(directory,'runtime')};
 const children:ChildProcess[]=[];
 const start=(file:string,args:string[],output=false)=>{const p=spawn(file,args,{env,detached:true,stdio:output?['ignore','pipe','ignore']:'ignore'});p.on('error',()=>{});children.push(p);return p;};
 const kill=(p:ChildProcess,signal:NodeJS.Signals)=>{try{if(p.pid)process.kill(-p.pid,signal);}catch{/* Already closed. */}};
 const close=async()=>{for(const p of children.reverse()){
  if(p.exitCode!==null||p.signalCode!==null){kill(p,'SIGTERM');continue;}
  await new Promise<void>(resolve=>{const timer=setTimeout(()=>{kill(p,'SIGKILL');resolve();},2000);p.once('exit',()=>{clearTimeout(timer);resolve();});kill(p,'SIGTERM');});
 }};
 try{
  await writeFile(authority,'',{mode:0o600});
  await mkdir(env.XDG_RUNTIME_DIR!,{mode:0o700});
  const config=join(env.XDG_CONFIG_HOME!,'xfce4','xfconf','xfce-perchannel-xml');
  await mkdir(config,{recursive:true,mode:0o700});
  // Seed the distro's stock first-run layout verbatim. Never set clock formats/fonts.
  await copyFile('/etc/xdg/xfce4/panel/default.xml',join(config,'xfce4-panel.xml'));
  await exec('xauth',['-f',authority,'add',display,'MIT-MAGIC-COOKIE-1',randomBytes(16).toString('hex')],{env,timeout:5000});
  const server=start('Xvfb',[display,'-screen','0',`${screen.width}x${screen.height}x24`,'-nolisten','tcp','-auth',authority]);
  let ready=false;
  for(let i=0;i<30;i++){
   if(server.exitCode!==null)throw Error('INTEGRITY_DISPLAY_START_FAILED');
   try{await exec('xdpyinfo',[],{env,timeout:1000,maxBuffer:200000});ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}
  }
  if(!ready)throw Error('INTEGRITY_DISPLAY_UNAVAILABLE');
  const bus=start('dbus-daemon',['--session','--nofork','--print-address=1'],true);
  env.DBUS_SESSION_BUS_ADDRESS=await new Promise<string>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('INTEGRITY_DESKTOP_BUS_UNAVAILABLE')),5000);
   bus.stdout!.once('data',data=>{clearTimeout(timer);resolve(data.toString().trim());});
   bus.once('error',error=>{clearTimeout(timer);reject(error);});
   bus.once('exit',()=>{clearTimeout(timer);reject(Error('INTEGRITY_DESKTOP_BUS_EXITED'));});
  });
  start('openbox',['--sm-disable']);
  start('xfdesktop',['--disable-wm-check']);
  const panel=start('xfce4-panel',['--disable-wm-check']);
  let panelReady=false;
  for(let i=0;i<30;i++){
   if(panel.exitCode!==null)break;
   const {stdout}=await exec('wmctrl',['-l','-x'],{env,timeout:2000}).catch(()=>({stdout:''}));
   if(/xfce4-panel/i.test(stdout)){panelReady=true;break;}
   await new Promise(r=>setTimeout(r,100));
  }
  if(!panelReady)throw Error('INTEGRITY_NATIVE_PANEL_UNAVAILABLE');
  if(panel.exitCode!==null)throw Error('INTEGRITY_CLOCK_START_FAILED');
  let sequence=0;
  return {env,close,capture:async(page)=>{
   if(server.exitCode!==null||panel.exitCode!==null||bus.exitCode!==null)throw Error('INTEGRITY_DESKTOP_LOST');
   await page.bringToFront();
   await exec('wmctrl',['-r',':ACTIVE:','-b','add,maximized_vert,maximized_horz'],{env,timeout:3000});
   // Allow the native window manager to apply its bounds without altering website content.
   await page.waitForTimeout(200);
   const path=join(directory,`screen-${++sequence}.png`);
   await exec('scrot',['--overwrite',path],{env,timeout:10000});
   return readFile(path);
  }};
 }catch(error){await close();throw error;}
}
