import {randomUUID} from 'node:crypto';

export const sandboxOrderLifetimeMs=30*60*1000;
export const canReopenSandboxCheckout=(value,now=Date.now())=>!!value.order
  &&['pending','unknown'].includes(value.state)&&Date.parse(value.order.expires_at)-now>=60000;

// Serialize actions for one browser session: a delayed query or a double click
// must never replace a newer order or apply its result to a different order.
export async function withSandboxSession(value,action){
  const previous=value.action??Promise.resolve();
  let release;
  value.action=new Promise(resolve=>{release=resolve;});
  await previous;
  try{return await action();}finally{release();}
}

export async function prepareSandboxCheckout(value,{provider,observe,now=Date.now,replaceOrderId}){
  if(replaceOrderId!==undefined){
    // The form binds replacement to the displayed order. Replayed/stale forms
    // cannot replace an order that was created by another request.
    if(!value.order||replaceOrderId!==value.order.id)return false;
    await observe(value);
    if(value.state!=='expired'||value.receipt?.state!=='expired')return false;
    (value.history??=[]).push({order:value.order,receipt:value.receipt});
    delete value.order;delete value.receipt;delete value.refund;
  }else if(value.order){
    if(!canReopenSandboxCheckout(value,now())){
      if(['pending','unknown','expired'].includes(value.state))await observe(value);
      return false;
    }
    return true;
  }
  value.order={id:'bb_sandbox_'+randomUUID().replaceAll('-',''),merchant_id:provider.merchantId,
    currency:'CNY',amount_fen:1,expires_at:new Date(now()+sandboxOrderLifetimeMs).toISOString()};
  value.state='pending';
  return true;
}
