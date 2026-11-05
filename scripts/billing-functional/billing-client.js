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
let refreshingSession;
async function read(response){
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(`${data.code??response.status}：${data.message??'请求失败'}`);error.status=response.status;error.code=data.code;throw error;}
  return data;
}
async function refreshSession(){
  if(!refreshingSession){
    const pending=fetch('/api/v1/auth/refresh',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'x-bb-csrf':csrf()}}).then(read);
    refreshingSession=pending;void pending.finally(()=>{if(refreshingSession===pending)refreshingSession=undefined;}).catch(()=>{});
  }
  await refreshingSession;
}
export async function send(path,body={}){
  // Only an explicit 401 permits one refresh and one identical replay. Network,
  // forbidden and unknown failures never silently replay a financial action.
  const serialized=JSON.stringify(body),request=()=>fetch('/__billing-test/api/'+path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json','x-bb-csrf':csrf()},body:serialized});
  let response=await request();if(response.status===401&&csrf()){await refreshSession();response=await request();}
  return read(response);
}

export async function storedAction({key,create,perform,validate,accepted,storage=localStorage}){
  // Persist before the request. An unknown response keeps this exact body for
  // the next click/reload; only its own verified acknowledgement clears it.
  let serialized=storage.getItem(key),intent;
  if(serialized===null){intent=create();serialized=JSON.stringify(intent);}
  else{try{intent=JSON.parse(serialized);}catch{throw Error('原测试操作记录无效，未提交新请求。');}}
  if(!validate(intent))throw Error('原测试操作记录无法核实，未提交新请求。');
  storage.setItem(key,serialized);if(storage.getItem(key)!==serialized)throw Error('未能可靠保存原测试操作，未提交。');
  const result=await perform(intent);
  if(!accepted(result,intent))throw Error('操作结果尚未核实，保留原操作 ID；请刷新后重试同一请求。');
  if(storage.getItem(key)!==serialized)throw Error('原操作已返回，但本机请求记录已变化；请核对原操作。');
  storage.removeItem(key);if(storage.getItem(key)!==null)throw Error('原操作已返回，但本机重试记录清理未确认；请核对后重试。');
  return result;
}
