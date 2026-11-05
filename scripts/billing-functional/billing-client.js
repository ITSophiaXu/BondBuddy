// This module is served only by the authenticated loopback billing harness.
export const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export const points=value=>BigInt(value??'0').toLocaleString('zh-CN');
export function money(value){const fen=BigInt(value??'0');return '¥'+(fen/100n).toLocaleString('zh-CN')+'.'+String(fen%100n).padStart(2,'0');}
export function yuanToFen(value){
  const text=String(value).trim();if(!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text))return null;
  const [whole,fraction='']=text.split('.'),fen=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  return fen>0n?fen.toString():null;
}
export function accountReturn(orderId,value,origin){
  const fallback='/#/account?order='+encodeURIComponent(orderId);
  if(!value)return fallback;
  try{
    const url=new URL(value,origin),hash=url.hash.replace(/^#\/?/,'');
    if(url.origin!==origin||url.pathname!=='/'||!hash.startsWith('account?'))return fallback;
    if(new URLSearchParams(hash.slice('account?'.length)).get('order')!==orderId)return fallback;
    return url.pathname+url.search+url.hash;
  }catch{return fallback;}
}
const csrf=()=>document.cookie.split(';').map(part=>part.trim()).find(part=>part.startsWith('bb_csrf='))?.slice(8)??'';
let refreshingSession,sessionController=new AbortController(),knownOwner;
const sessionChangedError=()=>Object.assign(new Error('账号会话已变化，原操作不会在新账号下自动重放。'),{status:401,code:'SESSION_CHANGED'});
async function read(response){
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(`${data.code??response.status}：${data.message??'请求失败'}`);error.status=response.status;error.code=data.code;throw error;}
  return data;
}
async function refreshSession(signal){
  if(!refreshingSession||refreshingSession.signal!==signal){
    const pending=fetch('/api/v1/auth/refresh',{method:'POST',credentials:'same-origin',cache:'no-store',signal,headers:{'x-bb-csrf':csrf()}}).then(read);
    const entry={signal,pending};refreshingSession=entry;
    void pending.finally(()=>{if(refreshingSession===entry)refreshingSession=undefined;}).catch(()=>{});
  }
  return refreshingSession.pending;
}
export async function send(path,body={}){
  // Only an explicit 401 permits one refresh and one identical replay. Network,
  // forbidden and unknown failures never silently replay a financial action.
  const serialized=JSON.stringify(body),signal=sessionController.signal,originalCsrf=csrf(),originalOwner=path==='state'?undefined:knownOwner;
  const request=token=>fetch('/__billing-test/api/'+path,{method:'POST',credentials:'same-origin',cache:'no-store',signal,headers:{'content-type':'application/json','x-bb-csrf':token,...(originalOwner?{'x-bb-test-owner':originalOwner}:{})},body:serialized});
  try{
    let response=await request(originalCsrf);
    if(signal.aborted)throw sessionChangedError();
    if(response.status===401&&originalCsrf){
      // Another tab can replace the cookie before its broadcast is delivered.
      // Such a request must never be refreshed/replayed as the new account.
      if(csrf()!==originalCsrf)throw sessionChangedError();
      const refreshed=await refreshSession(signal);
      if(signal.aborted)throw sessionChangedError();
      if(originalOwner&&refreshed?.user_id!==originalOwner)throw sessionChangedError();
      response=await request(csrf());
    }
    const result=await read(response);if(signal.aborted)throw sessionChangedError();
    if(result?.synthetic===true)knownOwner=typeof result.owner_user_id==='string'?result.owner_user_id:undefined;
    return result;
  }catch(error){if(signal.aborted)throw sessionChangedError();throw error;}
}

export function watchSessionChanges(invalidate){
  // Use the product's existing cross-tab identity signal. Focus/visibility also
  // recheck a restored tab where a browser does not support BroadcastChannel.
  const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('bondbuddy-session'):undefined;
  const changed=()=>{sessionController.abort();sessionController=new AbortController();knownOwner=undefined;invalidate();};
  channel?.addEventListener('message',changed);
  window.addEventListener('focus',changed);
  const visible=()=>{if(document.visibilityState==='visible')changed();};
  document.addEventListener('visibilitychange',visible);
  return()=>{channel?.close();window.removeEventListener('focus',changed);document.removeEventListener('visibilitychange',visible);};
}

