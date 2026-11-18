import {Value} from '@sinclair/typebox/value';
import {ReviewEditorSnapshotSchema,isReviewReport,type ReviewEditorSnapshot,type ReviewReport,type ReviewFinding} from '@bondbuddy/contracts';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {registerReviewReport} from './review-word-stage.js';
import type {StageContext} from './run-pipeline.js';

const limit=(value:string)=>value.length<=12000?value:value.slice(0,11940)+'\n（完整内容保留在原复核文件及编辑器快照。）';
const limitation='文件复核意见的索引；引用尚未登记为结构化解析证据，不据此确认事实或自动执行旧版结构化修订。';
/** The deterministic editor owns issue identities. This projection never invents
 * parser records, verified citations, successful checks or a resolved finding. */
export function fileReviewReport(input:{reportId:string;projectId:string;runId:string;inputRevision:number;version:number;
 source:ReviewReport['source_material'];operation:'full_review'|'differential_review';findingIds:string[];
 sourceReportId?:string|null;sourceReportSha256?:string|null;createdAt:string},editor:ReviewEditorSnapshot):ReviewReport{
 const reportId=input.reportId;
 const findings:ReviewFinding[]=editor.issues.map(issue=>({finding_id:issue.id,report_id:reportId,
  dimension:/财务|数据|金额|比例|financial/i.test(issue.category)?'financial':/公开|舆情|public/i.test(issue.category)?'public':'compliance',
  conclusion:issue.uncertain||issue.missing.trim()?'needs_evidence':'manual',severity:'P2',title:limit(issue.title.trim()||issue.id),
  description:limit([issue.category,issue.reason,issue.original&&'原文：'+issue.original,issue.evidence&&'报告所述依据（待核）：'+issue.evidence,issue.missing&&'待补充：'+issue.missing].filter(Boolean).join('\n').trim())||limitation,
  target_refs:[],evidence_refs:[],...(issue.replacement.trim()?{suggested_change:limit(issue.replacement)}:{}),
  limitations:[limitation,...(issue.limitation.trim()?[limit(issue.limitation)]:[])],
  repairability:{can_revise:false,reason:limitation,allowed_record_ids:[]},origin_report_id:reportId,check_status:'rechecked'}));
 const coverage:ReviewReport['coverage']=findings.map((finding,index)=>({check_id:'file-'+index,dimension:finding.dimension,
  outcome:finding.conclusion==='needs_evidence'?'needs_evidence':'manual',reason:finding.description,finding_ids:[finding.finding_id],
  evidence_refs:[],rule_refs:[],origin_report_id:reportId,check_status:'rechecked'}));
 const report:ReviewReport={report_id:reportId,project_id:input.projectId,run_id:input.runId,input_revision:input.inputRevision,
  version:input.version,source_material:input.source,scope:{mode:input.operation,finding_ids:input.findingIds},findings,coverage,
  limitations:[limitation,...editor.warnings.filter(w=>w.trim()).slice(0,199).map(limit)],created_at:input.createdAt};
 if(input.operation==='differential_review'){
  if(!input.sourceReportId||!input.sourceReportSha256)throw Error('INPUT_REVISION_CONFLICT');
  report.follow_up={version:'review-follow-up-v1',source_report_id:input.sourceReportId,source_report_sha256:input.sourceReportSha256,
   findings:input.findingIds.map((id,index)=>{
    const linked=editor.issues.flatMap((issue,i)=>issue.source_finding_id===id?[i]:[]);
    if(linked.length===1){
      const current=findings[linked[0]!]!;
      return {source_finding_id:id,current_finding_ids:[current.finding_id],coverage_check_ids:['file-'+linked[0]],
        status:'rechecked' as const,outcome:current.conclusion==='needs_evidence'?'needs_evidence' as const:'manual' as const,
        reason:'本轮意见已明确对应所选原问题；材料和结论的限制保留，不能据此认定问题已解决。'};
    }
    // R001-style editor IDs are local to an edition, not cross-edition identities.
    // Without an explicit immutable mapping, do not claim a new issue closes an old one.
    const checkId='follow-up-'+index;
    coverage.push({check_id:checkId,dimension:'compliance',outcome:'uncovered',reason:'本轮文件意见未提供可确定对应的结构化闭环结论，不能以未列出推定问题已解决。',finding_ids:[],evidence_refs:[],rule_refs:[],origin_report_id:reportId,check_status:'rechecked'});
    return {source_finding_id:id,current_finding_ids:[],coverage_check_ids:[checkId],status:'uncompleted',outcome:'uncovered',reason:'请核对本轮复核文件；未确认问题已解决。'};
   })};
 }
 if(!isReviewReport(report))throw Error('REVIEW_REPORT_INVALID');
 return report;
}

/** Called after artifact promotion and before success, under the existing job lease. */
export async function registerFileReviewReport(ctx:Pick<StageContext,'pool'|'run'|'lease'>):Promise<boolean>{
 const row=(await ctx.pool.query(`SELECT i.manifest,e.snapshot,e.sha256,e.created_at FROM bb_input_revisions i
  LEFT JOIN bb_review_editors e ON e.owner_user_id=i.owner_user_id AND e.project_id=i.project_id AND e.run_id=$4
  WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.revision=$3`,[ctx.run.owner_user_id,ctx.run.project_id,ctx.run.input_revision,ctx.run.id])).rows[0];
 const review=row?.manifest?.review;
 if(review?.file_delivery?.version!=='review-correction-v2'||!['full_review','differential_review'].includes(review.operation))return true;
 if(!Value.Check(ReviewEditorSnapshotSchema,row.snapshot)||inputManifestHash(row.snapshot)!==row.sha256?.trim()
   ||row.snapshot.source_sha256!==review.input.source_material_ref?.sha256)throw Error('INPUT_REVISION_CONFLICT');
 const report=fileReviewReport({reportId:review.report_id,projectId:ctx.run.project_id,runId:ctx.run.id,inputRevision:ctx.run.input_revision,
  version:review.version_number,source:review.input.source_material_ref,operation:review.operation,findingIds:review.finding_ids,
  sourceReportId:review.source_report_id,sourceReportSha256:review.source_report_sha256,createdAt:new Date(row.created_at).toISOString()},row.snapshot);
 return registerReviewReport(ctx,report);
}
