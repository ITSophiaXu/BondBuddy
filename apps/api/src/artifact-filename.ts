import { resultFilename, M4_DOCUMENT_LABELS, type M4DocumentType } from '@bondbuddy/contracts';

/** Shared aliases keep all download DTOs and Content-Disposition on the same frozen metadata. */
export const artifactNameColumns = (alias: 'a' | 'v') => [
  'n_integrity.kind AS naming_integrity_kind',alias + '.created_at AS naming_created_at', 'r.input_revision AS naming_input_revision',
  'n_input.manifest AS naming_manifest', 'n_review.version AS naming_review_version',
  'n_review_art.kind AS naming_review_kind', 'n_m4.kind AS naming_m4_kind',
  'n_m4.revision_number AS naming_m4_revision', 'n_m4.document_type AS naming_m4_type',
  'n_execution.manifest AS naming_m4_manifest', "n_job.checkpoint#>'{stages,word_delivery_pair}' AS naming_pair"
].join(',');
export const artifactNameJoins = (alias: 'a' | 'v') => {
  const owner = alias + '.owner_user_id', run = alias + '.run_id';
  return ' LEFT JOIN bb_integrity_artifacts n_integrity ON n_integrity.owner_user_id='+owner+' AND n_integrity.artifact_id='+alias+'.id AND n_integrity.artifact_version='+alias+'.version' +
    ' LEFT JOIN bb_input_revisions n_input ON n_input.owner_user_id=' + owner + ' AND n_input.project_id=r.project_id AND n_input.revision=r.input_revision' +
    ' LEFT JOIN bb_review_executions n_review ON n_review.owner_user_id=' + owner + ' AND n_review.run_id=' + run +
    ' LEFT JOIN bb_review_artifacts n_review_art ON n_review_art.owner_user_id=' + owner + ' AND n_review_art.artifact_id=' + alias + '.id AND n_review_art.artifact_version=' + alias + '.version' +
    ' LEFT JOIN bb_m4_artifacts n_m4 ON n_m4.owner_user_id=' + owner + ' AND n_m4.artifact_id=' + alias + '.id AND n_m4.artifact_version=' + alias + '.version' +
    ' LEFT JOIN bb_m4_executions n_execution ON n_execution.owner_user_id=' + owner + ' AND n_execution.run_id=' + run +
    ' LEFT JOIN bb_jobs n_job ON n_job.owner_user_id=' + owner + ' AND n_job.run_id=' + run;
};
export function artifactDownloadName(row: any, pair: any = row.naming_pair): { filename: string; display_version: number } {
  const manifest = row.naming_manifest ?? {}, m4 = row.naming_m4_manifest ?? {};
  if(m4.input?.workpaper?.entry?.path&&row.naming_m4_kind==='document')return {filename:m4.input.workpaper.entry.path.split('/').at(-1),display_version:Number(row.naming_m4_revision??1)};
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
