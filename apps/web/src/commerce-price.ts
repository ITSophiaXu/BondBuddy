import {isAutomaticPriceVersion} from '@bondbuddy/contracts';
import type {CommercePriceMetadata} from '@bondbuddy/contracts';

/** Price formatting stays independent of browser, CSS and API modules for receipts. */
export const cny=(fen:number)=>'¥'+(fen/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
export function isCnyPrice(price:CommercePriceMetadata|undefined|null){return price?.pricing_mode==='outcome_cny_v1'&&price.currency==='CNY'&&Number.isSafeInteger(price.amount_fen)&&price.amount_fen!>=0;}
export function isAutomaticCharge(price:(CommercePriceMetadata&{points?:number})|undefined|null){const amount=price?.amount_fen??price?.points;return isAutomaticPriceVersion(price?.price_version)&&price?.auto_charge!==false&&scopeStatus(price)==='ready'&&Number.isSafeInteger(amount)&&amount!>=0;}
export type ScopeLifecycle={quote_status?:string;amount_fen?:number;scope_expires_at?:string|null;expires_at?:string|null};
export function scopeStatus(price:ScopeLifecycle|undefined|null,now=Date.now()):string|undefined{
  if(price?.quote_status!=='ready')return price?.quote_status;
  const expires=price.scope_expires_at??price.expires_at;
  return expires&&(!Number.isFinite(Date.parse(expires))||Date.parse(expires)<=now)?'expired':'ready';
}
export function includedPrice(price:CommercePriceMetadata|undefined|null){return isCnyPrice(price)&&price?.quote_status==='ready'&&price.amount_fen===0;}
export function scopeStatusLabel(price:ScopeLifecycle|undefined|null){const status=scopeStatus(price);return status==='ready'&&price?.amount_fen===0?'原范围包含／已购覆盖':({pending_scope:'范围报价待确认',ready:'已报价',unavailable:'暂无法承接',declined:'已拒绝报价',expired:'报价已过期'} as Record<string,string>)[status??'']??'范围报价待确认';}
export function displayPrice(price:(CommercePriceMetadata&{points?:number})|undefined|null,points?:number){return isAutomaticPriceVersion(price?.price_version)&&(!price?.quote_status||price.quote_status==='ready')?((price!.amount_fen??price!.points??points)===0?'原范围包含／已购覆盖':(price!.amount_fen??price!.points??points??0).toLocaleString('zh-CN')+' 积分'):isCnyPrice(price)?price?.quote_status&&price.quote_status!=='ready'?scopeStatusLabel({...price,scope_expires_at:null,expires_at:null}):includedPrice(price)?'原范围包含／已购覆盖':cny(price!.amount_fen!):`${(points??0).toLocaleString('zh-CN')} 积分`;}

/** A points charge has no fixed cash value when subscription lots are consumed. */
export function displayCharge(price:(CommercePriceMetadata&{version?:string})|undefined|null,points:number){return isAutomaticPriceVersion(price?.price_version??price?.version)?points.toLocaleString('zh-CN')+' 积分':isCnyPrice(price)?cny(points):points.toLocaleString('zh-CN')+' 积分';}
