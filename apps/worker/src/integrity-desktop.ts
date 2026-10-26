import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile, readFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes, randomInt} from 'node:crypto';
import type {Page} from 'playwright';

const exec = promisify(execFile);
const screen = {width:1440,height:1000};
// Configure native XFCE plugins, rather than painting a toolbar into the evidence.
// A single, always-visible light taskbar reserves the bottom 48 pixels for itself.
const panelConfiguration = `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
 <property name="configver" type="int" value="2"/>
 <property name="panels" type="array">
  <value type="int" value="1"/>
  <property name="dark-mode" type="bool" value="false"/>
  <property name="panel-1" type="empty">
   <property name="position" type="string" value="p=10;x=720;y=1000"/>
   <property name="position-locked" type="bool" value="true"/>
   <property name="length" type="uint" value="100"/>
   <property name="length-adjust" type="bool" value="false"/>
   <property name="size" type="uint" value="48"/>
   <property name="icon-size" type="uint" value="24"/>
   <property name="autohide-behavior" type="uint" value="0"/>
   <property name="enable-struts" type="bool" value="true"/>
   <property name="plugin-ids" type="array">
    <value type="int" value="1"/><value type="int" value="2"/>
    <value type="int" value="3"/><value type="int" value="4"/>
    <value type="int" value="5"/><value type="int" value="6"/>
   </property>
  </property>
 </property>
 <property name="plugins" type="empty">
  <property name="plugin-1" type="string" value="applicationsmenu"/>
  <property name="plugin-2" type="string" value="showdesktop"/>
  <property name="plugin-3" type="string" value="tasklist">
   <property name="grouping" type="uint" value="1"/>
  </property>
  <property name="plugin-4" type="string" value="separator">
   <property name="expand" type="bool" value="true"/>
   <property name="style" type="uint" value="0"/>
  </property>
  <property name="plugin-5" type="string" value="systray"/>
  <property name="plugin-6" type="string" value="clock">
   <property name="mode" type="uint" value="2"/>
   <property name="timezone" type="string" value="Asia/Shanghai"/>
   <property name="digital-layout" type="uint" value="0"/>
   <property name="digital-date-font" type="string" value="Sans 10"/>
   <property name="digital-time-font" type="string" value="Sans 12"/>
   <property name="digital-date-format" type="string" value="%Y-%m-%d"/>
   <property name="digital-time-format" type="string" value="%H:%M:%S"/>
  </property>
 </property>
</channel>`;
export type IntegrityDesktop = {
 env:NodeJS.ProcessEnv;
 capture:(page:Page)=>Promise<Buffer>;
 close:()=>Promise<void>;
};

/** Flush Chromium's actual compositor without waiting for remote web fonts.
 * Official pages can keep document.fonts.ready pending after results are visible.
 * This buffer is discarded; the evidence is still the untouched native scrot image.
 */
export async function syncIntegrityCompositor(page:Page){
 // Allow Chromium's font fallback period to finish, but never await a stalled font forever.
 await page.evaluate(()=>Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,3500))]));
 const session=await page.context().newCDPSession(page);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([
  (async()=>{for(let attempt=0;;attempt++)try{
   return await session.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
  }catch(error){
   // A newly mapped/maximized native window can briefly have no capture surface.
   if(attempt>=2||!(error instanceof Error)||!error.message.includes('Unable to capture screenshot'))throw error;
   await page.waitForTimeout(250);
  }})(),
  new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('INTEGRITY_COMPOSITOR_TIMEOUT')),10000);}),
 ]);}finally{clearTimeout(timer);await session.detach().catch(()=>{});}
}

/** Each collection owns an authenticated local X display with Openbox and a native XFCE taskbar.
 * The light taskbar stays at the bottom; its clock reads the live system time in Asia/Shanghai.
 * scrot captures the root screen directly; no timestamp, frame or overlay is composited.
 * This is an isolated server desktop, not the user's existing interactive session.
 */
