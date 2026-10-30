import type {PoolClient} from 'pg';
import {uid} from './data.js';

/** Called in the transaction which first records an authenticated date. This
 * queues evidence checking only; the enabled adapter still controls downloads. */
export async function recheckAuthenticatedStatementDay(c:PoolClient,provider:'wechat'|'alipay',merchant:string,instant:string){
  // Invalidate an in-flight check's lease while retaining all earlier evidence.
  // A late callback can refer to a day outside the rolling seven-day recheck.
  await c.query(`INSERT INTO bb_payment_statement_jobs(id,provider,merchant_id,bill_date,kind,account_type,next_attempt_at)
    VALUES($1,$2,$3,($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,'trade','',
      GREATEST(now(),((($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date+1)+time '10:00') AT TIME ZONE 'Asia/Shanghai'))
    ON CONFLICT(provider,merchant_id,bill_date,kind,account_type) DO UPDATE SET
      state='pending',lease_token=NULL,lease_until=NULL,next_attempt_at=EXCLUDED.next_attempt_at,updated_at=now()`,
    [uid(),provider,merchant,instant]);
}
