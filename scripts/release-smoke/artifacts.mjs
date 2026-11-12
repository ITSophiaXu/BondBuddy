import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';

export const ARTIFACT_INSPECTION_VERSION='release-artifact-structure-v1';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashPattern=/^[a-f0-9]{64}$/;
const checkNames=['zip_structure','entry_integrity','xml_well_formedness','ooxml_relationships','word_document'];
const dispositions=new Set(['not_applicable','missing_information','external_evidence']);
const fail=message=>{throw Error(message);};

/** Use the same authoritative batch order and naming helper as the API ZIP.
 * Selection-to-batch identity must be checked by the journey before calling.
 */
export function createExpectedWorkpapers(batch,{workpaperZipPath}={}){
 if(typeof workpaperZipPath!=='function'||!batch?.batch_id||!Array.isArray(batch.items)||batch.items.length!==5)fail('WORKPAPER_EXPECTED_FIVE_REQUIRED');
 const ids=new Set(),used=new Set(),explanations=[],documents=[];
 for(const item of batch.items){
  const {entry,decision}=item;
  if(item.state!=='succeeded'||typeof entry?.id!=='string'||!entry.id||ids.has(entry.id)||typeof entry.path!=='string'||!entry.path||!decision)fail('WORKPAPER_MAPPING_INCOMPLETE');
  ids.add(entry.id);
  const artifacts=(item.artifacts??[]).filter(a=>a.kind==='document');
  if(item.explanation){
   if(artifacts.length||!dispositions.has(decision.status)||!hashPattern.test(item.explanation.sha256??''))fail('WORKPAPER_MAPPING_AMBIGUOUS');
   explanations.push({item,sha256:item.explanation.sha256});
  }else{
   if(decision.status!=='generate'||artifacts.length!==1||!hashPattern.test(artifacts[0].pin?.sha256??''))fail('WORKPAPER_MAPPING_INCOMPLETE');
   documents.push({item,sha256:artifacts[0].pin.sha256});
  }
 }
 return [...explanations.map(value=>({...value,explanation:true})),...documents.map(value=>({...value,explanation:false}))].map(({item,sha256,explanation})=>({
  entryId:item.entry.id,cataloguePath:item.entry.path,disposition:explanation?'explanation':'generated',decisionStatus:item.decision.status,
  archivePath:workpaperZipPath(item.entry,explanation,used),sha256,
 }));
}

function assertDocxResult(result){
 if(!result||result.status!=='passed'||!Array.isArray(result.failureCodes)||result.failureCodes.length||
  !checkNames.every(key=>result.checks?.[key]==='passed')||!Number.isSafeInteger(result.bodyCharacters)||result.bodyCharacters<1||
  !Number.isSafeInteger(result.fileParts)||result.fileParts<3||!Number.isSafeInteger(result.xmlParts)||result.xmlParts<3)fail('ARTIFACT_STRUCTURE_INCOMPLETE');
}
function assertResult(result,expected){
 if(result?.schema!==ARTIFACT_INSPECTION_VERSION||result.kind!==expected.kind||result.sha256!==expected.expectedSha256||result.bytes!==expected.expectedBytes||
  result.status!=='passed'||!Array.isArray(result.failureCodes)||result.failureCodes.length)fail('ARTIFACT_INSPECTION_FAILED');
 if(expected.kind==='docx')assertDocxResult(result);
 else{
  if(result.checks?.zip_structure!=='passed'||result.checks?.entry_integrity!=='passed'||result.checks?.mapping!=='passed'||result.checks?.all_docx!=='passed'||
   !Array.isArray(result.members)||result.members.length!==5||result.regularFiles!==5||!Array.isArray(expected.expectedWorkpapers)||expected.expectedWorkpapers.length!==5)fail('WORKPAPER_INSPECTION_INCOMPLETE');
  const seen=new Set();
  for(const member of result.members){
   const wanted=expected.expectedWorkpapers.find(item=>item.archivePath===member.archivePath);
   if(!wanted||seen.has(member.archivePath)||member.entryId!==wanted.entryId||member.sha256!==wanted.sha256||member.disposition!==wanted.disposition)fail('WORKPAPER_INSPECTION_MISMATCH');
   seen.add(member.archivePath);assertDocxResult(member.inspection);
  }
 }
}

/** The callback is provided by run.mjs and executes the CLI in a fixed, offline
 * application image. This module never starts Docker or reads credentials.
 */
export async function validateDownload({path,kind,expectedSha256,expectedBytes,expectedWorkpapers},{inspect}={}){
 if(!['docx','workpaper_zip'].includes(kind)||typeof inspect!=='function'||!hashPattern.test(expectedSha256??'')||!Number.isSafeInteger(expectedBytes)||expectedBytes<1)fail('ARTIFACT_REQUEST_INVALID');
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==expectedBytes||stat.size>64*1024*1024)fail('ARTIFACT_FILE_INVALID');
 const before=readFileSync(path);
 if(hash(before)!==expectedSha256)fail('ARTIFACT_HASH_MISMATCH');
 const request={path,kind,expectedSha256,expectedBytes,...(kind==='workpaper_zip'?{expectedWorkpapers}:{})};
 const result=await inspect(request);
 try{
  assertResult(result,request);
  const after=lstatSync(path);
  if(!after.isFile()||after.isSymbolicLink()||after.size!==expectedBytes||hash(readFileSync(path))!==expectedSha256)fail('ARTIFACT_CHANGED_DURING_INSPECTION');
 }catch(error){error.inspection=result;throw error;}
 return result;
}

/** Validate every recorded copy. Repeated downloads must have the same bytes;
 * they cannot substitute for a missing role, or hide an earlier failed copy.
 */
export async function assertCaseArtifacts(entry,{required,inspect,expectedWorkpapers=entry?.expectedWorkpapers}={}){
 if(!Array.isArray(required)||!required.length||new Set(required.map(x=>x.name)).size!==required.length)fail('ARTIFACT_ROLES_INVALID');
 if(!Array.isArray(entry?.downloads)||!entry.downloads.length)fail('ARTIFACT_DOWNLOADS_MISSING');
 const seen=new Map(),evidence=[];
 for(const download of entry.downloads){
  const wanted=required.find(item=>item.name===download.role);
  if(!wanted)fail('ARTIFACT_ROLE_UNEXPECTED');
  const prior=seen.get(download.role);
  if(prior&&(prior.sha256!==download.sha256||prior.bytes!==download.bytes))fail('ARTIFACT_REDOWNLOAD_MISMATCH');
  seen.set(download.role,download);
  const inspection=await validateDownload({path:download.path,kind:wanted.kind,expectedSha256:download.sha256,expectedBytes:download.bytes,expectedWorkpapers},{inspect});
  evidence.push({role:download.role,path:download.path,sha256:download.sha256,bytes:download.bytes,inspection});
 }
 if(required.some(item=>!seen.has(item.name)))fail('ARTIFACT_ROLE_MISSING');
 return {schema:ARTIFACT_INSPECTION_VERSION,status:'passed',downloads:evidence,contentReview:'not_claimed',visualReview:'not_claimed'};
}
