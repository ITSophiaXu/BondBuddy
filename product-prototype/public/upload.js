// Byte progress comes from the browser transport, never from a timer.
export function uploadMultipart(path,body,{onProgress=()=>{},XMLHttpRequest:XHR=globalThis.XMLHttpRequest,signal}={}){
  return new Promise((resolve,reject)=>{
    const xhr=new XHR();let finished=false;
    const done=(error,value)=>{if(finished)return;finished=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort=()=>xhr.abort();
    xhr.open('POST',path);xhr.withCredentials=true;xhr.timeout=300000;
    xhr.upload.onprogress=e=>onProgress({loaded:e.loaded,total:e.lengthComputable&&e.total>0?e.total:null,percent:e.lengthComputable&&e.total>0?Math.min(100,Math.floor(e.loaded/e.total*100)):null});
    xhr.upload.onload=()=>onProgress({percent:100,transferred:true});
    xhr.onload=()=>{let value;try{value=JSON.parse(xhr.responseText);}catch{return done(new Error('服务未返回有效结果，请重试。'));}if(xhr.status<200||xhr.status>=300)return done(Object.assign(new Error(value.error||'上传未成功，请重试。'),{status:xhr.status,code:value.code}));done(null,value);};
    xhr.onerror=()=>done(new Error('上传连接中断，文件尚未确认保存，请重试。'));
    xhr.ontimeout=()=>done(new Error('上传超时，请重试或拆分文件。'));
    xhr.onabort=()=>done(new Error('上传已取消。'));
    if(signal?.aborted)return done(new Error('上传已取消。'));
    signal?.addEventListener('abort',abort,{once:true});onProgress({percent:0});xhr.send(body);
  });
}
