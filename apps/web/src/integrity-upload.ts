import {uploadFileDigest} from './upload-file-digest.js';
import {UserFacingError} from './user-facing-error.js';
import {INTEGRITY_SITES,M1_UPLOAD_LIMITS,M1_UPLOAD_MIME_TYPES} from '@bondbuddy/contracts';
import type {IntegrityEvidenceDraft} from './integrity-recovery.js';
import {UploadRecovery,UploadRecoveryConflictError,type UploadRecoveryRecord} from './upload-recovery.js';

export const integrityUploadPurpose='integrity-evidence';
export type IntegrityUploadPair=Pick<IntegrityEvidenceDraft,'roundId'|'subjectId'|'siteId'>;
type Context=IntegrityUploadPair&{kind:'integrity-evidence'};
const validId=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const formats:Record<string,typeof M1_UPLOAD_MIME_TYPES[number]>={png:M1_UPLOAD_MIME_TYPES[5],jpg:M1_UPLOAD_MIME_TYPES[6],jpeg:M1_UPLOAD_MIME_TYPES[6],pdf:M1_UPLOAD_MIME_TYPES[1],docx:M1_UPLOAD_MIME_TYPES[0]};
export const sameIntegrityUploadPair=(a:IntegrityUploadPair,b:IntegrityUploadPair)=>a.roundId===b.roundId&&a.subjectId===b.subjectId&&a.siteId===b.siteId;
export function integrityUploadPair(record:UploadRecoveryRecord):IntegrityUploadPair{
  const context=record.context;
  if(!context||typeof context!=='object'||Array.isArray(context)||Object.keys(context).length!==4||
    !['kind','roundId','subjectId','siteId'].every(key=>Object.hasOwn(context,key))||context.kind!=='integrity-evidence'||
    ![context.roundId,context.subjectId,context.siteId].every(validId)||!INTEGRITY_SITES.some(site=>site.id===context.siteId)||
    record.purpose!==integrityUploadPurpose||record.declaration.role!=='other'||!Object.values(formats).includes(record.declaration.media_type))throw new UploadRecoveryConflictError();
  return {roundId:context.roundId as string,subjectId:context.subjectId as string,siteId:context.siteId as string};
}
export function integrityUploadRecord(recovery:UploadRecovery,form:IntegrityEvidenceDraft):UploadRecoveryRecord{
  const record=recovery.list().find(record=>record.id===form.uploadOperationId);
  if(!record||!sameIntegrityUploadPair(integrityUploadPair(record),form))throw new UploadRecoveryConflictError();
  return record;
}
/** Prepare only a bounded transport record; the original evidence form stays in its CAS cache. */
export async function beginIntegrityUpload(recovery:UploadRecovery,form:IntegrityEvidenceDraft,file:File,signal:AbortSignal,current:()=>boolean):Promise<UploadRecoveryRecord>{
  if(form.uploadOperationId)return integrityUploadRecord(recovery,form);
  const mime=formats[file.name.split('.').at(-1)?.toLowerCase()??''];
  if(!mime||!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes)throw new UserFacingError('请选择不超过 100 MB 的 PNG、JPG、PDF 或 DOCX。');
  const context:Context={kind:'integrity-evidence',roundId:form.roundId,subjectId:form.subjectId,siteId:form.siteId};
  if(![context.roundId,context.subjectId,context.siteId].every(validId)||!INTEGRITY_SITES.some(site=>site.id===context.siteId))throw new UploadRecoveryConflictError();
  const sha256=[...new Uint8Array(await uploadFileDigest(file))].map(value=>value.toString(16).padStart(2,'0')).join('');
  signal.throwIfAborted();if(!current())throw new DOMException('原补证页面或本机准备已变化。','AbortError');
  return recovery.begin({filename:file.name,media_type:mime,role:'other',sha256,byte_size:file.size},context);
}
