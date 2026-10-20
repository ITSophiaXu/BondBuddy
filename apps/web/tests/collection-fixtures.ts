import type { Dto } from '../src/api';
type Task=Dto<'ProjectTasksResponse'>['items'][number];
export function taskPage(projectId:string,runs:Pick<Dto<'RunResponse'>,'run_id'|'project_id'|'state'|'stage'|'artifact_id'|'updated_at'>[],kind:Task['kind']='update',extra:Partial<Task>={}){
 return {project_id:projectId,items:runs.map(r=>({run_id:r.run_id,project_id:r.project_id,kind,state:r.state,stage:r.stage,artifact_id:r.artifact_id??null,created_at:r.updated_at,updated_at:r.updated_at,report_id:null,topic_id:null,document_type:null,operation:null,...extra})),page:{has_more:false,next_cursor:null as string|null}};
}
