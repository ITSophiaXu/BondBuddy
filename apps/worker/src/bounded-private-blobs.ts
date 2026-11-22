import {fileURLToPath} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import {azureBlobs,digest,type PrivateBlobs} from '@bondbuddy/api/data';
import {spawn,withBackgroundTaskExecution} from './task-execution.js';

const MAX=100*1024*1024;
type StorageRequest={op:'put'|'get';key:string;max:number;content_type?:string;body?:string};
type Options={connectionString:string;containerName?:string;timeoutMs?:number;command?:string[]};
const childFile=fileURLToPath(import.meta.url);
/** SDK calls are killable processes; a timeout joins them before returning. */
export async function boundedStorageRequest(request:StorageRequest,options:Options):Promise<Buffer|null>{
  const timeout=options.timeoutMs??120000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>120000||!Number.isSafeInteger(request.max)||request.max<1||request.max>MAX)throw Error('STORAGE_IO_BUDGET_INVALID');
  return withBackgroundTaskExecution(()=>new Promise((resolve,reject)=>{
    const command=options.command??[process.execPath,childFile,'--bounded-blob-io'];
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,LANG:'C.UTF-8',AZURE_STORAGE_CONNECTION_STRING:options.connectionString,AZURE_STORAGE_CONTAINER:options.containerName??'bondbuddy-private',HTTPS_PROXY:process.env.HTTPS_PROXY,https_proxy:process.env.https_proxy,NO_PROXY:process.env.NO_PROXY,no_proxy:process.env.no_proxy};
    const child=spawn(command[0]!,command.slice(1),{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    let timedOut=false,failed=false,size=0;const chunks:Buffer[]=[];
    const stop=()=>{try{child.kill('SIGKILL');}catch{}};
    const timer=setTimeout(()=>{timedOut=true;stop();},timeout);
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>request.max){failed=true;stop();}else chunks.push(Buffer.from(chunk));});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{failed=true;});child.once('error',()=>{failed=true;});
    child.once('close',code=>{clearTimeout(timer);if(timedOut||failed||!(code===0||code===3&&request.op==='get'))return reject(Error(timedOut?'STORAGE_IO_TIMEOUT':'STORAGE_IO_FAILED'));resolve(code===3?null:Buffer.concat(chunks));});
    child.stdin.end(JSON.stringify(request));
  }));
}
export function boundedPrivateBlobs(original:PrivateBlobs,options:Options):PrivateBlobs{
  const get=async(key:string,max=MAX)=>boundedStorageRequest({op:'get',key,max},options);
  const put=async(key:string,bytes:Buffer,mediaType:string)=>{if(bytes.length>MAX)throw Error('STORAGE_IO_SIZE_LIMIT');await boundedStorageRequest({op:'put',key,max:1,content_type:mediaType,body:bytes.toString('base64')},options);};
  return {...original,put,get:async key=>{const bytes=await get(key);if(!bytes)throw Error('STORAGE_OBJECT_MISSING');return bytes;},getIfExists:key=>get(key),getIfExistsBounded:get,
    putFile:async(key,path,type)=>put(key,await readFile(path),type),
    readToFile:async(key,path,max)=>{const bytes=await get(key,max);if(!bytes)return null;if(path)await writeFile(path,bytes,{flag:'wx',mode:0o600});return {byteSize:bytes.length,sha256:digest(bytes)};}};
}
async function childMain(){
  const chunks:Buffer[]=[];let length=0;for await(const chunk of process.stdin){length+=chunk.length;if(length>MAX*1.4+4096)throw Error('STORAGE_IO_SIZE_LIMIT');chunks.push(Buffer.from(chunk));}
  const request=JSON.parse(Buffer.concat(chunks).toString('utf8')) as StorageRequest;
  if(!request||!['get','put'].includes(request.op)||typeof request.key!=='string'||!request.key||request.key.length>4096||!Number.isSafeInteger(request.max)||request.max<1||request.max>MAX||!process.env.AZURE_STORAGE_CONNECTION_STRING)throw Error('STORAGE_IO_REQUEST_INVALID');
  const blobs=azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING,process.env.AZURE_STORAGE_CONTAINER??'bondbuddy-private');
  if(request.op==='put'){if(typeof request.body!=='string'||typeof request.content_type!=='string')throw Error('STORAGE_IO_REQUEST_INVALID');const bytes=Buffer.from(request.body,'base64');if(bytes.length>MAX||bytes.toString('base64')!==request.body)throw Error('STORAGE_IO_SIZE_LIMIT');await blobs.put(request.key,bytes,request.content_type);}
  else{const bytes=await blobs.getIfExistsBounded(request.key,request.max);if(bytes===null){process.exitCode=3;return;}process.stdout.write(bytes);}
}
if(process.argv[2]==='--bounded-blob-io')childMain().catch(()=>{process.stderr.write('Private storage IO failed.\n');process.exitCode=1;});
