import type { ProspectusVersions, ReviewArtifact, ReviewExportRequest, ReviewEditorIssue } from '@bondbuddy/contracts';

export type ReviewCurrentVersion = { state: 'loading' | 'unknown' | 'none' | 'current' | 'other'; sequence?: number };
export function reviewCurrentVersion(versions: ProspectusVersions, project: string, run: string, clean?: ReviewArtifact): ReviewCurrentVersion {
  if (versions.project_id !== project || new Set(versions.versions.map(v=>v.version_id)).size !== versions.versions.length) return {state:'unknown'};
  if (versions.current_version_id === null) return {state:'none'};
  const selected=versions.versions.find(v=>v.version_id===versions.current_version_id);
  if (!selected) return {state:'unknown'};
  if (selected.run_id === run) {
    if (!clean || selected.artifact_id !== clean.artifact_id || selected.artifact_version !== clean.artifact_version) return {state:'unknown'};
    return {state:'current',sequence:selected.sequence};
  }
  return {state:'other',sequence:selected.sequence};
}
export function reviewUnsavedIssues(issues: ReviewEditorIssue[], baseline: ReviewExportRequest['decisions']) {
  const saved=new Map(baseline.map(d=>[d.id,d]));
  return issues.filter(issue=>{const prior=saved.get(issue.id);return !prior || prior.decision!==issue.decision || issue.decision==='manual'&&prior.manual_text!==issue.manual_text;});
}
export function reviewEditorFeedback(options:{version?:number;dirty:boolean;pending:boolean;submitted:boolean;recoveryBlocked:boolean;current:ReviewCurrentVersion;unsavedCount:number}) {
  const saved=options.version?`成果 V${options.version}`:'当前已保存成果';
  const changes=options.unsavedCount?`${options.unsavedCount} 项处理选择`:'';
  const download=options.submitted?`新版导出已受理，等待新成果；下方仍下载${saved}，不包含本次导出中的处理。`
    :options.pending?`新版导出回执待确认；下方仍下载${saved}，不包含待确认的处理。`
    :options.recoveryBlocked?`恢复记录待核实；下方仅下载${saved}，不包含尚未保存的预览。`
    :options.dirty?`下载仍为${saved}（已保存）；${changes||'本页处理'}尚未保存，不包含在下载文件中。`
    :`下载${saved}（已保存），与当前已保存的处理选择对应。`;
  const preview=options.submitted?'本次导出中的文字预览':options.pending?'待确认导出的文字预览':options.dirty?'尚未保存的文字预览':'已保存的文字预览';
  const current=options.current.state==='loading'?'正在核对项目当前稿…':options.current.state==='unknown'?'项目当前稿暂不可核实。':options.current.state==='none'?'项目尚未采用当前稿。':options.current.state==='current'?`此成果已是项目当前稿（募集书 V${options.current.sequence}）。`:`此成果未设为当前稿；项目当前稿为募集书 V${options.current.sequence}。`;
  return {download,preview:`${preview} · 基于${saved} · 排版以下载 Word 为准`,current:current+' 保存导出不会自动替换项目当前稿。',unsavedTitle:options.submitted?'查看本次导出中的处理':options.pending?'查看待确认的处理':'查看尚未保存的处理',save:'保存并导出处理结果（不重新复核）',followup:'准备下一轮复核材料',followupHelp:'补充内容用于下一轮；明确开始后重新复核。本页保存仅导出已有处理，不重复 AI 复核。'};
}
