import './commerce.css';
import type {CommercePriceMetadata,CommerceCatalog} from '@bondbuddy/contracts';
import {ApiClient,ApiError} from './api';
import {esc} from './ui';
import {cny,isCnyPrice,includedPrice,displayPrice,scopeStatus,scopeStatusLabel,type ScopeLifecycle} from './commerce-price';
export {cny,isCnyPrice,includedPrice,displayPrice,scopeStatus,scopeStatusLabel} from './commerce-price';

export function scopeReady(price:CommercePriceMetadata|undefined|null){return isCnyPrice(price)&&scopeStatus(price)==='ready';}
export function scopePending(price:CommercePriceMetadata|undefined|null){return isCnyPrice(price)&&!scopeReady(price);}
export function quotationHref(price:{scope_quote_id?:string}|undefined|null){return '#/account'+(price?.scope_quote_id?'?quotation='+encodeURIComponent(price.scope_quote_id):'');}
export function scopeLifecycleHtml(price:(ScopeLifecycle&{scope_quote_id?:string})|undefined|null){
  if(!price?.quote_status)return '';
  const status=scopeStatus(price),message=status==='ready'?price.amount_fen===0?'本次为原范围包含／已购覆盖，无需充值或新增预留。核对范围后可返回原工作继续。':'尚未开始、尚未扣费。核对报价后可返回原工作确认。':status==='pending_scope'?'本次范围报价待确认，尚未收费。准备材料与要求保留，可返回准备或稍后刷新同一范围报价。':status==='unavailable'?'当前范围暂无法承接，尚未收费。准备材料与要求保留，可查看原因、调整范围或退出本次报价。':status==='declined'?'已拒绝本报价，本次未开始、未扣费。准备材料与要求保留；如需继续，可重新申请范围报价。':'本报价已过期，不能开始，本次未扣费。准备材料与要求保留，请重新申请范围报价。';
  const expires=price.scope_expires_at??price.expires_at;
  return `<section class="commerce-quote-lifecycle" data-commerce-scope-state="${esc(status)}"><p role="status">${esc(message)}</p>${status==='ready'&&expires?`<p>报价有效至 ${esc(new Date(expires).toLocaleString('zh-CN'))}</p>`:''}${price.scope_quote_id?`<a class="text-button" href="${esc(quotationHref(price))}">${status==='ready'?'查看报价／拒价反馈':'查看报价状态与明细'}</a>`:''}</section>`;
}
/** Local expiry blocks a confirmation even while its dialog remains open. Server admission stays authoritative. */
export function guardScopeExpiry(dialog:HTMLDialogElement,prices:ScopeLifecycle[],selector:string){
  const expire=()=>{if(prices.some(price=>scopeStatus(price)==='expired')){dialog.querySelectorAll<HTMLButtonElement>(selector).forEach(button=>button.disabled=true);let status=dialog.querySelector<HTMLElement>('[data-commerce-expired]');if(!status){status=document.createElement('p');status.dataset.commerceExpired='';status.setAttribute('role','status');dialog.append(status);}status.textContent='报价已过期或不可执行，本次未开始、未扣费。准备内容保留，请返回重新核对报价。';}};
  const times=prices.map(p=>Date.parse(p.scope_expires_at??p.expires_at??'')).filter(Number.isFinite);
  const delay=times.length?Math.min(...times)-Date.now():undefined;
  const timer=delay===undefined?undefined:setTimeout(expire,Math.max(0,Math.min(delay+10,2147483647)));dialog.addEventListener('close',()=>clearTimeout(timer),{once:true});expire();
}
export function copyCommercePrice(price:CommercePriceMetadata):CommercePriceMetadata{const result:CommercePriceMetadata={};for(const key of ['pricing_mode','currency','amount_fen','unit_amount_fen','units','scope_quote_id','quote_status','scope_expires_at','scope_lines','price_version'] as const){if(price[key]!==undefined)(result as Record<string,unknown>)[key]=structuredClone(price[key]);}return result;}
export function scopeLinesHtml(price:CommercePriceMetadata|undefined|null){return price?.scope_lines?.length?`<section class="commerce-scope-lines" aria-label="本次范围报价明细"><h3>本次工作项</h3><ul>${price.scope_lines.map(line=>`<li><strong>${esc(line.label)}</strong>${line.pricing?`<span>原价 ${cny(line.pricing.base_amount_fen)} · 已购覆盖 ${cny(line.pricing.owned_coverage_fen)} · 本次应付 ${cny(line.pricing.due_fen)}</span><p>${esc(line.pricing.reason)}</p>`:`<span>${line.quantity.toLocaleString()} ${esc(line.unit)} × ${cny(line.unit_price_fen)} = ${cny(line.amount_fen)}</span>`}<ul>${line.evidence.map(evidence=>`<li>${esc(evidence)}</li>`).join('')}</ul></li>`).join('')}</ul></section>`:'';}
export function priceScope(price:CommercePriceMetadata|undefined|null){return includedPrice(price)?'本次属于原范围包含或已购覆盖，无需充值或新增预留；核对范围后继续处理。':isCnyPrice(price)?'确认本次范围与总价后预留，按约定交付结算；原范围澄清、平台纠错与重试包含。':'';}
/** A missing endpoint is an older deployment; a failed enabled endpoint is never assumed to be free. */
export async function readCommerce(api:ApiClient,signal?:AbortSignal):Promise<CommerceCatalog|undefined>{
  try{return await api.commerceCatalog(signal);}catch(error){if(error instanceof ApiError&&error.status===404)return undefined;throw error;}
}
export function catalogItem(catalog:CommerceCatalog|undefined,code:string){return catalog?.enabled?catalog.items.find(item=>item.code===code):undefined;}
export function commerceQuoteHtml(price:CommercePriceMetadata|undefined|null,points?:number){return `<strong>${esc(displayPrice(price,points))}</strong>${scopeLinesHtml(price)}${isCnyPrice(price)?`<p>${esc(priceScope(price))}</p>`:''}`;}
export function confirmCnyTask(title:string,price:CommercePriceMetadata,scope:string):Promise<boolean>{
  return new Promise(resolve=>{const ready=scopeReady(price),included=includedPrice(price),dialog=document.createElement('dialog');dialog.className='pf-modal commerce-confirm';dialog.dataset.commerceConfirm='true';dialog.innerHTML=`<h2>${esc(title)}</h2><p>${esc(scope)}</p>${ready?`<p>${included?'本次无需另付':'本次总价'} <strong>${esc(displayPrice(price))}</strong></p>${scopeLinesHtml(price)}<p>${esc(priceScope(price))}</p><p>${included?'本次沿用原单范围；真正新增目标须另行确认。':'开始后固定上述材料与范围。未交付部分释放；新事实或新范围须重新确认。'}</p>`:''}${scopeLifecycleHtml(price)}<div class="form-actions"><button class="btn secondary" data-commerce-back>${ready?'返回调整':'返回准备'}</button>${ready?`<button class="btn primary" data-commerce-accept>${included?'确认范围并继续':'确认总价并开始'}</button>`:''}</div>`;let settled=false;const finish=(accepted:boolean)=>{if(settled)return;settled=true;dialog.close();dialog.remove();resolve(accepted);};dialog.querySelector('[data-commerce-back]')!.addEventListener('click',()=>finish(false));dialog.querySelector('[data-commerce-accept]')?.addEventListener('click',()=>{if(scopeReady(price))finish(true);});dialog.querySelector('a')?.addEventListener('click',()=>finish(false));dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});document.body.append(dialog);guardScopeExpiry(dialog,[price],'[data-commerce-accept]');dialog.showModal();});
}
