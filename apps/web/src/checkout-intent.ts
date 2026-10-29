import {SUBSCRIPTION_PLANS,type SubscriptionCheckoutRequest} from '@bondbuddy/contracts';
import {UserFacingError} from './user-facing-error.js';
import {workReturnTo} from './project-navigation.js';

type Provider='wechat'|'alipay';
export type CheckoutChoice={kind:'subscription';subscription_id?:string;plan_id:SubscriptionCheckoutRequest['plan_id'];provider:Provider}
  |{kind:'topup';amount_fen:number;provider:Provider;project_id?:string};
export type CheckoutOrder={order_id:string;provider:Provider;state:'pending'|'paid'|'expired'|'failed';amount_fen:number;points:number};
export type CheckoutContext={project_id?:string;return_to?:string;resume_request?:string};
export type CheckoutIntent={version:1;owner:string;request_id:string;created_at:number;choice:CheckoutChoice;context?:CheckoutContext;order?:CheckoutOrder};
type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type Lock=<T>(name:string,work:()=>Promise<T>)=>Promise<T>;
type Environment={storage:StorageLike;lock:Lock};
const prefix='bondbuddy:checkout-intent:v1:';
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
const blocked=()=>new UserFacingError('原付款意图无法可靠读取或保存，未另建付款。请保留原订单并联系支持核对。');
const conflict=()=>new UserFacingError('已有原付款待核对，请继续原付款。核实原单结束后才能更换套餐或充值金额。');
function choiceValid(value:unknown):value is CheckoutChoice{
  if(!object(value)||!['wechat','alipay'].includes(String(value.provider)))return false;
  return value.kind==='subscription'?keys(value,['kind','subscription_id','plan_id','provider'])&&SUBSCRIPTION_PLANS.some(p=>p.id===value.plan_id)&&(value.subscription_id===undefined||id(value.subscription_id)):
    value.kind==='topup'&&keys(value,['kind','amount_fen','provider','project_id'])&&Number.isSafeInteger(value.amount_fen)&&Number(value.amount_fen)>=1&&Number(value.amount_fen)<=1_000_000&&(value.project_id===undefined||id(value.project_id));
}
function sameChoice(a:CheckoutChoice,b:CheckoutChoice){return a.kind===b.kind&&a.provider===b.provider&&(a.kind==='subscription'&&b.kind==='subscription'?a.plan_id===b.plan_id&&a.subscription_id===b.subscription_id:a.kind==='topup'&&b.kind==='topup'&&a.amount_fen===b.amount_fen&&a.project_id===b.project_id);}
function contextValid(value:unknown):value is CheckoutContext{return object(value)&&keys(value,['project_id','return_to','resume_request'])&&(value.project_id===undefined||id(value.project_id))&&(value.resume_request===undefined||id(value.resume_request))&&(value.return_to===undefined||typeof value.return_to==='string'&&workReturnTo(value.return_to)===value.return_to);}
function orderValid(intent:Pick<CheckoutIntent,'choice'>,value:unknown):value is CheckoutOrder{
  if(!object(value)||!id(value.order_id)||value.provider!==intent.choice.provider||!['pending','paid','expired','failed'].includes(String(value.state)))return false;
  if(!Number.isSafeInteger(value.amount_fen)||Number(value.amount_fen)<=0||!Number.isSafeInteger(value.points)||Number(value.points)<=0)return false;
  // Subscription prices are an immutable server order snapshot, not today's
  // catalog. A published plan change must not strand an accepted old checkout.
  return intent.choice.kind==='subscription'||value.amount_fen===intent.choice.amount_fen&&value.points===intent.choice.amount_fen;
}
function environment():Environment{
  if(typeof navigator==='undefined'||!navigator.locks)throw blocked();
  try{return{storage:localStorage,lock:async(name,work)=>await navigator.locks.request(name,work)};}catch{throw blocked();}
}
export function checkoutIntentKey(owner:string){if(!id(owner))throw blocked();return prefix+owner;}
export const checkoutPending=(intent:CheckoutIntent|undefined)=>!!intent&&(!intent.order||intent.order.state==='pending');
export function readCheckoutIntent(owner:string,storage:StorageLike=environment().storage):CheckoutIntent|undefined{
  try{
    const raw=storage.getItem(checkoutIntentKey(owner));if(raw===null)return undefined;
    const v:unknown=JSON.parse(raw);
    if(!object(v)||!keys(v,['version','owner','request_id','created_at','choice','context','order'])||v.version!==1||v.owner!==owner||!id(v.request_id)||!Number.isSafeInteger(v.created_at)||!choiceValid(v.choice)||v.context!==undefined&&!contextValid(v.context)||v.order!==undefined&&!orderValid({choice:v.choice},v.order))throw blocked();
    return v as CheckoutIntent;
  }catch{throw blocked();}
}
function save(intent:CheckoutIntent,storage:StorageLike){
  try{const raw=JSON.stringify(intent),key=checkoutIntentKey(intent.owner);storage.setItem(key,raw);if(storage.getItem(key)!==raw)throw blocked();}catch{throw blocked();}
}
function bind(intent:CheckoutIntent,order:CheckoutOrder):CheckoutIntent{
  if(!orderValid(intent,order)||intent.order&&(intent.order.order_id!==order.order_id||intent.order.amount_fen!==order.amount_fen||intent.order.points!==order.points)||intent.order?.state==='paid'&&order.state!=='paid')throw blocked();
  // Only the service's authenticated order state ends an intent. No local TTL,
  // checkout exception, route change or client cancellation can do so.
  const snapshot={order_id:order.order_id,provider:order.provider,state:order.state,amount_fen:order.amount_fen,points:order.points};
  return{...intent,order:snapshot};
}
/** Serialize all checkout choices for one owner across tabs. An observer of a
 * completed intent may explicitly buy again; a stale tab reuses the old intent. */
export async function submitCheckoutIntent(owner:string,choice:CheckoutChoice|undefined,observedFinalRequestId:string|undefined,
  submit:(intent:CheckoutIntent)=>Promise<CheckoutOrder>,env:Environment=environment(),context?:CheckoutContext):Promise<CheckoutIntent>{
  return env.lock(checkoutIntentKey(owner),async()=>{
    let intent=readCheckoutIntent(owner,env.storage);
    if(choice&&!choiceValid(choice))throw blocked();
    const replace=!!intent&&!checkoutPending(intent)&&observedFinalRequestId===intent.request_id;
    if(!intent||replace){
      if(!choice||context!==undefined&&!contextValid(context))throw blocked();
      intent={version:1,owner,request_id:crypto.randomUUID(),created_at:Date.now(),choice:{...choice},...(context?{context:{...context}}:{})};save(intent,env.storage);
    }else if(choice&&!sameChoice(intent.choice,choice))throw conflict();
    const result=bind(intent,await submit(intent));save(result,env.storage);return result;
  });
}
/** A GET/refresh for an already bound order can update its status. A different
 * order cannot erase an unknown checkout or acknowledge another tab's choice. */
export async function observeCheckoutOrder(owner:string,order:CheckoutOrder,env:Environment=environment()):Promise<CheckoutIntent|undefined>{
  return env.lock(checkoutIntentKey(owner),async()=>{
    const intent=readCheckoutIntent(owner,env.storage);if(!intent||intent.order?.order_id!==order.order_id)return intent;
    const result=bind(intent,order);save(result,env.storage);return result;
  });
}
