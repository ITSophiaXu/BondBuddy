import {sha256} from './support.mjs';
import {normalizeAcceptedQuote} from './billing.mjs';

export const CASE_KINDS=Object.freeze({'update-rq-202509':'update','review-dongying':'review','qa-dongying':'qa','integrity-dongying':'integrity','workpaper-dongying':'workpaper'});
const quotePaths={update:/\/credit-quote$/,review:/\/review-executions\/quote$/,qa:/\/qa\/quote$/,integrity:/\/integrity\/quote$/,workpaper:/\/file-generation\/quote$/};
export function isQuotePath(id,url){return quotePaths[CASE_KINDS[id]]?.test(new URL(url).pathname)??false;}
export function retainSubmissionRequest(entry,{url,body,method='POST'},save=()=>{}){
 if(method!=='POST'||typeof body!=='string')throw Error('Missing actual task POST bytes');
 const parsed=JSON.parse(body),kind=CASE_KINDS[entry.id];
 const identity=['update','review'].includes(kind)?parsed.execution_request_id:parsed.request_id;
 if(typeof identity!=='string'||!identity)throw Error('Task request identity missing');
 const request={url,method,raw:body,sha256:sha256(body),identity,body:parsed};
 if(entry.submissionRequest){
  if(entry.submissionRequest.url!==url||entry.submissionRequest.sha256!==request.sha256){entry.submissionConflict={previous:entry.submissionRequest,received:request,at:new Date().toISOString()};save();throw Error('Task submission identity or bytes changed');}
  return entry.submissionRequest;
 }
 entry.submissionRequest={...request,observedAt:new Date().toISOString()};save();return entry.submissionRequest;
}
export function retainSubmissionReceipt(entry,{url,status,body},save=()=>{}){
 if(!entry.submissionRequest||entry.submissionRequest.url!==url)throw Error('Receipt has no matching persisted request');
 const receipt={url,status,body,observedAt:new Date().toISOString()};
 if(entry.submissionReceipt&&JSON.stringify(entry.submissionReceipt.body)!==JSON.stringify(body))throw Error('Conflicting task receipt');
 entry.submissionReceipt??=receipt;
 // Persist accepted execution IDs before optional evidence assertions. A later
 // validation error must never make resume issue a second paid request.
 if(status>=200&&status<300){
  if(body.run_id)entry.runId=body.run_id;
  if(body.batch_id)entry.packageBatchId=body.batch_id;
  if(body.workpapers?.batch_id)entry.workpaperBatchId=body.workpapers.batch_id;
 }
 save();
 if(status<200||status>=300)throw Error('Task submission refused: '+status);
 return body;
}
export function acceptedQuote(entry){
 const request=entry.submissionRequest?.body,response=entry.submissionReceipt?.body,kind=CASE_KINDS[entry.id];
 if(!request||!response)throw Error('Original submission evidence missing');
 const matches=[];
 for(const capture of entry.quoteCaptures??[]){
  try{const accepted=normalizeAcceptedQuote({kind,request,response,quoteResponse:capture.body});matches.push({accepted,capture});}catch{}
 }
 if(!matches.length)throw Error('No captured ready quote matches the accepted task');
 const distinct=new Set(matches.map(x=>JSON.stringify(x.accepted)));
 if(distinct.size!==1)throw Error('Ambiguous accepted quote');
 return {...matches[0].accepted,quoteResponse:matches[0].capture.body};
}
