import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {baseURL,runtime,instance} from './config.mjs';
if(instance!=='projects-20261020')throw Error('Use the isolated projects instance');
const account=JSON.parse(readFileSync(join(runtime,'test-accounts.json'),'utf8')).accounts.find(a=>a.username==='integration_user');
const login=await fetch(baseURL+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:baseURL},body:JSON.stringify({username:account.username,password:account.password})});
if(!login.ok)throw Error('Local test login failed');
const cookies=login.headers.getSetCookie().map(c=>c.split(';')[0]),csrf=cookies.find(c=>c.startsWith('bb_csrf='))?.slice(8);
async function request(method,path,body){
  const r=await fetch(baseURL+'/api/v1'+path,{method,headers:{cookie:cookies.join('; '),origin:baseURL,'content-type':'application/json','x-bb-csrf':csrf},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error(await r.text());return r.json();
}
const existing=await request('GET','/projects?archive=all&limit=100');
for(const item of [
  {name:'云河交通 2026 年中期票据（合成验收）',issuer_name:'云河交通发展有限公司（合成验收）',kind:'update',market:'nafmii',offering:'mtn'},
  {name:'新远实业 2026 年公司债（合成验收）',issuer_name:'新远实业有限公司（合成验收）',kind:'review',market:'sse',offering:'private'}
]){
  if(!existing.items.some(p=>p.name===item.name))await request('POST','/projects',item);
}
console.log('Two real draft projects seeded through the authenticated local API; no tasks or model calls created.');