const memoryActionLocks=new WeakMap();
const browserActionLocks=()=>typeof window==='undefined'?undefined:globalThis.navigator?.locks;
const assertSession=signal=>{if(signal.aborted)throw sessionChangedError();};
export async function withActionStorageLock({key,storage=globalThis.localStorage,locks=browserActionLocks(),signal=sessionController.signal},operation){
  assertSession(signal);
  if(!storage||!['object','function'].includes(typeof storage))throw Error('当前环境无法可靠保存原测试操作，未提交。');
  const critical=()=>{assertSession(signal);return operation();};
  if(typeof locks?.request==='function'){
    try{const result=await locks.request('bondbuddy-local-billing-action:'+key,{mode:'exclusive',signal},critical);assertSession(signal);return result;}
    catch(error){if(signal.aborted)throw sessionChangedError();throw error;}
  }
  // A page-local mutex cannot protect localStorage against another tab.
  if(typeof window!=='undefined'&&storage===globalThis.localStorage)throw Error('当前浏览器缺少跨标签安全锁，原测试操作未提交。请使用支持 Web Locks 的桌面浏览器。');
  // Custom in-memory stores used by tests have no other browser process. Keep
  // their locks separate by both the storage object and its exact action key.
  let queue=memoryActionLocks.get(storage);if(!queue){queue=new Map();memoryActionLocks.set(storage,queue);}
  const previous=queue.get(key)??Promise.resolve(),pending=previous.catch(()=>{}).then(critical);queue.set(key,pending);
  try{const result=await pending;assertSession(signal);return result;}finally{if(queue.get(key)===pending)queue.delete(key);}
}
export async function persistStoredIntent({key,create,validate,storage=globalThis.localStorage,locks=browserActionLocks(),signal=sessionController.signal}){
  return withActionStorageLock({key,storage,locks,signal},()=>{
    let serialized=storage.getItem(key),intent;
    if(serialized===null){intent=create();serialized=JSON.stringify(intent);}
    else{try{intent=JSON.parse(serialized);}catch{throw Error('原测试操作记录无效，未提交新请求。');}}
    if(!validate(intent))throw Error('原测试操作记录无法核实，未提交新请求。');
    storage.setItem(key,serialized);if(storage.getItem(key)!==serialized)throw Error('未能可靠保存原测试操作，未提交。');
    return {intent,serialized};
  });
}
export async function acknowledgeStoredIntent({key,serialized,storage=globalThis.localStorage,locks=browserActionLocks(),signal=sessionController.signal}){
  return withActionStorageLock({key,storage,locks,signal},()=>{
    const current=storage.getItem(key);
    // Another tab may already have acknowledged this exact operation and may
    // even have saved its successor. Neither fact invalidates our real receipt.
    if(current!==serialized)return current;
    storage.removeItem(key);const remaining=storage.getItem(key);
    if(remaining!==null)throw Error('原操作已核实成功，但本机重试记录清理未确认；请核对后刷新。');
    return null;
  });
}
export async function storedAction({key,create,perform,validate,accepted,storage=globalThis.localStorage,locks=browserActionLocks()}){
  // Only short storage operations hold the cross-tab lock. HTTP remains free
  // to finish in either tab; every caller verifies its own exact acknowledgement.
  const signal=sessionController.signal;
  const {intent,serialized}=await persistStoredIntent({key,create,validate,storage,locks,signal});assertSession(signal);
  const result=await perform(intent);assertSession(signal);
  if(!accepted(result,intent))throw Error('操作结果尚未核实，保留原操作 ID；请刷新后重试同一请求。');
  assertSession(signal);await acknowledgeStoredIntent({key,serialized,storage,locks,signal});assertSession(signal);
  return result;
}
