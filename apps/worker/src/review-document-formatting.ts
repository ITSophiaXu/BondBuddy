import type { StoredParseSnapshot } from './parse-evidence-repository.js';
import { validDocxDocumentFormatting, type ReviewFormattedDocument } from '../../../packages/domain/dist/review-document-formatting.js';

/** Called only after reading the authenticated immutable snapshot, using the saved review source pin. */
export function loadReviewDocumentFormatting(snapshot:StoredParseSnapshot,input:{owner_user_id:string;project_id:string;
  source:{material_id:string;material_version:number;sha256:string};snapshot_id:string;response_sha256:string|null}):ReviewFormattedDocument|null {
  const p=input.source,r=snapshot.response;
  if(snapshot.ownerUserId!==input.owner_user_id||snapshot.projectId!==input.project_id||snapshot.materialId!==p.material_id
    ||snapshot.materialVersion!==p.material_version||snapshot.contentSha256!==p.sha256||snapshot.snapshotId!==input.snapshot_id
    ||snapshot.responseSha256!==input.response_sha256||r.material?.material_id!==p.material_id||r.material.material_version!==p.material_version
    ||r.material.sha256!==p.sha256||r.parser_version!==snapshot.parserVersion)throw new Error('INPUT_REVISION_CONFLICT');
  if(r.material.media_type!=='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ||r.parser_version!=='bondbuddy-document-parser-1.0.8'||r.document.docx_formatting===undefined)return null;
  if(!validDocxDocumentFormatting(r.document.docx_formatting))throw new Error('INVALID_PARSE_RESPONSE');
  return {owner_user_id:input.owner_user_id,project_id:input.project_id,material_id:p.material_id,material_version:p.material_version,material_sha256:p.sha256,
    parse_snapshot_id:snapshot.snapshotId,parse_response_sha256:snapshot.responseSha256,parser_version:r.parser_version,formatting:structuredClone(r.document.docx_formatting)};
}
