import type {CommercePriceMetadata} from '@bondbuddy/contracts';

/** Price formatting stays independent of browser, CSS and API modules for receipts. */
export const cny=(fen:number)=>'¥'+(fen/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
export function isCnyPrice(price:CommercePriceMetadata|undefined|null){return price?.pricing_mode==='outcome_cny_v1'&&price.currency==='CNY'&&Number.isSafeInteger(price.amount_fen)&&price.amount_fen!>=0;}
export function displayPrice(price:CommercePriceMetadata|undefined|null,points?:number){return isCnyPrice(price)?price?.quote_status==='pending_scope'?'范围报价待确认':cny(price!.amount_fen!):`${(points??0).toLocaleString('zh-CN')} 积分`;}
