import {INTEGRITY_SITES,integrityRecordPresentation} from './billing-types.js';
import type {IntegrityWorkItem} from './integrity-continuation.js';
import {esc} from './ui.js';
export const integrityReadingLabels={results:'发现记录，需审阅',incomplete:'查询受限或未完成',unqueried:'未执行 / 无记录',no_results:'本次无返回结果',not_applicable:'不适用'} as const;
export type IntegrityReadingGroup=keyof typeof integrityReadingLabels;
export type IntegrityReadingFilter=IntegrityReadingGroup|'all'|'pending';
/** Read-only grouping consumes the shared presentation contract; it never derives risk or changes original observations. */
export function integrityReadingGroup(item:IntegrityWorkItem):IntegrityReadingGroup{
 if(item.record)return integrityRecordPresentation(item.record).group;
 if(item.subject.kind==='person'&&INTEGRITY_SITES.find(site=>site.id===item.siteId)?.companyOnly)return 'not_applicable';
 return 'unqueried';
}
export function matchesIntegrityReading(item:IntegrityWorkItem,filter:string){return filter==='all'||filter==='pending'&&item.pending||integrityReadingGroup(item)===filter;}
export function integrityReadingCount(items:readonly IntegrityWorkItem[],group:IntegrityReadingGroup){return items.filter(item=>integrityReadingGroup(item)===group).length;}
export function integrityReadingSummary(items:readonly IntegrityWorkItem[],filter:string,done:boolean,error?:string){
 if(error)return '<section class="integrity-reading" aria-label="核查结果阅读概览"><h2>查询记录暂待核对</h2><p>当前记录未能完整核对，暂不统计为零项或无异常。</p></section>';
 return `<section class="integrity-reading" aria-label="核查结果阅读概览"><h2>先看哪些查询记录？</h2><p>按主体 × 网站统计。发现记录可能包含一般信息或其他主体命中，不等于确认风险；查询受限、未执行也不等于无异常。</p><div class="integrity-reading-counts">${Object.entries(integrityReadingLabels).map(([group,label])=>{const count=integrityReadingCount(items,group as IntegrityReadingGroup);return `<button type="button" data-reading-filter="${group}" aria-pressed="${filter===group}" ${count?'':'disabled'}><span>${group==='unqueried'&&!done?'尚未取得查询记录':label}</span><strong>${count}</strong><small>查看原记录 →</small></button>`;}).join('')}</div></section>`;
}
export function integrityReadingOptions(items:readonly IntegrityWorkItem[],filter:string,done:boolean){
 return [['all','全部',items.length],['pending','原查询待核实',items.filter(i=>i.pending).length],...Object.entries(integrityReadingLabels).map(([group,label])=>[group,group==='unqueried'&&!done?'尚未取得查询记录':label,integrityReadingCount(items,group as IntegrityReadingGroup)])].map(([value,label,count])=>`<option value="${value}" ${filter===value?'selected':''}>${esc(label)} ${count} 项</option>`).join('');
}
export function isIntegrityReadingFilter(value:string|null):value is IntegrityReadingFilter{return value==='all'||value==='pending'||!!value&&Object.hasOwn(integrityReadingLabels,value);}
