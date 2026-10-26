import { resultFilename, M4_DOCUMENT_LABELS, type M4DocumentType } from '@bondbuddy/contracts';

/** Delivery metadata is frozen with its exact members; current job/input drafts never rename old files. */
export const artifactNameColumns = (_alias: 'a' | 'v') => [
  'naming_integrity_kind','naming_created_at','naming_input_revision','naming_manifest','naming_review_version',
  'naming_review_kind','naming_m4_kind','naming_m4_revision','naming_m4_type','naming_m4_manifest','naming_pair',
].map(field => 'n_delivery.' + field + ' AS ' + field).join(',');
export const artifactNameJoins = (alias: 'a' | 'v') =>
  ' LEFT JOIN bb_run_execution_delivery_artifact_details n_delivery ON n_delivery.owner_user_id=' + alias + '.owner_user_id' +
  ' AND n_delivery.run_id=' + alias + '.run_id AND n_delivery.artifact_id=' + alias + '.id AND n_delivery.artifact_version=' + alias + '.version';
export function artifactDownloadName(row: any, pair: any = row.naming_pair): { filename: string; display_version: number } {
  const manifest = row.naming_manifest ?? {}, m4 = row.naming_m4_manifest ?? {};
  if(manifest.version==='project-qa-v1')return {filename:resultFilename({project:manifest.source?.filename?.replace(/\.(docx|doc)$/i,''),kind:manifest.operation==='answer'?'已回填回答':'问题清单解析稿',version:Number(row.naming_input_revision??1),createdAt:row.naming_created_at,mediaType:row.media_type}),display_version:Number(row.naming_input_revision??1)};
  if(manifest.version==='integrity-round-v1')return {filename:resultFilename({project:manifest.project_name,kind:row.naming_integrity_kind==='company'?'企业诚信核查底稿':row.naming_integrity_kind==='person'?'人员诚信核查底稿':'诚信核查底稿',version:Number(row.naming_input_revision??1),createdAt:row.naming_created_at,mediaType:row.media_type}),display_version:Number(row.naming_input_revision??1)};
  if(manifest.version==='project-file-operation-v1'){
    const pairKind=pair?.revision_artifact_id===(row.id??row.artifact_id)?'修订版':pair?.clean_artifact_id===(row.id??row.artifact_id)?'清洁版':'基线版';
    return {filename:resultFilename({project:manifest.filename?.replace(/\.(docx|pdf)$/i,''),kind:manifest.operation==='check'?'文件一致性检查报告':pairKind,version:Number(row.naming_input_revision??1),createdAt:row.naming_created_at,mediaType:row.media_type}),display_version:Number(row.naming_input_revision??1)};
  }
  const project = manifest.name || m4.project_name || manifest.issuer_name || m4.input?.fields?.issuer_name || m4.assistant_context?.project_name || null;
  const id = row.id ?? row.artifact_id;
  const variant = row.naming_review_kind || (pair?.revision_artifact_id === id ? 'revision' : pair?.clean_artifact_id === id ? 'clean' : pair?.baseline_artifact_id === id ? 'baseline' : null);
  const labels: Record<string,string> = { report:'复核报告', comments:'原文批注版', revision:'募集书修订版', clean:'募集书清洁版', baseline:'募集书基线版' };
  const material = row.naming_m4_type ? M4_DOCUMENT_LABELS[row.naming_m4_type as M4DocumentType] : '项目材料';
  const kind = row.naming_m4_kind ? row.naming_m4_kind === 'qa_text' ? '问答记录' : material + (row.naming_m4_kind === 'preparation_note' ? '编制说明' : '') : labels[variant] || '募集书成果';
  const display_version = Number(row.naming_review_version ?? row.naming_m4_revision ?? row.naming_input_revision ?? row.version ?? row.artifact_version ?? 1);
  return { filename:resultFilename({project,kind,version:display_version,createdAt:row.naming_created_at,mediaType:row.media_type}), display_version };
}
