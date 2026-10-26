import type { Dto } from '../src/api';
import { schemas } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
type Task=Dto<'ProjectTasksResponse'>['items'][number];
export function taskPage(projectId:string,runs:Pick<Dto<'RunResponse'>,'run_id'|'project_id'|'state'|'stage'|'artifact_id'|'updated_at'>[],kind:Task['kind']='update',extra:Partial<Task>={}){
 return {project_id:projectId,items:runs.map(r=>({run_id:r.run_id,project_id:r.project_id,kind,state:r.state,stage:r.stage,artifact_id:r.artifact_id??null,created_at:r.updated_at,updated_at:r.updated_at,report_id:null,topic_id:null,document_type:null,operation:null,...extra})),page:{has_more:false,next_cursor:null as string|null}};
}

/** A read-only empty preparation for older synthetic HTTP fixtures; never saves or adopts. */
export function emptySupplementPreparation(run:Pick<Dto<'RunResponse'>,'run_id'|'project_id'|'input_revision'|'input_hash'>,
 base:Dto<'RunSupplementMaterial'>[],canSave:boolean):Dto<'RunSupplementDraftResponse'>{
 const response:Dto<'RunSupplementDraftResponse'>={run_id:run.run_id,project_id:run.project_id,revision:0,latest_revision:0,
  request_id:null,saved_at:null,base_input_revision:run.input_revision,base_input_hash:run.input_hash,
  base_materials:base,changes:[],result_materials:structuredClone(base),can_save:canSave,
  blocked_reason:canSave?null:'请先手动暂停任务，等待已有工作保存完毕后再准备补充材料。',adopted:false};
 if(!Value.Check(schemas.RunSupplementDraftResponse,response))throw new Error('Invalid synthetic empty supplement preparation');
 return response;
}
