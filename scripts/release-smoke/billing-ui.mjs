import {expect} from '@playwright/test';

export async function readBillingPage({page,entry,snapshot}){
  await page.goto('/#/account');await expect(page.locator('#account-balance-title')).toHaveText('可用积分');
  const digits=async locator=>(await locator.innerText()).replace(/[^0-9]/g,'');
  await expect.poll(()=>digits(page.locator('.account-balance-value'))).toBe(snapshot.http.balance.available);
  await expect.poll(()=>digits(page.locator('.account-balance-total'))).toBe((BigInt(snapshot.http.balance.available)+BigInt(snapshot.http.balance.frozen)).toString());
  if(snapshot.http.balance.frozen==='0')await expect(page.locator('[data-task-held]')).toHaveCount(0);
  else await expect.poll(()=>digits(page.locator('[data-task-held] strong'))).toBe(snapshot.http.balance.frozen);
  await expect(page.locator('#credit-history-panel')).toHaveAttribute('aria-busy','false');
  const records=[];
  for(const reservation of entry.billingEvidence?.reservations??[]){
   const row=page.locator('.credit-history-row[data-record="'+reservation.reservationId+'"]');
   for(let n=0;!(await row.count())&&n<100;n++){
    const more=page.locator('[data-history-more]');if(!(await more.isVisible()))break;await more.click();await expect(page.locator('#credit-history-panel')).toHaveAttribute('aria-busy','false');
   }
   await expect(row).toBeVisible();const expected=snapshot.http.history.find(h=>h.reservation_id===reservation.reservationId);
   if(!expected)throw Error('Visible billing record missing from stable HTTP snapshot');
   await expect.poll(()=>digits(row.locator('.credit-history-amount > strong'))).toBe(expected.charged_points);
   if(BigInt(expected.released_points)>0n)await expect(row.locator('.credit-history-amount')).toContainText('已释放 '+BigInt(expected.released_points).toLocaleString('zh-CN'));
   if(BigInt(expected.corrected_points)>0n)await expect(row.locator('.credit-history-amount')).toContainText('已冲正返还 '+BigInt(expected.corrected_points).toLocaleString('zh-CN'));
   records.push({reservationId:reservation.reservationId,runId:expected.run_id,text:await row.innerText()});
  }
  return {status:'passed',observedAt:new Date().toISOString(),available:snapshot.http.balance.available,frozen:snapshot.http.balance.frozen,records};
 }
