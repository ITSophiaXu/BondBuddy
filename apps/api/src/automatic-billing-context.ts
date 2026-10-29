import type {Pool,PoolClient} from 'pg';
const contexts=new WeakMap<object,boolean>();
export function configureAutomaticBilling(pool:Pool,enabled:boolean){contexts.set(pool,enabled);}
export function markAutomaticBillingClient(pool:Pool,client:PoolClient){contexts.set(client,automaticBillingEnabled(pool));}
export function clearAutomaticBillingClient(client:PoolClient){contexts.delete(client);}
export function automaticBillingEnabled(db:Pool|PoolClient){return contexts.get(db)??process.env.BB_SUBSCRIPTION_BILLING_ENABLED==='1';}
export async function withAutomaticBilling<T>(client:PoolClient,enabled:boolean,work:()=>Promise<T>):Promise<T>{
  const previous=contexts.get(client);contexts.set(client,enabled);
  try{return await work();}finally{if(previous===undefined)contexts.delete(client);else contexts.set(client,previous);}
}
