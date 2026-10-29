import {isAutomaticPriceVersion} from '@bondbuddy/contracts';
import {UserFacingError} from './user-facing-error.js';
import {workReturnTo} from './project-navigation.js';

const prefix='bondbuddy:billing-task:v1:';
const ttl=24*60*60*1000;
export type BillingTask={version:1;id:string;owner:string;path:string;body:Record<string,unknown>;headers:Record<string,string>;requestId:string;returnTo:string;createdAt:number;expiresAt:number;digest:string;requiredPoints?:number;state:'attempting'|'needs_funds'|'unknown'|'resuming'};
type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
let ownerProvider:()=>string|undefined=()=>undefined;
const automaticQuoteIds=new Set<string>();
const quotePoints=new Map<string,number>();
const resumes=new Map<string,Promise<unknown>>();
const resumable=(state:BillingTask['state'])=>['needs_funds','resuming','unknown'].includes(state);
export function configureBillingTaskRecovery(provider:()=>string|undefined){ownerProvider=provider;}
export function observeAutomaticQuotes(value:unknown){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){for(const item of value)observeAutomaticQuotes(item);return;}
  const row=value as Record<string,unknown>;
  const points=row.points??row.amount_fen;
  if(isAutomaticPriceVersion(row.price_version)&&Number.isSafeInteger(points)&&Number(points)>=0)for(const key of ['quote_id','scope_quote_id'])if(typeof row[key]==='string'){automaticQuoteIds.add(row[key]);quotePoints.set(row[key],Number(points));}
  for(const key of ['quote','documents','items'])if(row[key])observeAutomaticQuotes(row[key]);
}
export function automaticTaskPath(path:string){return /^\/runs\/execute$/.test(path)||/^\/projects\/[^/?#]+\/(?:review-executions|review-updates|qa\/runs|integrity\/runs|workpapers\/(?:check-batches|batches(?:\/[^/?#]+\/actions)?)|project-files\/(?:batches|checks(?:\/[^/?#]+\/updates)?))$/.test(path)||/^\/m4\/topics\/[^/?#]+\/(?:messages|execute)$/.test(path);}
function recoverableAction(path:string,body:Record<string,unknown>){return !path.endsWith('/actions')||body.action==='resume'&&body.billing_resume===true;}
function requestKey(body:Record<string,unknown>){for(const key of ['execution_request_id','request_id','submission_request_id'])if(typeof body[key]==='string'&&body[key])return body[key] as string;return undefined;}
function canonical(value:unknown):string{if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
async function hash(value:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
function identity(task:Omit<BillingTask,'digest'>|BillingTask){return {version:task.version,id:task.id,owner:task.owner,path:task.path,body:task.body,headers:task.headers,requestId:task.requestId,returnTo:task.returnTo,createdAt:task.createdAt,expiresAt:task.expiresAt,...(task.requiredPoints!==undefined?{requiredPoints:task.requiredPoints}:{})};}
function storage(){return localStorage;}
export function cleanBillingReturn(hashValue:string){const [path,query='']=hashValue.split('?'),params=new URLSearchParams(query);params.delete('resume_request');return path+(params.size?'?'+params:'');}
export async function createBillingTask(owner:string,path:string,body:Record<string,unknown>,headers:Record<string,string>,returnTo:string,store:StorageLike=storage(),now=Date.now(),requiredPoints?:number):Promise<BillingTask>{
  const requestId=requestKey(body),safeReturn=workReturnTo(cleanBillingReturn(returnTo));
  if(!owner||!automaticTaskPath(path)||!recoverableAction(path,body)||!requestId||!safeReturn)throw new Error('无法安全保存本次任务，请返回任务工作区后重试。');
  const id=await hash([owner,path,requestId]),existing=await readBillingTask(owner,id,store,now);
  const snapshot=JSON.parse(JSON.stringify(body)) as Record<string,unknown>;
  if(existing){if(canonical(existing.body)!==canonical(snapshot)||canonical(existing.headers)!==canonical(headers))throw new Error('原任务输入已变化，请返回工作区重新开始。');return existing;}
  const required=requiredPoints??body.expected_points;
  if(required!==undefined&&(!Number.isSafeInteger(required)||Number(required)<0))throw new UserFacingError('本次任务的积分额度尚未核实，任务尚未提交，请刷新后重试。');
  const base={version:1 as const,...(required!==undefined?{requiredPoints:Number(required)}:{}),id,owner,path,body:snapshot,headers:{...headers},requestId,returnTo:safeReturn,createdAt:now,expiresAt:now+ttl,state:'attempting' as const};
  const task={...base,digest:await hash(identity(base))};try{const raw=JSON.stringify(task);store.setItem(prefix+id,raw);if(store.getItem(prefix+id)!==raw)throw new Error('storage');}catch{throw new UserFacingError('本机无法可靠保存原任务恢复记录，任务尚未提交。请允许浏览器存储后重试。');}return task;
}
export async function readBillingTask(owner:string,id:string,store:StorageLike=storage(),now=Date.now()):Promise<BillingTask|undefined>{
  if(!/^[a-f0-9]{64}$/.test(id))return;
  try{const raw=store.getItem(prefix+id);if(!raw)return;const task=JSON.parse(raw) as BillingTask;
    if(task.version!==1||!['attempting','needs_funds','unknown','resuming'].includes(task.state)||(task.requiredPoints!==undefined&&(!Number.isSafeInteger(task.requiredPoints)||task.requiredPoints<0))||task.id!==id||task.owner!==owner||!automaticTaskPath(task.path)||!task.body||requestKey(task.body)!==task.requestId||!workReturnTo(task.returnTo)||task.expiresAt<=now||task.createdAt>now||task.expiresAt-task.createdAt!==ttl||task.digest!==await hash(identity(task)))return;
    if(!recoverableAction(task.path,task.body))return;
    return task;
  }catch{return;}
}
export async function cancelBillingTask(owner:string,id:string,store:StorageLike=storage()){if(await readBillingTask(owner,id,store))store.removeItem(prefix+id);}
export async function billingTaskReturnTo(owner:string,id:string,store:StorageLike=storage()){const task=await readBillingTask(owner,id,store);if(!task||!resumable(task.state))return undefined;const [path,query='']=task.returnTo.split('?'),params=new URLSearchParams(query);params.set('resume_request',id);return path+'?'+params;}
export function billingTaskRechargeHref(task:BillingTask){return '#/account?'+new URLSearchParams({return_to:task.returnTo,resume_request:task.id});}
function saveState(task:BillingTask,state:BillingTask['state'],store:StorageLike){store.setItem(prefix+task.id,JSON.stringify({...task,state}));}
function failureState(error:unknown){const e=error as {status?:number;code?:string};return e?.status===402&&e.code==='CREDITS_INSUFFICIENT'?'needs_funds':e?.status&&e.status>=400&&e.status<500&&![408,429].includes(e.status)?'rejected':'unknown';}
async function submitTask<T>(task:BillingTask,submit:()=>Promise<T>,store:StorageLike):Promise<T>{
  try{const result=await submit();store.removeItem(prefix+task.id);return result;}catch(error){const state=failureState(error);if(state==='rejected')store.removeItem(prefix+task.id);else{saveState(task,state,store);if(state==='needs_funds'&&typeof window!=='undefined')window.dispatchEvent(new CustomEvent('bondbuddy:billing-task-needs-funds',{detail:{...task,state}}));}throw error;}
}
/** Captures only a user-created task with a new server quote; it never creates payments. */
export async function runRecoverableBillingRequest<T>(method:string,path:string,body:unknown,headers:Record<string,string>,submit:()=>Promise<T>):Promise<T>{
  const owner=ownerProvider(),row=body&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:undefined;
  if(method!=='POST'||!owner||!automaticTaskPath(path)||!row||!recoverableAction(path,row)||!requestKey(row)||!(isAutomaticPriceVersion(row.price_version)||typeof row.quote_id==='string'&&automaticQuoteIds.has(row.quote_id)||typeof row.scope_quote_id==='string'&&automaticQuoteIds.has(row.scope_quote_id)))return submit();
  const fallback=path.match(/^\/m4\/topics\/([^/]+)\//),project=typeof row.project_id==='string'?row.project_id:path.match(/^\/projects\/([^/]+)\//)?.[1],returnTo=workReturnTo(location.hash)??(fallback?'#generate?topic='+fallback[1]:project?'#/projects/'+encodeURIComponent(project):null);
  if(!returnTo)throw new Error('请打开本次任务工作区后开始。');
  const quoteId=typeof row.quote_id==='string'?row.quote_id:typeof row.scope_quote_id==='string'?row.scope_quote_id:undefined;
  const task=await createBillingTask(owner,path,row,headers,returnTo,storage(),Date.now(),quoteId?quotePoints.get(quoteId):undefined);return submitTask(task,submit,storage());
}
/** Only the named task returns from payment. The server still validates input, quote and idempotency. */
export async function resumeBillingTask<T>(owner:string,id:string,returnTo:string,submit:(path:string,body:Record<string,unknown>,headers:Record<string,string>)=>Promise<T>,store:StorageLike=storage()):Promise<T|undefined>{
  const key=owner+':'+id,existing=resumes.get(key);if(existing)return existing as Promise<T|undefined>;
  const run=async()=>{const task=await readBillingTask(owner,id,store);if(!task||task.returnTo!==cleanBillingReturn(returnTo)||!resumable(task.state))return undefined;saveState(task,'resuming',store);return submitTask(task,()=>submit(task.path,task.body,task.headers),store);};
  const pending=typeof navigator!=='undefined'&&navigator.locks?navigator.locks.request(prefix+id,run):run();resumes.set(key,pending);
  try{return await pending;}finally{if(resumes.get(key)===pending)resumes.delete(key);}
}
