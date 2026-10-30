import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

export const directory=fileURLToPath(new URL('.',import.meta.url)),repo=resolve(directory,'../..'),runtime=join(directory,'.runtime');
export const ports={web:5189,api:3089},baseURL=`http://localhost:${ports.web}`,apiURL=`http://127.0.0.1:${ports.api}`;
export const terms='billing-functional-20261030';
// This is the repository's existing synthetic, loopback-only test database.
// Never inherit DATABASE_URL, production providers, model or cloud credentials.
export const pgBase='postgresql://bondbuddy:m3-local-synthetic@127.0.0.1:55432/';
export function atomicJson(path,value){mkdirSync(runtime,{recursive:true});const temp=path+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2)+'\n');renameSync(temp,path);}
export function config(create=false){
  const path=join(runtime,'config.json');
  if(!existsSync(path)){if(!create)throw Error('Run start.mjs first');const id=randomUUID();atomicJson(path,{version:1,id,database:'bb_billing_functional_'+id.replaceAll('-','').slice(0,16),schemaSource:'repository-migrations'});}
  const value=JSON.parse(readFileSync(path,'utf8'));
  if(value.version!==1||!/^[-a-f0-9]{36}$/.test(value.id)||!/^bb_billing_functional_[a-f0-9]{16}$/.test(value.database))throw Error('Invalid isolated test configuration');
  return value;
}
export function cleanEnvironment(){
  const env={...process.env};
  for(const name of Object.keys(env))if(/^(BB_|DATABASE_URL$|PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE|PASSFILE|SSLMODE)$|AZURE_|DEEPSEEK_|OPENAI_|CODEX_|ANTHROPIC_|WECHAT_|ALIPAY_)/i.test(name))delete env[name];
  return {...env,NODE_ENV:'development',BB_DEPLOYMENT_TIER:'local',BB_TRIAL_GUARD:'off',BB_SUBSCRIPTION_BILLING_ENABLED:'1',BB_ALLOWED_ORIGIN:baseURL,BB_TERMS_VERSION:terms,
    BB_API_PROXY_TARGET:apiURL,BB_UPLOAD_SPOOL_DIR:join(runtime,'spool')};
}
