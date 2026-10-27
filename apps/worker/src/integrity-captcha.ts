import {createHash} from 'node:crypto';
import type {Page} from 'playwright';
import {creditChinaVerificationControls} from './integrity-browser-page.js';
import type {ModelImageInput} from './model-image-input.js';
import type {StageOutcome} from './run-pipeline.js';

export type IntegrityCaptchaRecognizer=(image:ModelImageInput)=>Promise<string|null>;
/** Model cancellation, reconciliation and storage failures must never become site observations. */
export class IntegrityCaptchaInterruption extends Error{
 constructor(readonly outcome:Exclude<StageOutcome,{kind:'done'}>){super('INTEGRITY_CAPTCHA_INTERRUPTED');}
}
export type IntegrityCaptchaSession={recognize?:IntegrityCaptchaRecognizer;attempts:number};
const hash=(png:Buffer)=>createHash('sha256').update(png).digest('hex');
export async function resolveCreditChinaCaptcha(page:Page,session:IntegrityCaptchaSession,signal:AbortSignal,waitMs:number):Promise<'absent'|'passed'|'blocked'>{
 let controls=await creditChinaVerificationControls(page);
 if(!controls)return 'absent';
 if(!session.recognize)return 'blocked';
 const refresh=async()=>{if(await controls!.refresh.count()===1)await controls!.refresh.click({timeout:2000,noWaitAfter:true});};
 while(session.attempts<2){
  signal.throwIfAborted();session.attempts++;
  if(/已失效|已过期/.test(await controls.error.innerText({timeout:100}).catch(()=>'')))await refresh();
  const readyUntil=Date.now()+Math.min(waitMs,5000);
  let loaded=false;
  while(Date.now()<readyUntil){
   signal.throwIfAborted();
   loaded=await controls.image.evaluate(e=>{const i=e as HTMLImageElement;return i.complete&&i.naturalWidth>0&&i.naturalWidth<=1024&&i.naturalHeight>0&&i.naturalHeight<=1024;}).catch(()=>false);
   if(loaded)break;await page.waitForTimeout(100);
  }
  if(!loaded)return 'blocked';
  const box=await controls.image.boundingBox();
  if(!box||box.width>1024||box.height>1024)return 'blocked';
  const src=await controls.image.getAttribute('src');
  const png=await controls.image.screenshot({type:'png',animations:'disabled',timeout:3000});
  if(src!==await controls.image.getAttribute('src'))continue;
  const sha256=hash(png);
  const code=await session.recognize({png,sha256});
  signal.throwIfAborted();
  controls=await creditChinaVerificationControls(page);
  if(!controls)return 'passed';
  // Both URL and visible pixels must still identify the image actually read by the model.
  if(src!==await controls.image.getAttribute('src')||sha256!==hash(await controls.image.screenshot({type:'png',animations:'disabled',timeout:3000})))continue;
  if(!code||!/^[a-zA-Z0-9]{4}$/.test(code)){if(session.attempts<2)await refresh();continue;}
  if(/已失效|已过期/.test(await controls.error.innerText({timeout:100}).catch(()=>''))){if(session.attempts<2)await refresh();continue;}
  await controls.input.fill(code,{timeout:2000});
  await controls.submit.click({timeout:2000,noWaitAfter:true});
  const acceptedUntil=Date.now()+Math.min(waitMs,5000);
  let rejected=false;
  while(Date.now()<acceptedUntil){
   signal.throwIfAborted();await page.waitForTimeout(100);
   controls=await creditChinaVerificationControls(page);
   if(!controls)return 'passed';
   if(src!==await controls.image.getAttribute('src')){rejected=true;break;}
   if(/错误|不正确|失败|已失效|已过期/.test(await controls.error.innerText({timeout:100}).catch(()=>''))){rejected=true;break;}
  }
  // A slow validation response is not a rejection: never send a duplicate request.
  if(!rejected)return 'blocked';
  if(session.attempts<2&&src===await controls!.image.getAttribute('src'))await refresh();
 }
 return 'blocked';
}
