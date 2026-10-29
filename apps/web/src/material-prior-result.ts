import {M4ArtifactPinSchema,type M4Artifact,type M4ArtifactPin,type M4Task,type M4Workspace} from './billing-types.js';
import {Value} from '@sinclair/typebox/value';

export type MaterialPriorResult={mode:'base'|'history'|'none';artifact?:M4Artifact;pin?:M4ArtifactPin;reason?:string};
export const materialPriorPinKey=(pin:M4ArtifactPin)=>JSON.stringify([pin.source_project_id,pin.artifact_id,pin.artifact_version,pin.sha256]);
/** Public persisted timestamps, never array order, revision number or run.updated_at. */
export function materialPriorTime(value:string):number|null{
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!m)return null;
  const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number),leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)return null;
  const epoch=Date.parse(value);return Number.isFinite(epoch)?epoch:null;
}
const pinOf=(a:M4Artifact):M4ArtifactPin=>({source_project_id:a.source_project_id,artifact_id:a.artifact_id,artifact_version:a.artifact_version,sha256:a.sha256});
/** Select a read target for this task, without changing any input or persisted state. */
export function materialPriorResult(task:M4Task,workspace:Pick<M4Workspace,'topic'|'artifacts'>):MaterialPriorResult{
  if(task.manifest.kind!=='document')return {mode:'none',reason:'此任务没有可定位的同类材料成果。'};
  const input=task.manifest.input,base=input.edit_base;
  if(task.manifest.topic_id!==workspace.topic.topic_id||task.run.project_id!==workspace.topic.project_id)return {mode:base?'base':'none',pin:base?{...base}:undefined,reason:'原任务与本工作区的归属暂不可核实，未自动打开成果。原引用保留，请重新核对任务记录。'};
  const inScope=(a:M4Artifact)=>Value.Check(M4ArtifactPinSchema,pinOf(a))&&a.kind==='document'&&a.document_type===input.document_type&&a.topic_id===workspace.topic.topic_id&&a.source_project_id===workspace.topic.project_id&&a.run_id!==task.run.run_id;
  // The existing artifact tab identity uses id/version. Any collision would make its first-match lookup ambiguous.
  const uniqueTab=(a:M4Artifact)=>workspace.artifacts.filter(b=>b.artifact_id===a.artifact_id&&b.artifact_version===a.artifact_version).length===1;
  if(base){
    const matches=workspace.artifacts.filter(a=>materialPriorPinKey(a)===materialPriorPinKey(base));
    if(!Value.Check(M4ArtifactPinSchema,base)||matches.length!==1||!inScope(matches[0])||!uniqueTab(matches[0]))return {mode:'base',pin:{...base},reason:'本工作区内暂无法准确定位这份固定底稿。原引用保留，请核对准确引用与已有成果；不会改用其他稿件。'};
    return {mode:'base',pin:pinOf(matches[0]),artifact:matches[0]};
  }
  const cutoff=materialPriorTime(task.created_at);
  if(cutoff===null)return {mode:'none',reason:'本任务的提交时间暂不可核实，未自动选择此前成果。可返回材料查看已有成果。'};
  const candidates=workspace.artifacts.filter(inScope).map(artifact=>({artifact,time:materialPriorTime(artifact.created_at)})).filter((a):a is {artifact:M4Artifact;time:number}=>a.time!==null&&a.time<cutoff);
  if(!candidates.length)return {mode:'none',reason:'本任务提交前暂无可准确定位的同类成果。可返回材料查看已有成果。'};
  const time=Math.max(...candidates.map(a=>a.time)),latest=candidates.filter(a=>a.time===time);
  if(latest.length!==1||!uniqueTab(latest[0].artifact))return {mode:'none',reason:'最近的同类成果记录存在歧义，未自动选择稿件。可返回材料核对文件名与版本。'};
  return {mode:'history',pin:pinOf(latest[0].artifact),artifact:latest[0].artifact};
}
