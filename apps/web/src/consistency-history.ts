import {ProjectFileCheckSchema,type ProjectFileCheck} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {ApiClient} from './api';
import {UserFacingError} from './user-facing-error';

// Keep the recent list bounded. An explicit link may read one older check,
// but must never substitute another run or resolve an ambiguous response.
export async function linkedConsistencyCheck(api:ApiClient,project:string,run:string,recent:ProjectFileCheck[],signal:AbortSignal):Promise<ProjectFileCheck>{
  const matches=recent.filter(check=>check.run_id===run);
  if(matches.length>1)throw new UserFacingError('原检查记录无法唯一对应，请重新读取。');
  const check:unknown=matches.length===1?matches[0]:(await api.request<{check:ProjectFileCheck}|null>('GET',
    '/projects/'+encodeURIComponent(project)+'/project-files/checks/'+encodeURIComponent(run),undefined,{},signal))?.check;
  if(!Value.Check(ProjectFileCheckSchema,check)||check.run_id!==run)throw new UserFacingError('读取的记录与原检查不一致，请重新读取。');
  return check;
}

export async function linkedConsistencyUpdateCheck(api:ApiClient,project:string,run:string,recent:ProjectFileCheck[],signal:AbortSignal):Promise<ProjectFileCheck>{
  const matches=recent.flatMap(check=>check.updates.filter(update=>update.run_id===run).map(()=>check));
  if(matches.length>1)throw new UserFacingError('原文件更新任务无法唯一对应检查，请重新读取。');
  const check:unknown=matches.length===1?matches[0]:(await api.request<{check:ProjectFileCheck}|null>('GET',
    '/projects/'+encodeURIComponent(project)+'/project-files/updates/'+encodeURIComponent(run)+'/check',undefined,{},signal))?.check;
  if(!Value.Check(ProjectFileCheckSchema,check)||check.updates.filter(update=>update.run_id===run).length!==1)
    throw new UserFacingError('读取的检查与原文件更新任务不一致，请重新读取。');
  return check;
}
