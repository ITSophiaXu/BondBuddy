import type {Pool,PoolClient} from 'pg';
import {AUTOMATIC_PRICE_VERSION,LEGACY_AUTOMATIC_PRICE_VERSION,AUTOMATIC_TASK_TARIFF,automaticTaskTariff,isAutomaticPriceVersion,safeBillingNumber,
  type AutomaticPriceVersion,type AutomaticTaskTariff,type AutomaticTaskSku} from '@bondbuddy/contracts';
import {Problem} from './data.js';
type Db=Pool|PoolClient;
const unavailable=()=>new Problem(503,'BILLING_NOT_READY','任务价格版本未发布或不可用，请稍后重试。');
export async function currentAutomaticPriceVersion(db:Db):Promise<AutomaticPriceVersion>{
  const row=(await db.query(`SELECT p.id FROM bb_credit_price_versions p LEFT JOIN bb_billing_price_drafts d ON d.id=p.id
    WHERE p.pricing_mode='outcome_cny_v1' AND p.effective_at<=now()
      AND (p.id=ANY($1::text[]) OR d.state='PUBLISHED') ORDER BY p.effective_at DESC,p.id DESC LIMIT 1`,[[LEGACY_AUTOMATIC_PRICE_VERSION,AUTOMATIC_PRICE_VERSION]])).rows[0];
  if(!row||!isAutomaticPriceVersion(row.id))throw unavailable();return row.id;
}
/** The persisted tariff survives process restarts; old contracts may load an older published version. */
export async function loadAutomaticTaskTariff(db:Db,version:AutomaticPriceVersion):Promise<AutomaticTaskTariff>{
  const row=(await db.query(`SELECT p.id,d.rows,d.state FROM bb_credit_price_versions p LEFT JOIN bb_billing_price_drafts d ON d.id=p.id
    WHERE p.id=$1 AND p.pricing_mode='outcome_cny_v1' AND p.effective_at<=now()`,[version])).rows[0];
  if(!row)throw unavailable();
  if(version===AUTOMATIC_PRICE_VERSION||version===LEGACY_AUTOMATIC_PRICE_VERSION)return automaticTaskTariff(version);
  if(!isAutomaticPriceVersion(version)||row.state!=='PUBLISHED'||!Array.isArray(row.rows)||row.rows.length!==12)throw unavailable();
  const tariff={} as AutomaticTaskTariff;
  for(const item of row.rows){
    if(!(item.sku in AUTOMATIC_TASK_TARIFF)||item.sku in tariff||!/^[1-9][0-9]*$/.test(item.points)||!/^[1-9][0-9]*$/.test(item.base_price_fen))throw unavailable();
    let points:number,base:number;try{points=safeBillingNumber(item.points,100000000);base=safeBillingNumber(item.base_price_fen);}catch{throw unavailable();}
    // Explicit bridge to the existing numeric task DTO; management/ledger amounts remain decimal strings.
    if(!Number.isSafeInteger(points)||!Number.isSafeInteger(base)||points>100000000)throw unavailable();
    const key=item.sku as AutomaticTaskSku;tariff[key]={...AUTOMATIC_TASK_TARIFF[key],points,base_fen:base};
  }
  return tariff;
}
