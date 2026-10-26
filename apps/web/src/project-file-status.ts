import type {ProjectFileVersion} from '@bondbuddy/contracts';
import type {ProjectFile} from './project-collection-model.js';

// These are local display groups, not additional API or persisted task states.
export const fileStatusOptions=[
  {key:'all',label:'全部文件'},
  {key:'check',label:'待检查/复查'},
  {key:'review',label:'差异或人工待处理'},
  {key:'checking',label:'正在检查'},
  {key:'consistent',label:'本轮未发现差异'},
  {key:'unsynced',label:'状态待同步'},
  {key:'other',label:'其他文件'}
] as const;
export type FileStatusGroup=typeof fileStatusOptions[number]['key'];
export type ProjectFileStatusRow={file:ProjectFile;group:Exclude<FileStatusGroup,'all'>;version?:ProjectFileVersion};
export const isFileStatusGroup=(value:string):value is FileStatusGroup=>fileStatusOptions.some(option=>option.key===value);

export function matchesProjectFileVersion(file:ProjectFile,version:ProjectFileVersion){
  if('project-file:'+version.file_id!==file.file_key||version.sequence!==file.display_version||version.filename!==file.filename||version.asset.kind!==file.source||version.run_id!==file.run_id)return false;
  const pin=version.asset.pin;
  return pin.source_project_id===file.project_id&&pin.sha256===file.sha256&&(version.asset.kind==='material'
    ?version.asset.pin.material_id===file.file_id&&version.asset.pin.material_version===file.version
    :version.asset.pin.artifact_id===file.file_id&&version.asset.pin.artifact_version===file.version);
}

/** Resolve an immutable version, including historical downloads, without choosing
 * the first of duplicate IDs, family sequences, or matching asset records. */
export function resolveProjectFileVersion(file:ProjectFile,registry:readonly ProjectFileVersion[]){
  const matches=registry.filter(version=>matchesProjectFileVersion(file,version));
  if(matches.length!==1)return;
  const match=matches[0];
  if(registry.filter(version=>version.version_id===match.version_id).length!==1||registry.filter(version=>version.file_id===match.file_id&&version.sequence===match.sequence).length!==1)return;
  return match;
}

/** All classification is projected from the same accurately matched current
 * row. Unknown/misaligned records never become unchecked or a successful result. */
export function projectFileStatusRows(files:readonly ProjectFile[],registry:readonly ProjectFileVersion[],registryLoaded:boolean):ProjectFileStatusRow[]{
  const current=files.filter(file=>file.latest);
  return current.map(file=>{
    if(!file.file_key.startsWith('project-file:'))return {file,group:'other'};
    const version=registryLoaded?resolveProjectFileVersion(file,registry):undefined;
    if(!version?.latest||current.filter(row=>row.file_key===file.file_key).length!==1||registry.filter(row=>row.file_id===version.file_id&&row.latest).length!==1)return {file,group:'unsynced'};
    const status=version.consistency.status;
    const group:ProjectFileStatusRow['group']=status==='unchecked'||status==='stale'||status==='updated'?'check'
      :status==='conflict'||status==='manual'?'review':status==='checking'?'checking':status==='consistent'?'consistent':'unsynced';
    return {file,version:group==='unsynced'?undefined:version,group};
  });
}
