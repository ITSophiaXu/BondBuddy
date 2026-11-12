import {Type,type Static} from '@sinclair/typebox';
import {INTEGRITY_SITES,resolveIntegritySite,inferIntegrityRegion,type IntegritySite} from './integrity-sites.js';
import type {IntegrityDraft,IntegrityRecord,IntegrityInput,IntegritySubject} from './integrity.js';

export const INTEGRITY_SUBJECT_LIMIT=5;
export const INTEGRITY_COMMERCIAL_RULE={version:'bb-task-price-scope-20261111-v4',base_points:2000,pair_points:85,cap_points:22738,planned_cost_cny:null} as const;
export function integrityRoundPoints(successfulPairs:number):number{
 if(!Number.isSafeInteger(successfulPairs)||successfulPairs<0)throw new RangeError('Invalid integrity query count');
 return successfulPairs===0?0:Math.min(INTEGRITY_COMMERCIAL_RULE.cap_points,INTEGRITY_COMMERCIAL_RULE.base_points+INTEGRITY_COMMERCIAL_RULE.pair_points*successfulPairs);
}
const count=Type.Integer({minimum:0});
/** Observed scope units, never an assertion of a per-site tariff or planning cost. */
const queryPair=Type.Object({subject_id:Type.String(),subject_name:Type.String(),site_id:Type.String(),urls:Type.Array(Type.String()),query_terms:Type.Array(Type.String())},{additionalProperties:false});
export const IntegrityScopeMeasurementSchema=Type.Object({version:Type.Literal('integrity-scope-measurement-v1'),subjects:count,selected_sites:count,selected_pairs:count,applicable_pairs:count,executable_pairs:count,excluded_pairs:count,unresolved_pairs:count,executable_query_pairs:Type.Array(queryPair,{maxItems:5000})},{additionalProperties:false});
export type IntegrityScopeMeasurement=Static<typeof IntegrityScopeMeasurementSchema>;
export function integrityScopeMeasurement(draft:IntegrityDraft):IntegrityScopeMeasurement{
 let applicable=0,executable=0,excluded=0,unresolved=0;const pairs:IntegrityScopeMeasurement['executable_query_pairs']=[],subjects=[...new Map(draft.subjects.map(subject=>[subject.id,subject])).values()],sites=[...new Set(draft.site_ids)];
 for(const saved of subjects)for(const id of sites){
  const subject={...saved,...inferIntegrityRegion(saved)};
  const found=INTEGRITY_SITES.find(site=>site.id===id);
  if(found&&subject.kind==='person'&&found.companyOnly){excluded++;continue;}
  applicable++;
  const site=found&&resolveIntegritySite(found,subject);
  if(site?.links.length){executable++;pairs.push({subject_id:subject.id,subject_name:subject.name,site_id:site.id,urls:site.links.map(link=>link.url),query_terms:site.queryTerms??[]});}else unresolved++;
 }
 return {version:'integrity-scope-measurement-v1',subjects:subjects.length,selected_sites:sites.length,selected_pairs:subjects.length*sites.length,applicable_pairs:applicable,executable_pairs:executable,excluded_pairs:excluded,unresolved_pairs:unresolved,executable_query_pairs:pairs};
}
/** The optional ID distinguishes a deliberate new round; absence preserves accepted historical scopes. */
export function integrityPricingScope(draft:IntegrityDraft,roundId?:string,measurement?:IntegrityScopeMeasurement){return {draft,...(roundId?{round_id:roundId}:{}),...(measurement?{scope_measurement:measurement}:{})};}
/** Validate an accepted immutable scope without consulting today's website catalogue. */
export function integrityLockedScopeValid(draft:IntegrityDraft,scope:IntegrityScopeMeasurement):boolean{
 const pairs=scope.executable_query_pairs,identities=new Set(pairs.map(p=>JSON.stringify([p.subject_id,p.site_id])));
 return scope.subjects===draft.subjects.length&&scope.selected_sites===draft.site_ids.length&&scope.selected_pairs===draft.subjects.length*draft.site_ids.length
  &&scope.applicable_pairs===scope.executable_pairs+scope.unresolved_pairs&&scope.selected_pairs===scope.applicable_pairs+scope.excluded_pairs
  &&scope.executable_pairs===pairs.length&&identities.size===pairs.length&&pairs.every(pair=>pair.urls.length>0&&draft.site_ids.includes(pair.site_id)&&draft.subjects.some(subject=>subject.id===pair.subject_id&&subject.name===pair.subject_name));
}
export function integrityInputSite(input:IntegrityInput,siteId:string,subject:IntegritySubject):IntegritySite{
 const base=INTEGRITY_SITES.find(site=>site.id===siteId)??{id:siteId,name:siteId,group:'锁定核查范围',topic:'已接受的诚信核查范围',links:[]};
 const locked=input.scope_measurement?.executable_query_pairs;
 if(!locked)return resolveIntegritySite(base,subject);
 const pair=locked.find(pair=>pair.subject_id===subject.id&&pair.site_id===siteId);
 return pair?{...base,companyOnly:false,queryTerms:pair.query_terms,links:pair.urls.map(url=>({url,label:'本轮锁定官网'}))}:{...base,companyOnly:subject.kind==='person',links:[]};
}

