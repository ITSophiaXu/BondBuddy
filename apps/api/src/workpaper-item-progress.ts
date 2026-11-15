import type {WorkpaperItemProgress} from '@bondbuddy/contracts';

type ProgressRow={run_id?:string|null;run_state?:string|null;stage?:string|null;progress_stage?:string|null;progress_reason?:string|null;
 run_created_at?:Date|string|null;run_updated_at?:Date|string|null;last_event_at?:Date|string|null;lease_interrupted?:boolean|null};
const active=new Set(['queued','preparing','running','validating','delivering','settlement_pending']);
const reasons:Record<string,WorkpaperItemProgress['phase']>={
 m4_reading_materials:'preparing_materials',m4_document_working:'generating',m4_writing_files:'writing_files',m4_registering_artifacts:'delivering'
};
const stages:Record<string,WorkpaperItemProgress['phase']>={
 queued:'queued',claimed:'preparing_materials',input_lock:'preparing_materials',materials_ready:'preparing_materials',
 provider_call:'generating',word_delivery:'delivering',validation:'validating',validating:'validating',delivering:'delivering',settlement_pending:'settling'
};
const timestamp=(value:Date|string|null|undefined)=>{
 if(!value)return undefined;const parsed=new Date(value);return Number.isFinite(parsed.valueOf())?parsed.toISOString():undefined;
};
/** Preserve the last business phase while ordinary model activity only refreshes its timestamp. */
export function workpaperItemProgress(row:ProgressRow):WorkpaperItemProgress|undefined{
 if(!row.run_id||!row.run_state||!active.has(row.run_state))return undefined;
 const started_at=timestamp(row.run_created_at),updated_at=timestamp(row.last_event_at)??timestamp(row.run_updated_at)??started_at;
 if(!started_at||!updated_at)return undefined;
 const phase=row.run_state==='queued'?'queued':row.run_state==='validating'?'validating':row.run_state==='delivering'?'delivering':row.run_state==='settlement_pending'?'settling'
  :reasons[row.progress_reason??'']??stages[row.progress_stage??'']??stages[row.stage??'']??'preparing_materials';
 return {phase,started_at,updated_at,interrupted:row.run_state==='running'&&row.lease_interrupted===true};
}
