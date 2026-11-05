import assert from 'node:assert/strict';
import {baseURL,terms} from './config.mjs';
import {randomUUID} from 'node:crypto';

/** Real HTTP/session/CSRF client for this loopback-only synthetic environment. */
export function testClient(){
  const cookies=new Map();
  async function send(method,path,body,expected=200,extraHeaders={}){
    const headers={origin:baseURL,cookie:[...cookies].map(([name,value])=>name+'='+value).join('; '),'x-bb-csrf':cookies.get('bb_csrf')??'',...extraHeaders};
    if(body!==undefined)headers['content-type']='application/json';
    const response=await fetch(baseURL+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const value of response.headers.getSetCookie()){const pair=value.split(';',1)[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    assert.equal(response.status,expected,JSON.stringify({path,status:response.status,data}));return data;
  }
  const post=(path,body={},expected=200,headers={})=>send('POST',path,body,expected,headers);
  return {send,post,get:(path,expected=200)=>send('GET',path,undefined,expected),
    state:()=>post('/__billing-test/api/state'),
    register:async(prefix='billing_pay_')=>{const username=prefix+randomUUID().slice(0,8),registered=await post('/api/v1/auth/register',{username,password:'Synthetic-Payment-2026!',accepted_terms_version:terms},201);return {username,owner:registered.user_id};},
    pay:async(id,delivery='query',outcome='paid')=>{
      await post('/__billing-test/api/payment/outcome',{id,outcome,delivery});
      // The local refresh wraps the same product handler and then pumps only
      // this account's saved synthetic tasks through normal checkpoint resume.
      return post('/__billing-test/api/payment/refresh',{id});
    }};
}

/** Persist a synthetic channel result; product refresh still performs crediting. */
export async function payBrowserOrder(page,id,delivery='query'){
  const csrf=(await page.context().cookies(baseURL)).find(cookie=>cookie.name==='bb_csrf')?.value??'';
  const response=await page.context().request.post(baseURL+'/__billing-test/api/payment/outcome',{
    headers:{origin:baseURL,'x-bb-csrf':csrf},data:{id,outcome:'paid',delivery}});
  assert.ok(response.ok(),await response.text());return response.json();
}
