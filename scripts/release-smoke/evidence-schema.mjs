import assert from 'node:assert/strict';
import {validateModelEvidence} from './model-quality-evidence.mjs';

export const RELEASE_REPORT_SCHEMA='release-five-flow-v1';
export const REQUIRED_RELEASE_CASES=Object.freeze(['update-rq-202509','review-dongying','qa-dongying','integrity-dongying','workpaper-dongying']);
export const FLOW_DOWNLOADS=Object.freeze({
 'update-rq-202509':['tracked.docx','clean.docx'],
 'review-dongying':['review.docx'],
 'qa-dongying':['answers.docx'],
 'integrity-dongying':['integrity.docx'],
 'workpaper-dongying':['workpaper.zip'],
});
const hash=/^[a-f0-9]{64}$/,image=/^sha256:[a-f0-9]{64}$/;
const structureChecks=['zip_structure','entry_integrity','xml_well_formedness','ooxml_relationships','word_document'];
const id=value=>typeof value==='string'&&value.trim().length>0&&value.length<=4096;
const int=value=>Number.isSafeInteger(value)&&value>=0;
function amount(value){
 assert.ok(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value),'billing amount must be a canonical decimal string');
 const result=BigInt(value);assert.ok(result<=9223372036854775807n,'billing amount exceeds int64');return result;
}
function docx(inspection){
 assert.equal(inspection?.status,'passed','DOCX structure evidence missing');
 assert.deepEqual(inspection.failureCodes,[],'DOCX structure failure remains');
 for(const name of structureChecks)assert.equal(inspection.checks?.[name],'passed','DOCX check missing: '+name);
 assert.ok(int(inspection.bodyCharacters)&&inspection.bodyCharacters>0,'DOCX body is empty');
 assert.ok(int(inspection.xmlParts)&&inspection.xmlParts>=3&&int(inspection.fileParts)&&inspection.fileParts>=3,'DOCX part counts missing');
}
function workpapers(inspection,expected){
 assert.ok(Array.isArray(expected)&&expected.length===5,'Five trusted workpaper mappings required');
 assert.equal(new Set(expected.map(x=>x.entryId)).size,5,'Workpaper ids duplicated');
 assert.equal(new Set(expected.map(x=>x.archivePath)).size,5,'Workpaper paths duplicated');
 const folders=new Set();
 for(const item of expected){
  assert.ok(id(item.entryId)&&id(item.cataloguePath)&&hash.test(item.sha256??''),'Workpaper mapping is incomplete');
  const folder=item.disposition==='generated'?'可生成文件':item.disposition==='explanation'?'不适用说明':null;
  assert.ok(folder&&id(item.archivePath)&&item.archivePath.startsWith(folder+'/')&&item.archivePath.endsWith('.docx'),'Workpaper folder mismatch');
  assert.ok(!item.archivePath.includes('\\')&&item.archivePath.split('/').every(p=>p&&p!=='.'&&p!=='..'),'Unsafe workpaper path');
  assert.ok(item.disposition==='generated'?item.decisionStatus==='generate':['not_applicable','missing_information','external_evidence'].includes(item.decisionStatus),'Workpaper decision missing');
  folders.add(folder);
 }
 assert.equal(folders.size,2,'Both workpaper folders must be exercised');
 assert.equal(inspection.regularFiles,5,'ZIP regular file count mismatch');
 for(const key of ['zip_structure','entry_integrity','mapping','all_docx'])assert.equal(inspection.checks?.[key],'passed','ZIP check missing: '+key);
 assert.ok(Array.isArray(inspection.members)&&inspection.members.length===5,'All five DOCX results required');
 assert.equal(new Set(inspection.members.map(x=>x.archivePath)).size,5,'ZIP member duplicated');
 for(const member of inspection.members){
  const wanted=expected.find(x=>x.archivePath===member.archivePath);
  assert.ok(wanted&&member.entryId===wanted.entryId&&member.sha256===wanted.sha256&&member.disposition===wanted.disposition,'ZIP member does not match trusted mapping');
  docx(member.inspection);
 }
}
function artifactEvidence(entry,report){
 const roles=FLOW_DOWNLOADS[entry.id],artifact=entry.artifactEvidence;
 assert.equal(artifact?.schema,'release-artifact-structure-v1','Artifact schema missing');assert.equal(artifact.status,'passed','Artifact inspection not passed');
 assert.ok(Array.isArray(entry.downloads)&&Array.isArray(artifact.downloads)&&entry.downloads.length===artifact.downloads.length,'Artifact downloads do not cover every observation');
 const seen=new Map();
 for(let i=0;i<entry.downloads.length;i++){
  const download=entry.downloads[i],record=artifact.downloads[i];
  assert.ok(roles.includes(download.role)&&id(download.path)&&hash.test(download.sha256??'')&&int(download.bytes)&&download.bytes>0,'Invalid download identity');
  for(const key of ['role','path','sha256','bytes'])assert.equal(record?.[key],download[key],'Artifact record mismatch: '+key);
  const prior=seen.get(download.role)??[];
  assert.ok(prior.every(x=>x.path!==download.path),'Independent UI downloads need distinct saved paths');
  assert.ok(prior.every(x=>x.sha256===download.sha256&&x.bytes===download.bytes),'Repeated download bytes changed');
  prior.push(download);seen.set(download.role,prior);
  const inspection=record.inspection;
  assert.equal(inspection?.schema,'release-artifact-structure-v1','Structure schema missing');
  assert.equal(inspection.sha256,download.sha256,'Structure hash mismatch');assert.equal(inspection.bytes,download.bytes,'Structure size mismatch');
  assert.equal(inspection.status,'passed','Structure inspection failed');assert.deepEqual(inspection.failureCodes,[]);
  assert.equal(inspection.kind,entry.id==='workpaper-dongying'?'workpaper_zip':'docx','Artifact kind mismatch');
  if(inspection.kind==='docx')docx(inspection);else workpapers(inspection,entry.expectedWorkpapers);
 }
 for(const role of roles)assert.ok(seen.get(role)?.length>=2,'Two independent UI downloads are required for '+role);
 const refresh=entry.refreshEvidence;
 assert.equal(refresh?.status,'passed','Refresh evidence missing');assert.equal(refresh.sameTask,true,'Refresh changed task');
 assert.ok(Array.isArray(refresh.downloads)&&refresh.downloads.length===roles.length&&new Set(refresh.downloads.map(x=>x.role)).size===roles.length,'Refresh download roles incomplete');
 for(const download of refresh.downloads){
  const original=seen.get(download.role)?.[0];
  assert.ok(original&&download.sha256===original.sha256&&download.bytes===original.bytes,'Refresh download changed');
 }
 assert.equal(refresh.billing?.unchanged,true,'Refresh altered billing');
 assert.ok(int(refresh.billing.reservations)&&refresh.billing.reservations>=entry.billingEvidence.reservations.length&&
  int(refresh.billing.events)&&refresh.billing.events>=2*entry.billingEvidence.reservations.length,'Refresh billing evidence incomplete');
 assert.equal(report.artifactInspector.imageId,report.images.api.id,'Artifact inspector used a different API image');
}
function billingEvidence(entry){
 const kind=entry.id.split('-')[0],accepted=entry.accepted,billing=entry.billingEvidence;
 assert.equal(accepted?.kind,kind,'Accepted quote kind mismatch');assert.ok(id(accepted.requestId)&&id(accepted.priceVersion),'Accepted quote identity missing');
 const quote=['update','review'].includes(kind)?entry.quoteResponse?.quote:entry.quoteResponse;
 assert.ok(quote&&quote.points===accepted.points&&quote.price_version===accepted.priceVersion,'Captured quote differs from accepted quote');
 assert.equal(quote.quote_id??null,accepted.quoteId,'Accepted quote id mismatch');assert.equal(quote.scope_quote_id??null,accepted.scopeQuoteId,'Accepted scope quote mismatch');
 if(['update','review','workpaper'].includes(kind))assert.ok(id(accepted.quoteId),'Accepted quote ID missing');
 if(quote.quote_status!==undefined)assert.equal(quote.quote_status,'ready');
 assert.ok(amount(accepted.points)>0n,'Accepted price is empty');
 assert.equal(billing?.kind,kind,'Billing evidence kind mismatch');assert.equal(billing.acceptedPoints,accepted.points,'Billing quote amount mismatch');
 assert.equal(billing.held,'0','Credit reservation remains held');assert.equal(billing.walletDeltaVerified,true,'Wallet delta was not verified');
 assert.equal(billing.syntheticCredits,true,'Test-credit boundary missing');assert.equal(billing.paymentChannelVerified,false,'Real payment was not authorized by this test');
 assert.ok(Array.isArray(billing.reservations)&&billing.reservations.length>0,'Billing reservation evidence missing');
 const seen=new Set(),runs=new Set(),totals={reserved:0n,charged:0n,released:0n,corrected:0n,net:0n};
 for(const row of billing.reservations){
  assert.ok(id(row.runId)&&id(row.reservationId)&&id(row.quoteId)&&id(row.priceVersion)&&!seen.has(row.reservationId)&&!runs.has(row.runId),'Billing reservation identity is duplicated or missing');
  seen.add(row.reservationId);runs.add(row.runId);
  assert.equal(row.priceVersion,accepted.priceVersion,'Reservation price version differs from accepted quote');
  if(kind!=='workpaper'){
   assert.equal(row.reserved,accepted.points,'Reservation amount differs from accepted quote');
   if(accepted.quoteId!==null)assert.equal(row.quoteId,accepted.quoteId,'Reservation quote differs from accepted quote');
  }
  const values=Object.fromEntries(Object.keys(totals).map(key=>[key,amount(row[key])]));
  assert.ok(values.reserved>0n&&values.reserved===values.charged+values.released&&values.corrected<=values.charged&&values.net===values.charged-values.corrected,'Reservation totals do not reconcile');
  for(const key of Object.keys(totals))totals[key]+=values[key];
 }
 for(const key of Object.keys(totals))assert.equal(amount(billing[key]),totals[key],'Billing total mismatch: '+key);
 if(kind==='workpaper'){
  assert.ok(id(entry.workpaperBatchId)&&entry.workpaperBatchId===accepted.workpaperBatchId&&id(accepted.packageBatchId),'Accepted workpaper batch missing');
  assert.equal(entry.batchState,'complete','Workpaper batch incomplete');assert.ok(runs.size>=5,'Workpaper attempts missing');
 }else{
  assert.ok(id(entry.runId)&&entry.runId===accepted.runId,'Accepted run identity mismatch');assert.equal(entry.runState,'succeeded','Run did not succeed');
  assert.deepEqual([...runs],[entry.runId],'Billing evidence covers another run');
 }
}
function billingPageEvidence(page,entry){
 assert.equal(page?.status,'passed','Visible billing page evidence missing');
 amount(page.available);assert.equal(page.frozen,'0','Visible frozen balance remains');
 assert.ok(typeof page.observedAt==='string'&&Number.isFinite(Date.parse(page.observedAt)),'Billing page observation time missing');
 assert.ok(Array.isArray(page.records),'Visible billing records missing');
 const records=new Map();
 for(const record of page.records){
  assert.ok(id(record.reservationId)&&id(record.runId)&&id(record.text)&&!records.has(record.reservationId),'Visible billing record duplicated or missing');
  records.set(record.reservationId,record);
 }
 for(const row of entry.billingEvidence.reservations)assert.equal(records.get(row.reservationId)?.runId,row.runId,'Visible billing record does not cover the task');
}
function modelEvidence(entry,report){
 assert.ok(id(report.ownerId),'Test account identity missing');
 const actual=validateModelEvidence(entry.modelEvidence?.raw,{ownerId:report.ownerId,runIds:entry.runId?[entry.runId]:[],workpaperBatchId:entry.workpaperBatchId??null,preparationId:entry.preparationId??null});
 assert.deepEqual(entry.modelEvidence,actual,'Model summary differs from captured execution evidence');
 if(entry.id!=='integrity-dongying')assert.ok(actual.attempts.some(a=>a.scope==='execution'&&a.callStatus!=='confirmed_not_sent'),'Actual execution model calls are missing');
 // Unknown usage stays null with explicit counts. It is not replaced with zero
 // and cannot stand in for the separate real-model/quality acceptance receipt.
}
function originalWordQuality(entry){
 const quality=entry.qualityEvidence,report=quality?.report,page=report?.document_size_check?.page_check;
 assert.equal(quality?.version,'release-word-quality-evidence-v1','Original server quality evidence missing');
 assert.equal(quality.status,'passed');assert.equal(quality.scope,'stored_server_mechanical_evidence');
 assert.equal(quality.humanAcceptance,'not_evaluated','Mechanical evidence cannot claim human acceptance');
 assert.equal(quality.runId,entry.runId);assert.ok(hash.test(entry.inputHash??'')&&quality.inputHash===entry.inputHash,'Original quality input mismatch');
 assert.ok(hash.test(quality.reportSha256??'')&&quality.reportSha256===quality.reportReference?.sha256&&int(quality.reportBytes)&&quality.reportBytes>0&&quality.reportBytes===quality.reportReference.byte_size,'Original quality report reference mismatch');
 assert.equal(report?.version,'word-quality-v1');assert.equal(report.status,'passed');assert.deepEqual(report.issues,[]);assert.equal(report.input_hash,entry.inputHash);
 assert.equal(report.visual_review,'not_run');assert.ok(['not_verified','provided_anchors_checked_only'].includes(report.factual_accuracy),'Unexpected factual acceptance claim');
 for(const role of ['tracked','clean']){
  const copies=entry.downloads.filter(d=>d.role===role+'.docx'),artifact=quality.artifacts?.[role];
  assert.ok(id(artifact?.artifactId)&&artifact.downloadCopies===copies.length,'Original quality artifact identity missing');
  for(const copy of copies)assert.ok(artifact.sha256===copy.sha256&&artifact.bytes===copy.bytes&&report[role+'_sha256']===copy.sha256,'Quality report does not cover downloaded Word');
 }
 assert.equal(page?.status,'passed','Actual rendered page counts required');assert.equal(page.renderer,'LibreOffice');
 for(const value of [page.baseline?.pages,page.clean?.pages])assert.ok(int(value)&&value>0&&value<=2000,'Rendered page count invalid');
 assert.equal(quality.pageCount?.status,'passed');assert.equal(quality.pageCount.source,'stored_document_size_check');
 assert.equal(quality.pageCount.baseline,page.baseline.pages);assert.equal(quality.pageCount.clean,page.clean.pages);assert.equal(quality.pageCount.visualAcceptance,'not_performed');
 assert.ok(Math.abs(page.ratio-page.clean.pages/page.baseline.pages)<=0.00000051,'Rendered page ratio changed');
 const extent=report.document_size_check;assert.equal(extent.version,'whole-document-size-v1');assert.equal(extent.status,'passed');assert.deepEqual(extent.issues,[]);
 assert.equal(extent.visual_acceptance,'not_performed');assert.equal(extent.minimum_ratio,0.7);assert.equal(page.minimum_source_pages,50);assert.equal(page.minimum_page_loss,20);
 assert.ok(!(page.baseline.pages>=50&&page.baseline.pages-page.clean.pages>=20&&page.clean.pages<page.baseline.pages*0.7),'Passed page status contradicts document collapse');
}
export function verifyFiveFlowEvidence(report,expected){
 assert.equal(report?.schema,RELEASE_REPORT_SCHEMA,'Five-flow report schema is required; legacy reports cannot authorize a new release');
 assert.equal(report.modelMode,'live','Live model execution required');assert.equal(report.realPayment,false,'Real payment test boundary missing');
 const inspector=report.artifactInspector;
 assert.ok(hash.test(expected.inspectorSha256??'')&&inspector?.sha256===expected.inspectorSha256&&image.test(inspector?.imageId??'')&&inspector.sha===expected.commit&&inspector.tree===expected.tree,'Fixed-candidate artifact inspector identity missing');
 for(const target of ['api','worker','web'])assert.ok(/^linux\/(?:amd64|arm64)$/.test(report.images?.[target]?.platform??''),'Image platform missing: '+target);
 assert.equal(new Set(['api','worker','web'].map(t=>report.images[t].platform)).size,1,'Test images have mixed platforms');
 for(const entry of report.cases){
  billingEvidence(entry);artifactEvidence(entry,report);modelEvidence(entry,report);
  billingPageEvidence(entry.billingPageEvidence,entry);billingPageEvidence(entry.refreshEvidence.billingPage,entry);
  assert.equal(entry.refreshEvidence.billingPage.available,entry.billingPageEvidence.available,'Visible available balance changed after refresh');
  if(entry.id==='update-rq-202509')originalWordQuality(entry);
  if(entry.id==='integrity-dongying'){
   const pairs=entry.integrityVerifiedPairs;
   assert.ok(Array.isArray(pairs)&&pairs.length>0&&pairs.every(p=>id(p.subject_id)&&id(p.site_id)),'Verified official integrity query pairs missing');
   assert.equal(new Set(pairs.map(p=>JSON.stringify([p.subject_id,p.site_id]))).size,pairs.length,'Verified integrity pairs duplicated');
  }
 }
 return report;
}
