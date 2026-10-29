import type {Pool,PoolClient} from 'pg';
import {isAutomaticPriceVersion,type AutomaticPriceVersion} from '@bondbuddy/contracts';
import {currentAutomaticPriceVersion,loadAutomaticTaskTariff} from './automatic-tariff-repository.js';
import {pinnedAutomaticPriceVersion} from './automatic-billing-context.js';
import {Problem} from './data.js';

/** Resolve a server-owned contract before calculating points. Credit-lot expiry is not a tariff-protection period. */
export async function resolveAutomaticTaskPriceVersion(db:Pool|PoolClient,owner:string):Promise<AutomaticPriceVersion>{
  const {resolveActiveSubscriptionPrice}=await import('./subscriptions.js');
  const version=pinnedAutomaticPriceVersion(db)??await resolveActiveSubscriptionPrice(db,owner)??await currentAutomaticPriceVersion(db);
  if(!isAutomaticPriceVersion(version))throw new Problem(503,'BILLING_NOT_READY','本订阅周期的计费版本尚未加载，暂不执行。');
  await loadAutomaticTaskTariff(db,version);
  return version;
}
