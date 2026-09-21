import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const bundled = join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
export const PYTHON = process.env.BOND_BUDDY_PYTHON || (existsSync(bundled) ? bundled : 'python3');
export const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
export async function atomicJson(path, data) {
  const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(data,null,2));
  try {
    // Windows sync/indexing can briefly lock an existing file during replacement.
    // Retry the atomic rename; never delete or truncate the live state file.
    for(let attempt=0;;attempt++)try{await rename(temp,path);break;}catch(error){
      if(attempt>=6||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
      await new Promise(resolve=>setTimeout(resolve,25*2**attempt));
    }
  }catch(error){await rm(temp,{force:true}).catch(()=>{});throw error;}
}
export function processRun(exe,args,{cwd=ROOT,signal,timeout=120000}={}) {
  return new Promise((resolve,reject) => {
    const child=spawn(exe,args,{cwd,signal,shell:false,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let output='',errors=''; const timer=setTimeout(()=>child.kill(),timeout);
    child.stdout.on('data',d=>{output=(output+d).slice(-12000);}); child.stderr.on('data',d=>{errors=(errors+d).slice(-5000);});
    child.on('error',e=>{clearTimeout(timer);reject(e);}); child.on('close',code=>{clearTimeout(timer); code===0?resolve(output):reject(new Error('文档处理失败，请检查材料是否损坏、加密或为旧版 Word 格式。'));});
  });
}
export const python = (script,args,folder,signal) => processRun(PYTHON,[join(ROOT,'python',script),...args],{cwd:folder,signal});
