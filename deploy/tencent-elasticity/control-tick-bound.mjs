import {open,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {requireThat} from './policy.mjs';
import {readPrivateJson} from './private-files.mjs';
import {replacePrivateJson} from './transport-renewal.mjs';

/** A persisted rate bound for the existing tick, not another scheduler. The
 * shared private vault survives restarts and serializes all local instances. */
export async function acquireControlTick(directory,{now=Date.now}={}){
  requireThat(directory?.startsWith('/'),'CONTROL_RATE_DIRECTORY');
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=await open(`${directory}/control-tick.lock`,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  try{
    const stat=await file.stat();requireThat(stat.isFile()&&stat.uid===process.getuid()&&(stat.mode&0o777)===0o600,'CONTROL_RATE_LOCK');
    const code=await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/flock',['--nonblock','3'],{stdio:['ignore','ignore','ignore',file.fd]});child.once('error',reject);child.once('close',resolve);});
    if(code===1){await file.close();return null;}requireThat(code===0,'CONTROL_RATE_LOCK');
    const path=`${directory}/control-tick.json`;let previous;
    try{previous=await readPrivateJson(path);}catch(error){if(error.code!=='ENOENT')throw error;}
    const at=now();requireThat(Number.isSafeInteger(at)&&at>=0,'CONTROL_RATE_CLOCK');
    if(previous){requireThat(Number.isSafeInteger(previous.last_started_at),'CONTROL_RATE_STATE');
      if(at<previous.last_started_at+60000){await file.close();return null;}}
    await replacePrivateJson(path,{last_started_at:at});
    return ()=>file.close();
  }catch(error){await file.close();throw error;}
}
