import {createReadStream,createWriteStream} from 'node:fs';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Transform,Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {ZipFile} from 'yazl';
import {digest,Problem,type PrivateBlobs} from './data.js';

export type WorkpaperZipFile={path:string;key:string;sha256:string;maxBytes:number};
type Archive={directory:string;path:string;size:number;users:number;expires:number};
type Pending={promise:Promise<Archive>;controller:AbortController;waiters:number};
const unavailable=()=>new Problem(503,'DATA_UNAVAILABLE','底稿文件包暂时无法读取，请稍后重试。已生成文件仍保留，无需重新生成。');

// Bound both opening storage and consuming it. Close a late stream even when an
// adapter ignores cancellation, so it cannot outlive an abandoned build.
async function cancellable<T>(promise:Promise<T>,signal?:AbortSignal,late?:(value:T)=>void):Promise<T>{
  if(!signal)return promise;
  return new Promise<T>((resolve,reject)=>{
    let aborted=false;
    const abort=()=>{aborted=true;reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    promise.then(value=>{if(aborted)late?.(value);else resolve(value);},reject)
      .finally(()=>signal.removeEventListener('abort',abort));
  });
}

/** Private, bounded, process-local cache. Authorization and pin resolution happen
 * on EVERY request before this class is called. Changed pins cannot hit an old ZIP. */
export class WorkpaperZipCache {
  private ready=new Map<string,Archive>();
  private pending=new Map<string,Pending>();
  private closed=false;
  private sweep:ReturnType<typeof setInterval>;
  constructor(private options={ttlMs:10*60_000,maxBytes:256*1024*1024,concurrency:4,timeoutMs:120_000}){
    this.sweep=setInterval(()=>void this.prune().catch(()=>{}),60_000);this.sweep.unref();
  }
  async open(scope:string,files:WorkpaperZipFile[],blobs:PrivateBlobs,signal?:AbortSignal):Promise<{body:Readable;size:number;cached:boolean}>{
    signal?.throwIfAborted();
    if(this.closed)throw unavailable();
    const key=digest(JSON.stringify([scope,files]));
    // Reserve ready entries synchronously before any await, so eviction cannot
    // remove a ZIP between looking it up and opening a response stream.
    let archive=this.ready.get(key),cached=!!archive;
    if(archive&&archive.expires<=Date.now()&&!archive.users){
      this.ready.delete(key);void rm(archive.directory,{recursive:true,force:true}).catch(()=>{});archive=undefined;cached=false;
    }
    if(archive)archive.users++;
    else {
      let work=this.pending.get(key);
      if(!work){
        if(this.pending.size>=2)throw new Problem(503,'DATA_UNAVAILABLE','其他文件包正在准备，请稍后重试下载。');
        // Slow readers may pin expired archives. Bound their count as well as
        // the idle cache bytes; otherwise repeated distinct downloads grow disk.
        if(this.ready.size+this.pending.size>=4){
          const idle=[...this.ready].find(([,a])=>!a.users);
          if(!idle)throw new Problem(503,'DATA_UNAVAILABLE','其他文件包正在下载，请稍后重试。');
          this.ready.delete(idle[0]);void rm(idle[1].directory,{recursive:true,force:true}).catch(()=>{});
        }
        const controller=new AbortController();
        work={controller,waiters:0,promise:undefined!};
        const current=work;
        current.promise=this.build(files,blobs,controller.signal).then(result=>{
          this.ready.set(key,result);return result;
        }).finally(()=>{if(this.pending.get(key)===current)this.pending.delete(key);});
        this.pending.set(key,current);
      }
      work.waiters++;
      try{
        archive=await cancellable(work.promise,signal);
        signal?.throwIfAborted();
        if(this.closed)throw unavailable();
        archive.users++;archive.expires=Date.now()+this.options.ttlMs;this.ready.set(key,archive);
      }finally{
        work.waiters--;
        if(!work.waiters&&this.pending.get(key)===work)work.controller.abort(unavailable());
      }
    }
    const result=archive;
    const body=createReadStream(result.path);
    const abort=()=>body.destroy();
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    body.once('close',()=>{signal?.removeEventListener('abort',abort);result.users--;void this.prune().catch(()=>{});});
    void this.prune().catch(()=>{});
    return {body,size:result.size,cached};
  }
  private async build(files:WorkpaperZipFile[],blobs:PrivateBlobs,parent:AbortSignal):Promise<Archive>{
    const directory=await mkdtemp(join(tmpdir(),'bondbuddy-workpaper-zip-'));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(unavailable()),this.options.timeoutMs);
    const signal=AbortSignal.any([parent,controller.signal]);
    let total=0,index=0,failure:unknown;
    try{
      // Spool and hash in parallel, never retain a batch of DOCX buffers in RAM.
      await Promise.all(Array.from({length:Math.min(this.options.concurrency,files.length)},async()=>{
        while(!failure&&index<files.length){
          const i=index++,file=files[i],path=join(directory,String(i));
          try{
            signal.throwIfAborted();
            let opened:{body:Readable;contentLength:number|undefined}|null;
            if(blobs.openRead){
              opened=await cancellable(blobs.openRead(file.key,signal),signal,value=>value?.body.destroy());
            }else{
              const bytes=await cancellable(blobs.getIfExistsBounded(file.key,Math.min(file.maxBytes,this.options.maxBytes)),signal);
              opened=bytes?{body:Readable.from([bytes]),contentLength:bytes.length}:null;
            }
            if(!opened)throw unavailable();
            const hash=createHash('sha256');let received=0;
            const maxBytes=this.options.maxBytes;
            const check=new Transform({transform(chunk:Buffer,_encoding,callback){
              received+=chunk.length;total+=chunk.length;
              if(received>file.maxBytes||total>maxBytes){callback(unavailable());return;}
              hash.update(chunk);callback(null,chunk);
            }});
            await pipeline(opened.body,check,createWriteStream(path,{flags:'wx',mode:0o600}),{signal});
            if(opened.contentLength!==undefined&&received!==opened.contentLength)throw unavailable();
            if(received===0||hash.digest('hex')!==file.sha256)throw unavailable();
          }catch(error){failure=error;controller.abort(error);}
        }
      }));
      if(failure)throw failure;signal.throwIfAborted();
      const path=join(directory,'workpapers.zip'),zip=new ZipFile();
      zip.on('error',error=>(zip.outputStream as Readable).destroy(error));
      const output=pipeline(zip.outputStream,createWriteStream(path,{flags:'wx',mode:0o600}),{signal});
      // DOCX is already compressed. STORE avoids hundreds of redundant deflates.
      for(const [i,file] of files.entries())zip.addFile(join(directory,String(i)),file.path,{compress:false});
      zip.end();await output;
      await Promise.all(files.map((_file,i)=>rm(join(directory,String(i)),{force:true})));
      signal.throwIfAborted();
      return {directory,path,size:(await stat(path)).size,users:0,expires:Date.now()+this.options.ttlMs};
    }catch{await rm(directory,{recursive:true,force:true});throw unavailable();}
    finally{clearTimeout(timer);}
  }
  private async prune(){
    let size=[...this.ready.values()].reduce((n,a)=>n+a.size,0);
    for(const [key,a] of this.ready){
      if(a.users||a.expires>Date.now()&&size<=this.options.maxBytes)continue;
      this.ready.delete(key);size-=a.size;await rm(a.directory,{recursive:true,force:true});
    }
  }
  async close(){
    this.closed=true;clearInterval(this.sweep);
    for(const work of this.pending.values())work.controller.abort(unavailable());
    const completed=await Promise.allSettled([...this.pending.values()].map(work=>work.promise));
    const archives=new Set([...this.ready.values(),...completed.flatMap(r=>r.status==='fulfilled'?[r.value]:[])]);
    await Promise.all([...archives].map(a=>rm(a.directory,{recursive:true,force:true})));
    this.ready.clear();this.pending.clear();
  }
}
