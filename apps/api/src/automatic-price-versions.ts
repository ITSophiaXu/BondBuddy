import type {Pool,PoolClient} from 'pg';
import {AUTOMATIC_PRICE_VERSION,isAutomaticPriceVersion,type AutomaticPriceVersion} from '@bondbuddy/contracts';
import {pinnedAutomaticPriceVersion} from './automatic-billing-context.js';
import {Problem} from './data.js';

/** Resolve a server-owned contract before calculating points. Credit-lot expiry is not a tariff-protection period. */
export async function resolveAutomaticTaskPriceVersion(db:Pool|PoolClient,owner:string):Promise<AutomaticPriceVersion>{
  const {resolveActiveSubscriptionPrice}=await import('./subscriptions.js');
  const version=pinnedAutomaticPriceVersion(db)??await resolveActiveSubscriptionPrice(db,owner)??AUTOMATIC_PRICE_VERSION;
  if(!isAutomaticPriceVersion(version))throw new Problem(503,'BILLING_NOT_READY','本订阅周期的计费版本尚未加载，暂不执行。');
  const row=(await db.query("SELECT id FROM bb_credit_price_versions WHERE id=$1 AND pricing_mode='outcome_cny_v1' AND effective_at<=now()",[version])).rows[0];
  if(!row)throw new Problem(503,'BILLING_NOT_READY','本次任务所需的计费版本尚未生效，请稍后重试。');
  return version;
}
