import type {PoolClient} from 'pg';
import {OUTCOME_PRICE_VERSION,OUTCOME_PRICING_MODE,commerceMetadata} from '@bondbuddy/contracts';
import {Problem} from './data.js';

export const OUTCOME_MODE=OUTCOME_PRICING_MODE;
export const outcomeMetadata=commerceMetadata;

/** A separately tagged row prevents enabling this mode from changing legacy active prices. */
export async function outcomePriceVersion(c:PoolClient){
  const row=(await c.query('SELECT * FROM bb_credit_price_versions WHERE id=$1 AND pricing_mode=$2',[OUTCOME_PRICE_VERSION,OUTCOME_MODE])).rows[0];
  if(!row)throw new Problem(503,'BILLING_NOT_READY','人民币成果报价尚未启用所需迁移。');
  return row;
}
