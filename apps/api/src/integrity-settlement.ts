import {INTEGRITY_COMMERCIAL_RULE,integrityLockedScopeValid,int64,safeBillingNumber,type IntegrityInput,type IntegritySettlement} from '@bondbuddy/contracts';

/** Read the accepted contract and durable delivery/ledger facts; never reprice. */
export function integritySettlement(row:{operation:string;state:string;manifest:IntegrityInput;result?:unknown;reservation_state?:string;points?:unknown;charged_points?:unknown;released_points?:unknown}):IntegritySettlement|null{
 if(row.operation!=='check'||row.manifest.price_version!==INTEGRITY_COMMERCIAL_RULE.version||!['settled','released'].includes(row.reservation_state??''))return null;
 try{
  const quoted=int64(row.points),charged=int64(row.charged_points??0),released=int64(row.released_points);
  if(quoted!==int64(row.manifest.points)||charged+released!==quoted||(row.reservation_state==='settled')!==(charged>0n))return null;
  const amounts={quoted_points:safeBillingNumber(quoted),charged_points:safeBillingNumber(charged),released_points:safeBillingNumber(released)};
  if(['failed','cancelled','rejected'].includes(row.state))return charged===0n?{version:'integrity-settlement-v1',outcome:'not_delivered',...amounts,verified_query_pairs:[]}:null;
  const scope=row.manifest.scope_measurement,result=row.result as {measurement?:{verified_query_pairs?:unknown;verified_successful_pairs?:unknown}}|undefined;
  if(row.state!=='succeeded'||!scope||!integrityLockedScopeValid(row.manifest.draft,scope))return null;
  const stored=result?.measurement?.verified_query_pairs;
  if(!Array.isArray(stored)||stored.length===0||stored.length!==result?.measurement?.verified_successful_pairs||new Set(stored).size!==stored.length||charged===0n)return null;
  const verified=stored.map(value=>{
   if(typeof value!=='string')throw Error('Missing saved query identity');
   const pair:unknown=JSON.parse(value);
   if(!Array.isArray(pair)||pair.length!==2||pair.some(id=>typeof id!=='string'||!id)||!scope.executable_query_pairs.some(p=>p.subject_id===pair[0]&&p.site_id===pair[1]))throw Error('Saved query is outside the accepted scope');
   return {subject_id:pair[0] as string,site_id:pair[1] as string};
  });
  if(new Set(verified.map(pair=>JSON.stringify([pair.subject_id,pair.site_id]))).size!==verified.length)return null;
  return {version:'integrity-settlement-v1',outcome:'delivered',...amounts,verified_query_pairs:verified};
 }catch{return null;}
}