export function integrityRecordHasSuccessfulQuery(record:IntegrityRecord):boolean{
 if(record.search_performed!==true||!record.query.trim()||record.status==='not_applicable'||record.status==='query_failed')return false;
 if(record.browser===undefined)return ['public_matches','no_public_results','needs_manual'].includes(record.status);
 if(!record.browser)return false;
 return ['results','no_results'].includes(record.browser.outcome)
  &&['public_matches','no_public_results'].includes(record.status)
  &&record.browser.captures.some(capture=>capture.kind==='result')
  &&(record.browser.diagnostic===undefined||record.browser.diagnostic!==null&&['results','no_results'].includes(record.browser.diagnostic.code));
}
export function integrityHasSuccessfulQuery(records:IntegrityRecord[]):boolean{return records.some(integrityRecordHasSuccessfulQuery);}

/** Durable journals use UTC ISO timestamps; validate calendar dates without Date.parse normalization. */
export function integrityObservedTimeValid(value:unknown):value is string{
 if(typeof value!=='string')return false;
 const match=/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,6})?Z$/.exec(value);
 if(!match||match[0].length!==value.length)return false;
 const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number),leap=year%4===0&&(year%100!==0||year%400===0);
 return year>=1&&month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]&&hour<=23&&minute<=59&&second<=59;
}

export function integritySearchQueries(events:unknown):string[]{
 if(!Array.isArray(events))return [];
 return events.flatMap(event=>{
  if(!event||typeof event!=='object')return [];
  const {item,observed_at}=event as {item?:Record<string,unknown>;observed_at?:unknown};
  if(!item||item.type!=='web_search'||typeof item.id!=='string'||item.id.length===0||!integrityObservedTimeValid(observed_at)
   ||item.status!==undefined&&item.status!=='completed')return [];
  const action=item.action as Record<string,unknown>|undefined;
  if(!action||action.type!==undefined&&action.type!=='search')return [];
  return [action.query,...(Array.isArray(action.queries)?action.queries:[])].filter((q):q is string=>typeof q==='string'&&!!q.trim());
 });
}

/** Measured delivery facts. A missing model cost remains unknown, never zero. */
export function integrityQueryMeasurement(records:IntegrityRecord[]){
 return {version:'integrity-query-measurement-v1',records:records.length,successful_queries:records.filter(integrityRecordHasSuccessfulQuery).length,
  failed_queries:records.filter(r=>r.status==='query_failed'||!!r.browser&&!integrityRecordHasSuccessfulQuery(r)).length,
  not_applicable:records.filter(r=>r.status==='not_applicable').length,captured_pages:records.reduce((n,r)=>n+(r.browser?.captures.length??0),0),
  outcomes:Object.fromEntries(['public_matches','no_public_results','needs_manual','not_applicable','query_failed'].map(status=>[status,records.filter(r=>r.status===status).length]))};
}
