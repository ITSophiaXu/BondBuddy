import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {join} from 'node:path';
import {repo,environment} from './config.mjs';

export function windowsProcess(input){
  const env=environment();
  const result=spawnSync(env.BB_PYTHON,[join(repo,'scripts/local-integration/windows_process.py')],
    {input:JSON.stringify(input),env,cwd:repo,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});
  let response;
  try{response=JSON.parse(result.stdout);}catch{throw new Error(result.stderr||result.error?.message||'Local process helper returned no receipt');}
  if(result.status!==0||!response.ok)throw new Error(response.error||result.stderr||'Local process helper failed');
  return response.result;
}
export const identity=pid=>windowsProcess({action:'identity',pid});
export const sameIdentity=(a,b)=>!!a&&!!b&&a.pid===b.pid&&a.createdTicks===b.createdTicks&&a.exe.toLowerCase()===b.exe.toLowerCase();
export const inspect=pids=>windowsProcess({action:'inspect',pids});
export const consoleState=ref=>windowsProcess({action:'console',ref});
export const terminate=ref=>windowsProcess({action:'terminate',ref});

export async function withLifecycleLock(directory,work){
  const env=environment(),name='Local\\BondBuddyIntegration_'+createHash('sha256').update(directory.toLowerCase()).digest('hex');
  const child=spawn(env.BB_PYTHON,[join(repo,'scripts/local-integration/windows_process.py'),'lock',name],
    {env,cwd:repo,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close');
  let errorText='';child.stderr.on('data',b=>errorText+=b);
  try{
    await new Promise((resolve,reject)=>{
      let output='';
      const timeout=setTimeout(()=>reject(new Error('Timed out acquiring the lifecycle mutex')),10000);
      child.once('error',e=>{clearTimeout(timeout);reject(e);});
      child.once('exit',()=>{clearTimeout(timeout);reject(new Error(errorText||'Lifecycle lock helper exited'));});
      child.stdout.on('data',b=>{output+=b;if(output.includes('\n')){clearTimeout(timeout);try{const r=JSON.parse(output.trim());r.ok?resolve():reject(new Error(r.error));}catch(e){reject(e);}}});
    });
    return await work();
  }finally{
    child.stdin.end();
    const force=setTimeout(()=>child.kill(),5000);
    try{await closed;}finally{clearTimeout(force);}
  }
}
