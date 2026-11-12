import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {dirname} from 'node:path';

export const SAMPLE_REF='6480f7c1bda41e3d49dc757e1b305de21de4edfa';
export const REPORT_SCHEMA='release-five-flow-v1';
export const CASES=['update-rq-202509','review-dongying','qa-dongying','integrity-dongying','workpaper-dongying'];
const roles={'update-rq-202509':['tracked.docx','clean.docx'],'review-dongying':['review.docx'],'qa-dongying':['answers.docx'],'integrity-dongying':['integrity.docx'],'workpaper-dongying':['workpaper.zip']};
export function requiredArtifacts(id){if(!roles[id])throw Error('Unknown case');return roles[id].map(name=>({name,kind:name.endsWith('.zip')?'workpaper_zip':'docx'}));}
export function assertCaseComplete(entry){
 if(!CASES.includes(entry.id)||entry.status!=='passed')throw Error('Case not passed');
 if(entry.id==='workpaper-dongying'){
  if(!entry.workpaperBatchId||entry.batchState!=='complete'||entry.accepted?.workpaperBatchId!==entry.workpaperBatchId||entry.expectedItemIds?.length!==5||new Set(entry.expectedItemIds).size!==5)throw Error('Five workpaper task identities incomplete');
 }else if(!entry.runId||entry.runState!=='succeeded'||entry.accepted?.runId!==entry.runId)throw Error('Original successful run missing');
 if(!entry.submissionRequest?.sha256||!entry.submissionReceipt||!entry.accepted?.priceVersion)throw Error('Accepted request/quote evidence missing');
 const artifact=entry.artifactEvidence;
 if(artifact?.schema!=='release-artifact-structure-v1'||artifact.status!=='passed'||!Array.isArray(artifact.downloads))throw Error('Artifact evidence missing');
 for(const role of requiredArtifacts(entry.id)){
  const copies=artifact.downloads.filter(d=>d.role===role.name);
  if(copies.length<2||new Set(copies.map(d=>d.sha256+':'+d.bytes)).size!==1||copies.some(d=>d.inspection?.status!=='passed'))throw Error('Original and refreshed download evidence incomplete');
 }
 if(!entry.billingEvidence||entry.billingEvidence.held!=='0'||!Array.isArray(entry.billingEvidence.reservations)||!entry.billingEvidence.reservations.length)throw Error('Terminal billing evidence missing');
 if(entry.refreshEvidence?.status!=='passed'||entry.refreshEvidence.sameTask!==true||entry.refreshEvidence.billing?.unchanged!==true)throw Error('Refresh readback or repeat-charge evidence missing');
 if(entry.modelEvidence?.version!=='release-model-evidence-v1'||!Array.isArray(entry.modelEvidence.scopeRunIds))throw Error('Actual model evidence missing');
 if(entry.billingPageEvidence?.status!=='passed'||entry.billingPageEvidence.frozen!=='0'||entry.refreshEvidence?.billingPage?.status!=='passed')throw Error('Visible billing evidence missing');
 if(entry.id==='update-rq-202509'&&(entry.qualityEvidence?.version!=='release-word-quality-evidence-v1'||entry.qualityEvidence.status!=='passed'||entry.qualityEvidence.humanAcceptance!=='not_evaluated'))throw Error('Original server Word quality evidence missing');
 if(entry.id==='integrity-dongying'&&(!Array.isArray(entry.integrityVerifiedPairs)||!entry.integrityVerifiedPairs.length))throw Error('No verified real integrity query evidence');
 return entry;
}
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function writeJson(path,value){mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
export function contained(root,relative,paths=path){const base=paths.resolve(root),p=paths.resolve(base,relative),inside=paths.relative(base,p);if(!inside||inside==='..'||inside.startsWith('..'+paths.sep)||paths.isAbsolute(inside))throw Error('Sample path escapes its root');return p;}
export function verifiedFile(root,relative,hash){const path=contained(root,relative),bytes=readFileSync(path);if(!/^[a-f0-9]{64}$/.test(hash)||sha256(bytes)!==hash)throw Error('Sample hash mismatch: '+relative);return path;}
export function verdict(results){
 try{if(!Array.isArray(results)||results.length!==CASES.length||CASES.some(id=>results.filter(r=>r.id===id).length!==1))return 'blocked';for(const entry of results)assertCaseComplete(entry);return 'passed';}catch{return 'blocked';}
}
export function assertLocalContext(inspect,platform=process.platform){
 const host=inspect?.Endpoints?.docker?.Host;
 const localUnix=typeof host==='string'&&host.startsWith('unix:///');
 const localPipe=platform==='win32'&&typeof host==='string'&&/^npipe:\/\/\/\/\.\/pipe\/[a-z0-9._-]+$/i.test(host);
 if(!localUnix&&!localPipe)throw Error('Release smoke requires a local Docker Unix socket or Windows named pipe; remote engines are refused');
}
export function assertTestReport(report){
 if(report.schema!==REPORT_SCHEMA||!(/^[a-f0-9]{40}$/).test(report.tree??''))throw Error('Five-flow fixed candidate report required');
 if(report.baseURL!=='http://localhost:5288'||!/^bb-release-[a-f0-9]{10}$/.test(report.project??'')||!(/^[a-f0-9]{40}$/).test(report.sha??'')||report.sampleRef!==SAMPLE_REF)throw Error('Not a recognized local release test report');
 if(report.modelProbe!=='passed')throw Error('Setup is incomplete; start a fresh test instead of resuming business tasks');
 if(!Array.isArray(report.cases)||report.cases.length!==CASES.length||CASES.some(id=>report.cases.filter(c=>c.id===id).length!==1))throw Error('Required test cases are missing or duplicated');
 for(const name of ['api','worker','web'])if(!/^sha256:[a-f0-9]{64}$/.test(report.images?.[name]?.id??''))throw Error('Test image identity missing');
}

// Completed journeys keep their original timestamps on --resume. A later
// inspection/cleanup attempt must not renew an already completed suite.
export function caseCompletionTime(cases){
 if(!Array.isArray(cases)||cases.length===0)throw Error('Release smoke case completion timestamps are missing or invalid');
 const times=cases.map(entry=>typeof entry?.finishedAt==='string'?Date.parse(entry.finishedAt):NaN);
 if(times.some(time=>!Number.isFinite(time)))throw Error('Release smoke case completion timestamps are missing or invalid');
 return Math.max(...times);
}
