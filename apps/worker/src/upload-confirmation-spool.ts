import {spawn} from './task-execution.js';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,realpath,rm,statfs} from 'node:fs/promises';
import {join,resolve} from 'node:path';

/** A dedicated process owns this directory until every stream has settled. Kernel
 * flock survives SIGSTOP and is released on process death, including SIGKILL. */
export async function acquireConfirmationSpool(root:string,budget:number):Promise<()=>Promise<void>>{
  await mkdir(root,{recursive:true,mode:0o700});
  const info=await lstat(root),fs=await statfs(root);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||await realpath(root)!==resolve(root)||
    [0x01021994,0x858458f6].includes(fs.type)||fs.bavail*fs.bsize<budget+16*1024*1024)
    throw new Error('Dedicated disk-backed upload confirmation spool is unavailable');
  const path=join(root,'.confirmation.lock');
  const handle=await open(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  let release:(()=>Promise<void>)|undefined;
  try{
    const lock=await handle.stat();
    if(!lock.isFile()||lock.nlink!==1||lock.uid!==process.getuid?.()||(lock.mode&0o077)!==0)throw new Error('Unsafe confirmation lock');
    const child=spawn('sh',['-c','flock -xn 3 || exit 73; printf READY; exec cat >/dev/null'],{stdio:['pipe','pipe','ignore',handle.fd]});
    const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    release=async()=>{child.stdin!.end();await exited;};
    await new Promise<void>((accept,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(new Error('Confirmation spool lock timed out'));},5000);
      const finish=(error?:Error)=>{clearTimeout(timer);error?reject(error):accept();};
      child.stdout!.once('data',bytes=>finish(String(bytes)==='READY'?undefined:new Error('Confirmation spool lock failed')));
      child.once('error',()=>finish(new Error('Confirmation spool lock failed')));
      child.once('exit',()=>finish(new Error('Confirmation spool is already owned or locking failed')));
    });
    // Validate the entire directory before deleting any old, managed spool file.
    const files=(await readdir(root)).filter(name=>name!=='.confirmation.lock');
    for(const name of files){
      const file=await lstat(join(root,name));
      if(!/^[a-f0-9-]{36}\.(blob|part)$/.test(name)||!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.uid!==process.getuid?.()||(file.mode&0o077)!==0)
        throw new Error('Unmanaged entry in confirmation spool');
    }
    for(const name of files)await rm(join(root,name));
    return release;
  }catch(error){await release?.();throw error;}
  finally{await handle.close();}
}
