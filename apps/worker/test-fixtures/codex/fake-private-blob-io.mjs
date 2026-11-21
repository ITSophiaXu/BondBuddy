// Synthetic disk storage for the production killed-and-joined Blob IO adapter.
// AZURE_STORAGE_CONNECTION_STRING is a private fixture directory, not a cloud
// credential. No network request or SDK success response is fabricated.
import {readFile,writeFile,mkdir,rm,rename} from 'node:fs/promises';
import {join,dirname,resolve,sep} from 'node:path';
const root=resolve(process.env.AZURE_STORAGE_CONNECTION_STRING??'');
let text='';for await(const chunk of process.stdin)text+=chunk;
const request=JSON.parse(text);
if(!['get','put'].includes(request.op)||typeof request.key!=='string'||!request.key.startsWith('users/')&& !request.key.startsWith('owners/')||request.key.includes('..'))throw Error('SYNTHETIC_STORAGE_REQUEST_INVALID');
const path=resolve(root,request.key);if(!path.startsWith(root+sep))throw Error('SYNTHETIC_STORAGE_SCOPE_INVALID');
const marker=join(root,'stall-next.json');
try{
 const condition=JSON.parse(await readFile(marker,'utf8'));
 if(condition.op===request.op&&request.key.endsWith(condition.suffix)){
  // Rename claims this single failure across simultaneously active IO children.
  await rename(marker,join(root,'stall-consumed.json'));
  await writeFile(join(root,'stalled-pid'),String(process.pid),{mode:0o600});
  process.on('SIGTERM',()=>{});await new Promise(()=>setInterval(()=>{},1000));
 }
}catch(error){if(error.code!=='ENOENT')throw error;}
if(request.op==='put'){
 const body=Buffer.from(request.body,'base64');if(body.toString('base64')!==request.body)throw Error('SYNTHETIC_STORAGE_BODY_INVALID');
 await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,body,{mode:0o600});
}else{
 try{const body=await readFile(path);if(body.length>request.max)throw Error('SYNTHETIC_STORAGE_SIZE_EXCEEDED');process.stdout.write(body);}
 catch(error){if(error.code!=='ENOENT')throw error;process.exitCode=3;}
}
