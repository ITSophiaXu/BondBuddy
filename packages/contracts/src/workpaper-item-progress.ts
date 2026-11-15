import {Type,type Static} from '@sinclair/typebox';

/** Host-observed phases only: no prompt, checkpoint, CLI output or supplier payload. */
export const WorkpaperItemProgressSchema=Type.Object({
 phase:Type.Union([Type.Literal('queued'),Type.Literal('preparing_materials'),Type.Literal('generating'),Type.Literal('writing_files'),Type.Literal('validating'),Type.Literal('delivering'),Type.Literal('settling')]),
 started_at:Type.String({format:'date-time'}),
 updated_at:Type.String({format:'date-time'}),
 // This reports an expired execution lease, never an estimate from model silence.
 interrupted:Type.Boolean()
},{additionalProperties:false});
export type WorkpaperItemProgress=Static<typeof WorkpaperItemProgressSchema>;
export const WORKPAPER_PROGRESS_LABELS:Record<WorkpaperItemProgress['phase'],string>={
 queued:'排队等待',preparing_materials:'读取和准备募集说明书资料',generating:'模型正在编制',
 writing_files:'正在生成 Word 文件',validating:'正在检查生成文件',delivering:'正在保存成果',settling:'正在完成结算'
};
