import type {PoolClient} from 'pg';
import {PROJECT_FILE_UPDATE_PRICE,type ProjectFileOperation} from '@bondbuddy/contracts';
import {creditBalance,lockCreditAccount} from './billing.js';
import {Problem,uid} from './data.js';

export async function requireFileUpdateCredits(c:PoolClient,owner:string,points:number){
  await lockCreditAccount(c,owner);
  const balance=await creditBalance(c,owner);
  if(balance.available<points)throw new Problem(402,'CREDITS_INSUFFICIENT',
    `本次更新需要 ${points.toLocaleString('zh-CN')} 积分，当前可用 ${balance.available.toLocaleString('zh-CN')} 积分，请充值后更新；检查结果与原文件已保留。`);
}

/** Pin one file's price and reserve the shared wallet in the run-creation transaction.
 * The existing fixed-credit terminal trigger settles only after both Word files are available,
 * and releases the hold on failure/cancellation. Retries never reuse a settled reservation.
 */
export async function reserveFileUpdate(c:PoolClient,owner:string,run:any,input:Extract<ProjectFileOperation,{operation:'patch'}>){
  const points=PROJECT_FILE_UPDATE_PRICE.points;
  await requireFileUpdateCredits(c,owner,points);
  const quote=uid(),reservation=uid();
  await c.query(`INSERT INTO bb_project_file_update_quotes(id,owner_user_id,project_id,run_id,check_run_id,file_version_id,input_hash,points,price_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[quote,owner,run.project_id,run.id,input.check_run_id,input.file_version_id,run.input_hash,points,PROJECT_FILE_UPDATE_PRICE.version]);
  await c.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy)
    VALUES($1,$2,$3,$4,$5,'on_delivery')`,[reservation,owner,run.id,quote,points]);
  const lots=(await c.query(`SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen AND (expires_at IS NULL OR expires_at>now())
    ORDER BY CASE WHEN source='purchase' THEN 1 ELSE 0 END,expires_at ASC NULLS LAST,created_at,id FOR UPDATE`,[owner])).rows;
  let left:number=points;
  for(const lot of lots){
    const take=Math.min(left,Number(lot.remaining)-Number(lot.frozen));
    await c.query('UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1',[lot.id,take]);
    await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,$3)',[reservation,lot.id,take]);
    left-=take;if(!left)break;
  }
  if(left)throw new Problem(503,'DATA_UNAVAILABLE','File update credit allocation mismatch');
  await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
    VALUES($1,$2,$3,'reserve',$4,$5,$6,$2,'project_file_update_confirmed_4500')`,[uid(),owner,'reserve:'+reservation,points,reservation,run.id]);
  await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[run.id,reservation]);
  run.billing_mode='fixed_credits';run.reservation_id=reservation;
}
