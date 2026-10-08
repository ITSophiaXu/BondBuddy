import type { Run } from '@bondbuddy/contracts';
import { esc } from './ui.js';
import './task-progress.css';

/** Stages are host observations. Never infer percentages, completed checks or elapsed work. */
export function taskProgress(run: Run, kind: 'update'|'review'|'material', observed?: {title:string;summary:string;completed?:{label:string}[];phase?:0|1|2|3|4}) {
  const verb=kind==='review'?'复核':kind==='material'?'生成':'编制';
  const subject=kind==='material'?'材料':'募集书';
  const terminal=['succeeded','test_completed','failed','rejected','cancelled'].includes(run.state);
  const stage=run.stage??'';
  const phase=['queued','preparing'].includes(run.state)?0
    : ['succeeded','test_completed'].includes(run.state)?4
    : ['delivering','settlement_pending'].includes(run.state)||['word_delivery','word_delivery_pair'].includes(stage)?3
    : observed?.phase??(stage==='input_lock'||stage==='materials_ready'||kind!=='material'&&stage.endsWith('_prompt')?1:2);
  const labels=['等待开始','准备材料',`${verb}${subject}`,'准备下载','已完成'];
  const status:Partial<Record<Run['state'],string>>={paused:'任务已暂停',awaiting_input:'等待补充信息',failed:'本轮未完成',rejected:'本轮未启动',cancelled:'本轮已停止',test_completed:'内部测试稿已生成'};
  const title=status[run.state]??observed?.title??(phase===4?'文档已生成，可下载':labels[phase]);
  const stopped:Partial<Record<Run['state'],string>>={paused:'正在等待处理条件恢复，当前输入与已保存结果保留。',awaiting_input:'请核对任务提示，当前材料与要求保留。',failed:'本轮未完成，已保存的材料和已有成果保留。',rejected:'本轮未启动，请核对任务提示。',cancelled:'任务已停止，已保存的材料和已有成果保留。'};
  const summary=observed?.summary??stopped[run.state]??(phase===0?'任务已提交，等待执行名额，无需重复提交。':phase===1?'正在准备本次材料与要求。':phase===2?`正在根据材料${verb}${subject}，完成后会自动更新此页。`:phase===3?'正在保存文档并准备下载。':'');
  return `<section class="task-progress" data-input-revision="${run.input_revision}" aria-label="${verb}进度"><div class="task-progress-heading"><span class="task-progress-dot ${terminal?'terminal':''}" aria-hidden="true"></span><div><strong role="status">${esc(title)}</strong>${summary?`<p>${esc(summary)}</p>`:''}</div></div><ol class="task-progress-steps" aria-label="处理流程">${labels.map((label,i)=>`<li class="${i===phase?'current':''}" ${i===phase?'aria-current="step"':''}><span>${i+1}</span>${label}</li>`).join('')}</ol>${observed?.completed?.length?`<details><summary>查看已完成的处理</summary><ul>${observed.completed.map(a=>`<li>${esc(a.label)}</li>`).join('')}</ul></details>`:''}${!terminal&&!['paused','awaiting_input'].includes(run.state)?'<p class="task-progress-footnote">关闭页面后任务仍会继续，重新打开可查看最新进度。</p>':''}</section>`;
}
