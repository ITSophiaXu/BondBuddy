/** Host-only evidence. It records a capture attempt, never permission to send a model request. */
export const FILE_AUTHORING_CAPTURE_VERSION = 'file-authoring-recovery-capture-v1' as const;
export const FILE_AUTHORING_CAPTURE_FAILURES = ['capacity_exceeded','unsafe_workspace','input_conflict','storage_failed','capture_failed'] as const;
export type FileAuthoringCaptureFailure = typeof FILE_AUTHORING_CAPTURE_FAILURES[number];
export type FileAuthoringCaptureOutcome =
  | { state:'saved'; failure_code:null }
  | { state:'failed'; failure_code:FileAuthoringCaptureFailure };
export type FileAuthoringCapture = {
  version:typeof FILE_AUTHORING_CAPTURE_VERSION;
  owner_user_id:string; project_id:string; run_id:string; job_id:string;
  input_revision:number; input_hash:string; attempt_id:string; logical_call_id:string;
  prepared_at:string;
  /** Host deadline fixed by the first modern intent for this logical call. */
  deadline_at?:string;
} & ({state:'prepared'; failure_code:null} | FileAuthoringCaptureOutcome);

/** Format validation only: an expired deadline remains valid durable evidence. */
export function isFileAuthoringDeadline(value:unknown):value is string {
  return typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
}
