import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

export const directory=fileURLToPath(new URL('.',import.meta.url)),repo=resolve(directory,'../..');
export const runtime=join(repo,'.local/alipay-integration');
export const ports={web:5199,api:3099,postgres:55449};
export const baseURL=`http://localhost:${ports.web}`,apiURL=`http://127.0.0.1:${ports.api}`;
export const databaseURL='postgresql://bondbuddy_alipay_local:local-sandbox-only@127.0.0.1:55449/bb_alipay_acceptance';
export const terms='alipay-local-acceptance-20261105';
export const username='alipay_tester',password='Local-Alipay-Test-2026!';
export function atomicJson(path,value){mkdirSync(runtime,{recursive:true});const tmp=path+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');renameSync(tmp,path);}
export function config(create=false){
  const path=join(runtime,'instance.json');
  if(!existsSync(path)){if(!create)throw Error('Start the Alipay acceptance environment first');atomicJson(path,{version:1,id:randomUUID(),repo,database:'bb_alipay_acceptance'});}
  const value=JSON.parse(readFileSync(path,'utf8'));
  if(value.version!==1||!/^[-a-f0-9]{36}$/.test(value.id)||value.repo!==repo||value.database!=='bb_alipay_acceptance')throw Error('Unowned local Alipay instance');
  return value;
}
export function cleanEnvironment(source=process.env){
  // An allowlist prevents ambient production DB, payment, model and cloud settings
  // (including NODE_OPTIONS preload hooks) from reaching this local process.
  const env={};
  for(const name of Object.keys(source))if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS)$/i.test(name))env[name]=source[name];
  return {...env,NODE_ENV:'test',BB_DEPLOYMENT_TIER:'local',BB_TRIAL_GUARD:'off',BB_SUBSCRIPTION_BILLING_ENABLED:'1',
    BB_ALLOWED_ORIGIN:baseURL,BB_TERMS_VERSION:terms,BB_API_PROXY_TARGET:apiURL,BB_UPLOAD_SPOOL_DIR:join(runtime,'spool'),
    BB_ALIPAY_PAY_ENABLED:'1',BB_ALIPAY_ENVIRONMENT:'sandbox',BB_ALIPAY_WEB_PRODUCT:'page',BB_ALIPAY_REFUND_ENABLED:'1',
    BB_ALIPAY_RETURN_URL:baseURL+'/payment/alipay/return.html'};
}
