import type {Pool,PoolClient} from 'pg';
import {integrityScopeMeasurement,integrityRecordHasSuccessfulQuery,integritySearchQueries,type IntegrityRecord,type IntegrityInput,type IntegrityScopeMeasurement} from '@bondbuddy/contracts';
import {inputManifestHash} from './production-rule-pin.js';

/** Match the durable SQL predicate's raw official section scopes, without URL normalization. */
function queryScopeAllowed(pair:IntegrityScopeMeasurement['executable_query_pairs'][number],query:string):boolean{
 if(!query.includes(pair.subject_name))return false;
 return [...query.matchAll(/(?<![\p{L}\p{N}_])site:([^\s"']+)/giu)].some(match=>{
  const scope=match[1];if(/[@:]/.test(scope))return false;
  const host=scope.split(/[/?#]/,1)[0].toLowerCase(),slash=scope.indexOf('/'),path=slash<0?'/':scope.slice(slash).replace(/[?#].*$/,'');
  return pair.urls.some(url=>{
   if(host!==url.replace(/^https?:\/\//,'').split(/[/?#]/,1)[0].toLowerCase())return false;
   const section=url.replace(/^https?:\/\/[^/]+/,'');
   return pair.site_id==='local-csrc'?path.startsWith(section.replace(/index\.shtml$/,'')):pair.query_terms.length===0||section!=='/'&&path.startsWith(section)||pair.query_terms.some(term=>query.replace(/\s/g,'').includes(term.replace(/\s/g,'')));
  });
 });
}

/** Billing requires a successful saved query, not merely a submitted request or model assertion. */
export async function integrityVerifiedQueryPairs(db:Pool|PoolClient,owner:string,runId:string,records:IntegrityRecord[]):Promise<string[]>{
 const candidates=records.filter(integrityRecordHasSuccessfulQuery);if(!candidates.length)return [];
 const row=(await db.query('SELECT manifest FROM bb_integrity_runs WHERE owner_user_id=$1 AND run_id=$2',[owner,runId])).rows[0];
 if(!row)return [];const manifest=row.manifest as IntegrityInput,verified=new Set<string>(),locked=manifest.scope_measurement?.executable_query_pairs??integrityScopeMeasurement(manifest.draft).executable_query_pairs;
 let queries:string[]|undefined;
 for(const record of candidates){
  const subject=manifest.draft.subjects.find(s=>s.id===record.subject_id),pair=locked.find(pair=>pair.subject_id===record.subject_id&&pair.site_id===record.site_id);
  if(!subject||!pair)continue;
  if(record.browser){
   const batch=(await db.query('SELECT payload,sha256 FROM bb_integrity_browser_batches WHERE owner_user_id=$1 AND run_id=$2 AND subject_id=$3 AND site_id=$4',[owner,runId,subject.id,pair.site_id])).rows[0];
   if(!batch||inputManifestHash(batch.payload)!==batch.sha256.trim()||batch.payload.query!==record.query||batch.payload.search_performed!==true||batch.payload.outcome!==record.browser.outcome)continue;
   const captures=(await db.query('SELECT metadata FROM bb_integrity_browser_captures WHERE owner_user_id=$1 AND run_id=$2 AND subject_id=$3 AND site_id=$4',[owner,runId,subject.id,pair.site_id])).rows;
   if(record.browser.captures.some(c=>c.kind==='result'&&captures.some(saved=>inputManifestHash(saved.metadata)===inputManifestHash(c))&&batch.payload.captures.some((saved:{metadata:unknown})=>inputManifestHash(saved.metadata)===inputManifestHash(c))))verified.add(JSON.stringify([subject.id,pair.site_id]));
   continue;
  }
  if(!queries){
   const evidence=(await db.query('SELECT events,content_sha256 FROM bb_model_web_search_evidence WHERE owner_user_id=$1 AND run_id=$2',[owner,runId])).rows;
   queries=evidence.filter(e=>inputManifestHash(e.events)===e.content_sha256.trim()).flatMap(e=>integritySearchQueries(e.events));
  }
  const savedQueries=record.query.split('\n');
  if(queries.some(q=>savedQueries.includes(q)&&queryScopeAllowed(pair,q)))verified.add(JSON.stringify([subject.id,pair.site_id]));
 }
 return [...verified].sort();
}
export async function integrityQueryEvidenceReady(db:Pool|PoolClient,owner:string,runId:string,records:IntegrityRecord[]):Promise<boolean>{return (await integrityVerifiedQueryPairs(db,owner,runId,records)).length>0;}
