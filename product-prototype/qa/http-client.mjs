export function createClient(){let cookie='';const request=async(url,options={})=>{const headers=new Headers(options.headers);if(cookie)headers.set('Cookie',cookie);const response=await globalThis.fetch(url,{...options,headers});const value=response.headers.get('set-cookie');if(value)cookie=value.split(';')[0];return response;};return request;}
export async function signIn(request,base,phone='13800138000'){
  const post=(path,data)=>request(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const codeResponse=await post('/api/auth/code',{phone});if(!codeResponse.ok)throw new Error(await codeResponse.text());const c=await codeResponse.json();
  const verified=await post('/api/auth/verify',{phone,code:c.demoCode,challengeId:c.challengeId});if(!verified.ok)throw new Error(await verified.text());return verified.json();
}
