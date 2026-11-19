import { UserFacingError } from './user-facing-error.js';
import { ApiError, friendlyError, errorReference, type ApiClient } from './api.js';
import { esc } from './ui.js';

export type RestartTask = {run_id:string;state:string;stage?:string|null};
export const TASK_RESTARTED_EVENT = 'bondbuddy:task-restarted';
export const RESTART_QUEUED_MESSAGE = '已重新启动，正在排队；获得执行名额后从已保存进度继续。';

/** The queue remains authoritative; these known waits must never bypass reconciliation. */
export function restartPolicy(run: RestartTask, availablePoints?: number|string) {
  const waits: Record<string,string> = {
    provider_reconcile:'本次模型调用结果或用量正在核对，核对完成后可恢复原任务。',
    billing_reconcile:'原任务账务正在核对，核对完成后可恢复；已保存进度保留。',
    awaiting_materials:'正在等待本轮材料处理完成，条件满足后会恢复原任务。',
    trial_limit:'当前处理额度或服务受到限制，限制解除后会恢复原任务。',
  };
  const credits = run.stage === 'credits_exhausted' && availablePoints !== undefined && BigInt(availablePoints) === 0n;
  const reason = run.state === 'paused' ? waits[run.stage ?? ''] ?? (credits ? '当前积分不足，积分到账后可继续原任务。' : undefined) : undefined;
  return { visible:run.state === 'paused', blocked:!!reason, reason,
    hint:run.stage === 'credits_exhausted'?'积分充足后从已保存进度继续':'从已保存进度继续' };
}

export function taskRestartHtml(run: RestartTask, options:{availablePoints?:number|string;compact?:boolean}={}) {
  const policy=restartPolicy(run,options.availablePoints);
  if(!policy.visible)return '';
  return '<div class="task-restart'+(options.compact?' compact':'')+'" data-task-restart="'+esc(run.run_id)+'">'
    +'<div class="task-restart-actions"><button type="button" class="btn primary button" data-restart-run="'+esc(run.run_id)+'" data-restart-blocked="'+policy.blocked+'" '+(policy.blocked?'disabled':'')+'>重新启动</button>'
    +'<button type="button" class="text-button" data-restart-refresh="'+esc(run.run_id)+'">检查恢复状态</button></div>'
    +'<p class="task-restart-hint" role="status">'+esc(policy.reason??policy.hint)+'</p></div>';
}

type RestartApi=Pick<ApiClient,'run'|'runAction'>;
/** Read first; a second tab or an uncertain POST is resolved against the same run, never execute. */
export async function restartSavedTask(api:RestartApi,id:string,signal:AbortSignal,current:()=>boolean) {
  const run=await api.run(id,signal);
  if(!current())return undefined;
  if(run.run_id!==id)throw new ApiError(0,'DATA_UNAVAILABLE');
  if(run.state!=='paused')return run;
  const policy=restartPolicy(run);
  if(policy.blocked)return run;
  try {
    const result=await api.runAction(id,'resume',signal);
    if(result.run_id!==id||result.project_id!==run.project_id)throw new ApiError(0,'DATA_UNAVAILABLE');
    return result;
  } catch(error) {
    if(!current()||signal.aborted)throw error;
    if(error instanceof ApiError && [401,403,404].includes(error.status))throw error;
    const latest=await api.run(id,signal).catch(()=>undefined);
    if(latest&&latest.run_id===id&&latest.project_id===run.project_id&&latest.state!=='paused')return latest;
    throw error;
  }
}

/** Batch resume retains finished files and the original paused child executions. */
export async function restartBatchItems(api:RestartApi,items:readonly {run_id:string|null;state:string}[],signal:AbortSignal,current:()=>boolean) {
  const ids=[...new Set(items.filter(item=>item.run_id&&item.state==='paused').map(item=>item.run_id!))];
  for(const id of ids){
    const run=await restartSavedTask(api,id,signal,current);
    if(!current())return false;
    if(!run||['paused','awaiting_input'].includes(run.state))throw new UserFacingError(run&&restartPolicy(run).reason||'本项尚未恢复，请先检查此项任务状态或补充信息。');
  }
  return true;
}

/** One owner-bound delegated handler also covers status cards rendered after polling. */
export function installTaskRestart(api:RestartApi,owner:()=>string|undefined) {
  const pending=new Set<string>();
  const sync=(id:string,busy:boolean)=>{
    document.querySelectorAll<HTMLButtonElement>('[data-restart-run],[data-restart-refresh]').forEach(b=>{
      if((b.dataset.restartRun??b.dataset.restartRefresh)!==id)return;
      b.disabled=busy||b.dataset.restartBlocked==='true';
      if(b.dataset.restartRun)b.textContent=busy?'正在启动…':'重新启动';
    });
  };
  document.addEventListener('click',event=>{
    const button=(event.target as Element)?.closest<HTMLButtonElement>('[data-restart-run],[data-restart-refresh]');
    if(!button||button.disabled)return;
    event.preventDefault();event.stopImmediatePropagation();
    const id=button.dataset.restartRun??button.dataset.restartRefresh!,root=button.closest<HTMLElement>('[data-task-restart]');
    const user=owner();if(!root||!user||pending.has(id))return;
    const signal=new AbortController().signal,current=()=>owner()===user&&root.isConnected;
    const message=(text:string)=>{if(current())root.querySelector<HTMLElement>('[role="status"]')!.textContent=text;};
    pending.add(id);sync(id,true);message(button.dataset.restartRefresh?'正在读取原任务状态…':'正在检查恢复条件…');
    void (async()=>{
      try {
        const run=button.dataset.restartRefresh?await api.run(id,signal):await restartSavedTask(api,id,signal,current);
        if(!current()||!run)return;
        if(run.run_id!==id)throw new ApiError(0,'DATA_UNAVAILABLE');
        const policy=restartPolicy(run);
        const restart=root.querySelector<HTMLButtonElement>('[data-restart-run]')!;
        restart.dataset.restartBlocked=String(policy.blocked);
        if(run.state==='paused')message(policy.reason??'原任务仍处于暂停状态，可以重新启动；恢复时沿用原材料和计费规则。');
        else {
          restart.hidden=true;
          message(run.state==='queued'?RESTART_QUEUED_MESSAGE:run.state==='running'?'原任务已恢复处理，已保存进度保留。':'原任务状态已更新，请查看最新进度与成果。');
        }
        window.dispatchEvent(new CustomEvent(TASK_RESTARTED_EVENT,{detail:{run_id:id,project_id:run.project_id}}));
      } catch(error) {
        if(!current())return;
        const text=error instanceof ApiError&&error.code==='CAPABILITY_NOT_READY'
          ? '原任务的处理条件尚未恢复，可能需要核对调用结果或本轮输入。已保存进度保留，请检查恢复状态。'+errorReference(error)
          :error instanceof ApiError&&error.code==='INPUT_REVISION_CONFLICT'?'原任务状态已变化，请检查恢复状态；原材料和成果保留。'
          :error instanceof ApiError&&error.status===0?'启动结果尚未确认，请检查原任务状态；无需创建新任务。':friendlyError(error);
        message(text);
      } finally {pending.delete(id);sync(id,false);}
    })();
  },true);
}

export function onTaskRestart(signal:AbortSignal,refresh:()=>unknown) {
  window.addEventListener(TASK_RESTARTED_EVENT,()=>{Promise.resolve().then(refresh).catch(()=>{/* Page polling retains its last known state. */});},{signal});
}
