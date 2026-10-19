import { MARKET_LABELS, MARKET_OFFERINGS, OFFERING_LABELS, type Market, type Offering } from '@bondbuddy/contracts';
import type { Dto } from './api';
import { QUARTER_ENDS, cutoffSelection, quarterCutoff } from './reporting-cutoff';
import { blankDraft, generatedProjectName } from './form-model';
import { esc } from './ui';

export type ReviewProjectFields=Pick<Dto<'ProjectResponse'>,'name'|'issuer_name'|'market'|'offering'|'update_details'>;
export function reviewProjectFields(value:ReviewProjectFields,autoName=false){
  const period=cutoffSelection(value.update_details?.reporting_cutoff??null);
  const option=(key:string,label:string,selected:unknown)=>`<option value="${esc(key)}"${key===selected?' selected':''}>${esc(label)}</option>`;
  return `<div class="review-form-row"><div><label for="issuer">发行人全称</label><input id="issuer" name="issuer"${autoName?' required':''} maxlength="200" value="${esc(value.issuer_name??'')}" placeholder="填写待复核募集书的发行人" aria-describedby="review-issuer-note"><p id="review-issuer-note" class="review-field-note">填写法定全称，用于识别本次复核主体。</p></div>${autoName?`<div><label for="generated-review-name">项目名称 <span class="optional">自动生成</span></label><output id="generated-review-name" for="issuer market offering" aria-live="polite" aria-describedby="review-name-note">${esc(generatedProjectName(value.issuer_name,value.market,value.offering,'review'))||'填写发行人后自动生成'}</output><p id="review-name-note" class="review-field-note">无需填写，创建后可在项目信息中修改。</p></div>`:`<div><label for="name">项目名称</label><input id="name" name="name" required maxlength="160" value="${esc(value.name)}"></div>`}<div><label for="market">发行市场</label><select id="market" name="market"><option value="">请选择</option>${Object.entries(MARKET_LABELS).map(([key,label])=>option(key,label,value.market)).join('')}</select></div><div><label for="offering">品种</label><select id="offering" name="offering"${value.market?'':' disabled'}><option value="">${value.market?'请选择':'请先选择发行市场'}</option>${(value.market?MARKET_OFFERINGS[value.market]:[]).map(key=>option(key,OFFERING_LABELS[key],value.offering)).join('')}</select></div></div><div class="review-period"><label for="reporting-year">最新报告期</label><div class="period-row"><select id="reporting-year" name="reporting_year" aria-label="最新报告期年份">${period.years.map(year=>option(year,`${year} 年`,period.year)).join('')}</select><div class="quarter-grid">${QUARTER_ENDS.map(([q,label])=>`<label class="quarter"><input type="radio" name="reporting_quarter" value="${q}"${period.quarter===q?' checked':''}>${label}</label>`).join('')}</div></div>${period.legacy?`<p class="review-muted" id="legacy-cutoff">已保存报告期：${esc(value.update_details?.reporting_cutoff)}；选择期末后更新。</p>`:''}</div>`;
}
export function bindReviewProjectFields(form:HTMLFormElement,changed?:(value:ReviewProjectFields)=>void,initial?:ReviewProjectFields){
  const market=form.querySelector<HTMLSelectElement>('#market')!,offering=form.querySelector<HTMLSelectElement>('#offering')!;
  // Editing the compact review form must retain earlier project details that it does not display.
  const details=structuredClone(initial?.update_details??blankDraft().update_details!);
  let periodChanged=false;
  const preview=form.querySelector<HTMLOutputElement>('#generated-review-name');
  const read=()=>{const data=new FormData(form),issuer=String(data.get('issuer')??'').trim()||null;return {name:preview?generatedProjectName(issuer,market.value as Market||null,offering.value as Offering||null,'review'):String(data.get('name')??'').trim(),issuer_name:issuer,market:market.value as Market||null,offering:offering.value as Offering||null,kind:'review' as const,update_details:{...details,reporting_cutoff:periodChanged?quarterCutoff(String(data.get('reporting_year')),String(data.get('reporting_quarter'))):details.reporting_cutoff}};};
  const notify=()=>{const {kind,...fields}=read();if(preview)preview.textContent=fields.name||'填写发行人后自动生成';changed?.(fields);};
  market.addEventListener('change',()=>{const options=market.value?MARKET_OFFERINGS[market.value as Market]:[];offering.disabled=!market.value;offering.innerHTML='<option value="">请选择</option>'+options.map(value=>`<option value="${value}">${OFFERING_LABELS[value]}</option>`).join('');});
  form.addEventListener('input',event=>{const target=event.target as HTMLInputElement;if(target.name==='reporting_year'||target.name==='reporting_quarter'){periodChanged=true;form.querySelector('#legacy-cutoff')?.remove();}if(target instanceof HTMLInputElement)notify();});
  form.addEventListener('change',event=>{if((event.target as HTMLSelectElement).name==='reporting_year')periodChanged=true;notify();});
  return read;
}