export async function startIntegrityDesktop(directory:string,base:NodeJS.ProcessEnv):Promise<IntegrityDesktop>{
 for(let attempt=0;;attempt++){
  const owned=await mkdtemp(join(directory,'desktop-'));
  try{return await startDesktopAttempt(owned,base);}catch(error){
   await rm(owned,{recursive:true,force:true});
   // Only retry startup failures, before a browser or any official query exists.
   if(attempt||!(error instanceof Error)||!['INTEGRITY_DISPLAY_START_FAILED','INTEGRITY_DISPLAY_UNAVAILABLE','INTEGRITY_WINDOW_MANAGER_UNAVAILABLE','INTEGRITY_NATIVE_PANEL_UNAVAILABLE'].includes(error.message))throw error;
  }
 }
}
async function startDesktopAttempt(directory:string, base:NodeJS.ProcessEnv):Promise<IntegrityDesktop>{
 if(process.platform!=='linux')throw Error('INTEGRITY_DESKTOP_REQUIRES_LINUX');
 const display=':'+randomInt(1000,60000), authority=join(directory,'Xauthority');
 const env:NodeJS.ProcessEnv={...base,HOME:directory,DISPLAY:display,XAUTHORITY:authority,TZ:'Asia/Shanghai',GTK_THEME:'Adwaita',XDG_CONFIG_HOME:join(directory,'.config'),XDG_RUNTIME_DIR:join(directory,'runtime')};
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
  await writeFile(join(config,'xfce4-panel.xml'),panelConfiguration,{mode:0o600});
  const gtkConfig=join(env.XDG_CONFIG_HOME!,'gtk-3.0');
  await mkdir(gtkConfig,{recursive:true,mode:0o700});
  // XFCE 4.18 can under-allocate the clock on startup. Reserve native widget
  // space for the full date and time; the screenshot remains an unedited scrot image.
  await writeFile(join(gtkConfig,'gtk.css'),'#clock-button { min-width: 112px; }\n',{mode:0o600});
  await exec('xauth',['-f',authority,'add',display,'MIT-MAGIC-COOKIE-1',randomBytes(16).toString('hex')],{env,timeout:5000});
  const server=start('Xvfb',[display,'-screen','0',`${screen.width}x${screen.height}x24`,'-nolisten','tcp','-auth',authority]);
  let ready=false;
  for(let i=0;i<100;i++){
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
  // Register the window manager before the panel creates its dock window.
  // Starting both together can leave the panel outside the managed window list.
  let windowManagerReady=false;
  for(let i=0;i<100;i++){
   const {stdout}=await exec('wmctrl',['-m'],{env,timeout:2000}).catch(()=>({stdout:''}));
   if(/^Name: Openbox$/m.test(stdout)){windowManagerReady=true;break;}
   await new Promise(r=>setTimeout(r,100));
  }
  if(!windowManagerReady)throw Error('INTEGRITY_WINDOW_MANAGER_UNAVAILABLE');
  start('xfdesktop',['--disable-wm-check']);
  const panel=start('xfce4-panel',['--disable-wm-check']);
  let panelReady=false;
  for(let i=0;i<100;i++){
   if(panel.exitCode!==null)break;
   const {stdout}=await exec('wmctrl',['-l','-x'],{env,timeout:2000}).catch(()=>({stdout:''}));
   if(/xfce4-panel/i.test(stdout)){panelReady=true;break;}
   await new Promise(r=>setTimeout(r,100));
  }
  if(!panelReady)throw Error('INTEGRITY_NATIVE_PANEL_UNAVAILABLE');
  if(panel.exitCode!==null)throw Error('INTEGRITY_CLOCK_START_FAILED');
  const assertBottomPanel=async()=>{
   const {stdout}=await exec('wmctrl',['-l','-G','-x'],{env,timeout:2000});
   const panels=stdout.split('\n').filter(line=>/xfce4-panel/i.test(line));
   const fields=panels[0]?.trim().split(/\s+/);
   if(panels.length!==1||!fields||Number(fields[2])!==0||Number(fields[3])<screen.height-60||
    Number(fields[3])+Number(fields[5])!==screen.height||Number(fields[4])!==screen.width||Number(fields[5])<40){
    throw Error('INTEGRITY_BOTTOM_TASKBAR_UNAVAILABLE');
   }
  };
  let sequence=0;
  return {env,close,capture:async(page)=>{
   if(server.exitCode!==null||panel.exitCode!==null||bus.exitCode!==null)throw Error('INTEGRITY_DESKTOP_LOST');
   await page.bringToFront();
   await exec('wmctrl',['-r',':ACTIVE:','-b','add,maximized_vert,maximized_horz'],{env,timeout:3000});
   // A mapped/maximized X window can still contain Chromium's blank startup frame.
   // Synchronize its compositor before capturing the native desktop; this buffer
   // is discarded, and the saved evidence remains the untouched scrot image.
   await syncIntegrityCompositor(page);
   // Allow the native window manager to apply its bounds without altering website content.
   await page.waitForTimeout(200);
   await assertBottomPanel();
   const path=join(directory,`screen-${++sequence}.png`);
   await exec('scrot',['--overwrite',path],{env,timeout:10000});
   return readFile(path);
  }};
 }catch(error){await close();throw error;}
}
