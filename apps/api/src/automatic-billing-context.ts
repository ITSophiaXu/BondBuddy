import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool,PoolClient} from 'pg';
import type {AutomaticPriceVersion} from '@bondbuddy/contracts';
const poolContexts=new WeakMap<object,boolean>();
const contexts=new WeakMap<object,boolean>();
const priceContexts=new WeakMap<object,AutomaticPriceVersion>();
const requests=new AsyncLocalStorage<boolean>();
export function configureAutomaticBilling(pool:Pool,enabled:boolean){poolContexts.set(pool,enabled);}
/** API instances sharing a Pool retain their own mode across asynchronous requests. */
export function withAutomaticBillingRequest<T>(enabled:boolean,work:()=>T):T{return requests.run(enabled,work);}
export function markAutomaticBillingClient(pool:Pool,client:PoolClient){contexts.set(client,automaticBillingEnabled(pool));}
export function clearAutomaticBillingClient(client:PoolClient){contexts.delete(client);priceContexts.delete(client);}
// A transaction/accepted contract can explicitly pin a client. Otherwise the
// current API request wins over the Pool default used by standalone workers.
export function automaticBillingEnabled(db:Pool|PoolClient){return contexts.get(db)??requests.getStore()??poolContexts.get(db)??
  (process.env.NODE_TEST_CONTEXT?process.env.BB_SUBSCRIPTION_BILLING_ENABLED==='1':true);}
export function pinnedAutomaticPriceVersion(db:Pool|PoolClient){return priceContexts.get(db);}
/** A stored batch contract may pin a tariff after the subscription month has ended. Never accept this pin from a browser. */
export async function withAutomaticBilling<T>(client:PoolClient,enabled:boolean,work:()=>Promise<T>,priceVersion?:AutomaticPriceVersion):Promise<T>{
  const previous=contexts.get(client),previousPrice=priceContexts.get(client);contexts.set(client,enabled);
  if(priceVersion)priceContexts.set(client,priceVersion);else priceContexts.delete(client);
  try{return await work();}finally{
    if(previous===undefined)contexts.delete(client);else contexts.set(client,previous);
    if(previousPrice===undefined)priceContexts.delete(client);else priceContexts.set(client,previousPrice);
  }
}
