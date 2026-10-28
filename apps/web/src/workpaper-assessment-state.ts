import type {WorkpaperAssessment} from '@bondbuddy/contracts';

/** Host-owned copy only; never render raw provider errors or event payloads. */
export function assessmentPauseView(a:WorkpaperAssessment){
 const pause=a.pause;
 if(!pause)return {action:'refresh' as const,label:'刷新检查状态',message:'检查已暂停，暂停原因暂未读取到。请刷新检查状态；原目录和已完成进度保留。'};
 if(pause.stage==='provider_reconcile'){
  const errors:Record<string,string>={
   MODEL_TIMEOUT:'本次检查响应超时，正在核对已执行结果。',
   MODEL_RESULT_STORE_FAILED:'本次检查结果未能保存，需由服务端核对和恢复。',
   MODEL_USAGE_PENDING:'检查结果已返回，正在核对本次调用状态。',
   MODEL_PROVIDER_AUTH_FAILED:'检查服务的登录已失效，需由管理员恢复。',
   MODEL_PROVIDER_BALANCE_EXHAUSTED:'检查服务的额度不足，需由管理员恢复。',
  };
  return {action:'refresh' as const,label:'刷新检查状态',message:(errors[pause.error_code??'']??'检查执行中断，正在核对本次调用状态。')+' 原进度保留，请勿重复提交；恢复后会继续显示进度。'};
 }
 const reasons:Record<string,string>={
  user_paused:'本批检查已暂停。点击“继续检查”，从原任务接着处理。',
  model_tokens_per_user_per_day:'今日检查服务用量已达到上限，限制解除后可继续原检查；这项检查不收取生成积分。',
  kill_switch:'检查服务暂时停止接受新请求，恢复后可继续原检查。',
  material_parse_pending:'募集说明书仍在解析，处理完成后可继续检查。',
 };
 const stages:Record<string,string>={
  awaiting_materials:'检查所需材料尚未就绪。处理材料提示后，可继续原检查。',
  capability_not_ready:'检查执行条件尚未就绪。服务恢复后，可继续原检查。',
  trial_limit:'检查服务暂时达到使用限制，限制解除后可继续原检查。',
 };
 return {action:'resume' as const,label:'继续检查',message:reasons[pause.reason??'']??stages[pause.stage??'']??'检查已暂停。点击“继续检查”重试原任务，保留已完成进度。'};
}
