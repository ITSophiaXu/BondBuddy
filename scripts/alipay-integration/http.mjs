import {BILLING_WIRE_HEADER,BILLING_WIRE_VERSION} from '@bondbuddy/contracts';
import {baseURL} from './config.mjs';
export function client(){
  const cookies=new Map();
  return async(method,path,body,options={})=>{
    const headers={origin:baseURL,cookie:[...cookies].map(([key,value])=>key+'='+value).join('; '),'x-bb-csrf':cookies.get('bb_csrf')??'',
      [BILLING_WIRE_HEADER]:BILLING_WIRE_VERSION,...(body===undefined?{}:{'content-type':'application/json'}),...options.headers};
    const r=await fetch(baseURL+path,{method,headers,signal:AbortSignal.timeout(20000),...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const value of r.headers.getSetCookie()){const pair=value.split(';',1)[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
    const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    const expected=options.expected??(method==='POST'&&['/api/v1/auth/register','/api/v1/subscriptions','/api/v1/commerce/topups'].includes(path)?201:200);
    if(r.status!==expected){const error=new Error(`Unexpected HTTP status ${r.status} (expected ${expected}) for ${method} ${path.split('?')[0]}; code=${typeof data?.code==='string'?data.code:'unknown'}`);error.status=r.status;error.code=data?.code;throw error;}
    return data;
  };
}
