import './commerce.css';
import type {CommercePriceMetadata,CommerceCatalog} from '@bondbuddy/contracts';
import {ApiClient,ApiError} from './api';
import {esc} from './ui';
import {cny,isCnyPrice,displayPrice} from './commerce-price';
export {cny,isCnyPrice,displayPrice} from './commerce-price';

export function scopeReady(price:CommercePriceMetadata|undefined|null){return isCnyPrice(price)&&price?.quote_status==='ready';}
export function scopePending(price:CommercePriceMetadata|undefined|null){return isCnyPrice(price)&&price?.quote_status!=='ready';}
export function copyCommercePrice(price:CommercePriceMetadata):CommercePriceMetadata{const result:CommercePriceMetadata={};for(const key of ['pricing_mode','currency','amount_fen','unit_amount_fen','units','scope_quote_id','quote_status','scope_lines'] as const){if(price[key]!==undefined)(result as Record<string,unknown>)[key]=structuredClone(price[key]);}return result;}
export function scopeLinesHtml(price:CommercePriceMetadata|undefined|null){return price?.scope_lines?.length?`<section class="commerce-scope-lines" aria-label="本次范围报价明细"><h3>本次工作项</h3><ul>${price.scope_lines.map(line=>`<li><strong>${esc(line.label)}</strong><span>${line.quantity.toLocaleString()} ${esc(line.unit)} × ${cny(line.unit_price_fen)} = ${cny(line.amount_fen)}</span><ul>${line.evidence.map(evidence=>`<li>${esc(evidence)}</li>`).join('')}</ul></li>`).join('')}</ul></section>`:'';}
export function priceScope(price:CommercePriceMetadata|undefined|null){return isCnyPrice(price)?'确认本次范围与总价后预留，按约定交付结算；原范围澄清、平台纠错与重试包含。':'';}
/** A missing endpoint is an older deployment; a failed enabled endpoint is never assumed to be free. */
export async function readCommerce(api:ApiClient,signal?:AbortSignal):Promise<CommerceCatalog|undefined>{
  try{return await api.commerceCatalog(signal);}catch(error){if(error instanceof ApiError&&error.status===404)return undefined;throw error;}
}
export function catalogItem(catalog:CommerceCatalog|undefined,code:string){return catalog?.enabled?catalog.items.find(item=>item.code===code):undefined;}
export function commerceQuoteHtml(price:CommercePriceMetadata|undefined|null,points?:number){return `<strong>${esc(displayPrice(price,points))}</strong>${scopeLinesHtml(price)}${isCnyPrice(price)?`<p>${esc(priceScope(price))}</p>`:''}`;}
export function confirmCnyTask(title:string,price:CommercePriceMetadata,scope:string):Promise<boolean>{
  return new Promise(resolve=>{const ready=scopeReady(price),dialog=document.createElement('dialog');dialog.className='pf-modal commerce-confirm';dialog.dataset.commerceConfirm='true';dialog.innerHTML=`<h2>${esc(title)}</h2><p>${esc(scope)}</p>${ready?`<p>本次总价 <strong>${esc(displayPrice(price))}</strong></p>${scopeLinesHtml(price)}<p>${esc(priceScope(price))}</p><p>开始后固定上述材料与范围。未交付部分释放；新事实或新范围须重新确认。</p>`:'<p role="status">本次范围报价待确认，尚未收费。材料和要求保留，刷新报价可读取同一范围的核实结果。</p>'}<div class="form-actions"><button class="btn secondary" data-commerce-back>${ready?'返回调整':'返回准备'}</button>${ready?'<button class="btn primary" data-commerce-accept>确认总价并开始</button>':''}</div>`;let settled=false;const finish=(accepted:boolean)=>{if(settled)return;settled=true;dialog.close();dialog.remove();resolve(accepted);};dialog.querySelector('[data-commerce-back]')!.addEventListener('click',()=>finish(false));dialog.querySelector('[data-commerce-accept]')?.addEventListener('click',()=>finish(true));dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});document.body.append(dialog);dialog.showModal();});
}
