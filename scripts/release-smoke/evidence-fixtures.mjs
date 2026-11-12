// Synthetic report data for verifier tests only. Never a release receipt.
import {FLOW_DOWNLOADS,REQUIRED_RELEASE_CASES} from './evidence-schema.mjs';
import {validateModelEvidence} from './model-quality-evidence.mjs';
export const SYNTHETIC_INSPECTOR_SOURCE='// Synthetic inspector source; never executes a check.\n';
const ownerId='synthetic-release-owner';
function modelFixture(kind,reservations,stamp){
 const runs=reservations.map(r=>({id:r.runId,owner_user_id:ownerId,state:'succeeded',qa_operation:null,preparation_id:null}));
 const jobs=runs.map(r=>({id:r.id+'-job',run_id:r.id,owner_user_id:ownerId}));
 const attempts=kind==='integrity'?[]:jobs.map(j=>({id:j.id+'-attempt',owner_user_id:ownerId,job_id:j.id,run_id:j.run_id,attempt_no:1,logical_call_id:j.id+'-logical',call_status:'succeeded',
  model_id:'synthetic-model',model_provider:'synthetic-provider',usage_present:true,usage_status:'measured',input_tokens:'10',output_tokens:'5',cached_input_tokens:'0',reasoning_tokens:'0',conflicting_measurements:false,
  runtime_id:j.id+'-runtime',runtime_run_id:j.run_id,runtime_job_id:j.id,adapter:'synthetic',model_config_version:'synthetic-v1',duration_ms:1,started_at:stamp,created_at:stamp,finish_reason:'stop',error_code:null}));
 const raw={owner_id:ownerId,captured_at:stamp,transaction_read_only:'on',transaction_isolation:'repeatable read',scope_run_ids:runs.map(r=>r.id),runs,jobs,attempts,
  workpaper_batch:kind==='workpaper'?{id:'batch',owner_user_id:ownerId}:null,
  workpaper_attempts:kind==='workpaper'?runs.map((r,i)=>({run_id:r.id,item_id:'item-'+i,attempt:1})):[]};
 return validateModelEvidence(raw,{ownerId,runIds:kind==='workpaper'?[]:[runs[0].id],workpaperBatchId:kind==='workpaper'?'batch':null});
}
export function fiveFlowFixture(expected,stamp,images){
 const body={status:'passed',failureCodes:[],checks:Object.fromEntries(['zip_structure','entry_integrity','xml_well_formedness','ooxml_relationships','word_document'].map(k=>[k,'passed'])),bodyCharacters:100,fileParts:3,xmlParts:3};
 const cases=REQUIRED_RELEASE_CASES.map(id=>{
  const kind=id.split('-')[0],workpaper=kind==='workpaper',runId=id+'-run',points=workpaper?'5000':'1000';
  const accepted={kind,requestId:id+'-request',quoteId:id+'-quote',points,priceVersion:'synthetic-price-v1',scopeQuoteId:null,runId:workpaper?null:runId,packageBatchId:workpaper?'package':null,workpaperBatchId:workpaper?'batch':null};
  const quote={quote_id:accepted.quoteId,points,price_version:accepted.priceVersion,scope_quote_id:null};
  const expectedWorkpapers=workpaper?Array.from({length:5},(_,i)=>({entryId:'item-'+i,cataloguePath:'1 尽职调查文件/'+i,disposition:i<3?'generated':'explanation',decisionStatus:i<3?'generate':'missing_information',archivePath:`${i<3?'可生成文件':'不适用说明'}/${i}.docx`,sha256:'c'.repeat(64)})):undefined;
  const reservations=Array.from({length:workpaper?5:1},(_,i)=>({runId:workpaper?'workpaper-run-'+i:runId,reservationId:id+'-reservation-'+i,quoteId:workpaper?id+'-quote-'+i:accepted.quoteId,priceVersion:accepted.priceVersion,reserved:'1000',charged:'1000',released:'0',corrected:'0',net:'1000'}));
  const downloads=FLOW_DOWNLOADS[id].flatMap(role=>[1,2].map(n=>({role,path:`/synthetic/${id}/download-${n}/${role}`,sha256:'d'.repeat(64),bytes:1200})));
  const billingPage={status:'passed',available:'100000',frozen:'0',observedAt:stamp,records:reservations.map(row=>({reservationId:row.reservationId,runId:row.runId,text:'Synthetic visible billing record'}))};
  const inputHash='a'.repeat(64),qualityEvidence=kind==='update'?{
   version:'release-word-quality-evidence-v1',status:'passed',scope:'stored_server_mechanical_evidence',humanAcceptance:'not_evaluated',runId,inputHash,
   reportReference:{sha256:'e'.repeat(64),byte_size:512},reportSha256:'e'.repeat(64),reportBytes:512,
   report:{version:'word-quality-v1',status:'passed',issues:[],input_hash:inputHash,visual_review:'not_run',factual_accuracy:'not_verified',tracked_sha256:'d'.repeat(64),clean_sha256:'d'.repeat(64),
    document_size_check:{version:'whole-document-size-v1',status:'passed',issues:[],visual_acceptance:'not_performed',minimum_ratio:0.7,page_check:{status:'passed',renderer:'LibreOffice',baseline:{pages:100},clean:{pages:100},ratio:1,minimum_source_pages:50,minimum_page_loss:20}}},
   artifacts:Object.fromEntries(['tracked','clean'].map(role=>[role,{artifactId:'synthetic-'+role,version:1,sha256:'d'.repeat(64),bytes:1200,downloadCopies:2}])),
   pageCount:{status:'passed',source:'stored_document_size_check',baseline:100,clean:100,visualAcceptance:'not_performed'},
  }:undefined;
  const evidence=downloads.map(download=>({...download,inspection:{schema:'release-artifact-structure-v1',kind:workpaper?'workpaper_zip':'docx',sha256:download.sha256,bytes:download.bytes,...(workpaper?{
   status:'passed',failureCodes:[],checks:{zip_structure:'passed',entry_integrity:'passed',mapping:'passed',all_docx:'passed'},regularFiles:5,
   members:expectedWorkpapers.map(item=>({...item,inspection:structuredClone(body)})),
  }:structuredClone(body))}}));
  return {id,status:'passed',finishedAt:stamp,...(workpaper?{workpaperBatchId:'batch',batchState:'complete',expectedWorkpapers}:{runId,runState:'succeeded'}),accepted,
   quoteResponse:['update','review'].includes(kind)?{quote}:quote,downloads,modelEvidence:modelFixture(kind,reservations,stamp),billingPageEvidence:billingPage,...(qualityEvidence?{inputHash,qualityEvidence}:{}),...(kind==='integrity'?{integrityVerifiedPairs:[{subject_id:'synthetic-subject',site_id:'synthetic-site'}],integrityBillingPageEvidence:{version:'release-integrity-visible-settlement-v1',status:'passed',runId,priceVersion:accepted.priceVersion,quotedPoints:points,chargedPoints:points,releasedPoints:'0',executablePairs:5,verifiedPairs:[{subject_id:'synthetic-subject',site_id:'synthetic-site'}],observations:[1,2].map(()=>({observedAt:stamp,amountsText:'Synthetic visible amounts',reasonText:'Synthetic visible settlement explanation',items:[{subjectId:'synthetic-subject',siteId:'synthetic-site',text:'Synthetic visible verified query'}]}))}}:{}),
   artifactEvidence:{schema:'release-artifact-structure-v1',status:'passed',downloads:evidence,contentReview:'not_claimed',visualReview:'not_claimed'},
   billingEvidence:{kind,acceptedPoints:points,reserved:points,charged:points,released:'0',corrected:'0',net:points,held:'0',reservations,walletDeltaVerified:true,syntheticCredits:true,paymentChannelVerified:false},
   refreshEvidence:{status:'passed',sameTask:true,billingPage:structuredClone(billingPage),downloads:FLOW_DOWNLOADS[id].map(role=>({role,sha256:'d'.repeat(64),bytes:1200})),billing:{unchanged:true,reservations:reservations.length,events:2*reservations.length}}};
 });
 return {schema:'release-five-flow-v1',status:'passed',modelMode:'live',realPayment:false,modelProbe:'passed',ownerId,sha:expected.commit,tree:expected.tree,startedAt:stamp,completedAt:stamp,finishedAt:stamp,cases,images,
  artifactInspector:{sha256:expected.inspectorSha256,imageId:images.api.id,sha:expected.commit,tree:expected.tree}};
}
