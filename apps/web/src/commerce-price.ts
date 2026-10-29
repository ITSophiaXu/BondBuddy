import {isAutomaticPriceVersion,int64,formatFen,formatPoints} from '@bondbuddy/contracts';
import type {CommercePriceMetadata} from './billing-types.js';
export type DisplayInteger=string|number|bigint;
type PriceView=Omit<CommercePriceMetadata,'amount_fen'|'unit_amount_fen'|'units'|'scope_lines'>&{amount_fen?:DisplayInteger;unit_amount_fen?:DisplayInteger;units?:DisplayInteger;points?:DisplayInteger;version?:string;scope_lines?:unknown[]};
const valid=(value:unknown)=>{try{int64(value);return true;}catch{return false;}};
/** Formatting is exact, including balances above Number.MAX_SAFE_INTEGER. */
export const cny=(fen:DisplayInteger)=>formatFen(fen);
export function isCnyPrice(price:PriceView|undefined|null){return price?.pricing_mode==='outcome_cny_v1'&&price.currency==='CNY'&&valid(price.amount_fen);}
export function isAutomaticCharge(price:PriceView|undefined|null){return isAutomaticPriceVersion(price?.price_version)&&price?.auto_charge!==false&&scopeStatus(price)==='ready'&&valid(price?.amount_fen??price?.points);}
export type ScopeLifecycle={quote_status?:string;amount_fen?:DisplayInteger;scope_expires_at?:string|null;expires_at?:string|null};
export function scopeStatus(price:ScopeLifecycle|undefined|null,now=Date.now()):string|undefined{
 if(price?.quote_status!=='ready')return price?.quote_status;
 const expires=price.scope_expires_at??price.expires_at;return expires&&(!Number.isFinite(Date.parse(expires))||Date.parse(expires)<=now)?'expired':'ready';
}
export function includedPrice(price:PriceView|undefined|null){return isCnyPrice(price)&&price?.quote_status==='ready'&&int64(price.amount_fen)===0n;}
export function scopeStatusLabel(price:ScopeLifecycle|undefined|null){const status=scopeStatus(price);return status==='ready'&&price?.amount_fen!==undefined&&int64(price.amount_fen)===0n?'原范围包含／已购覆盖':({pending_scope:'范围报价待确认',ready:'已报价',unavailable:'暂无法承接',declined:'已拒绝报价',expired:'报价已过期'} as Record<string,string>)[status??'']??'范围报价待确认';}
export function displayPrice(price:PriceView|undefined|null,points?:DisplayInteger){
 if(isAutomaticPriceVersion(price?.price_version)&&(!price?.quote_status||price.quote_status==='ready')){const amount=price?.amount_fen??price?.points??points??'0';return int64(amount)===0n?'原范围包含／已购覆盖':formatPoints(amount)+' 积分';}
 return isCnyPrice(price)?price?.quote_status&&price.quote_status!=='ready'?scopeStatusLabel({...price,scope_expires_at:null,expires_at:null}):includedPrice(price)?'原范围包含／已购覆盖':cny(price!.amount_fen!):formatPoints(points??'0')+' 积分';
}
/** Subscription points do not have a fixed cash value. */
export function displayCharge(price:PriceView|undefined|null,points:DisplayInteger){return isAutomaticPriceVersion(price?.price_version??price?.version)?formatPoints(points)+' 积分':isCnyPrice(price)?cny(points):formatPoints(points)+' 积分';}
