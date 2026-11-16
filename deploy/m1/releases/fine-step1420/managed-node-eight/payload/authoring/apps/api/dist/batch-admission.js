import { conflict } from './data.js';
export const SHARED_BATCH_CAPACITY = 8;
const terminal = ['succeeded', 'failed', 'cancelled', 'rejected', 'test_completed'];
/** Caller holds the frozen batch row; canonical scope serializes all admissions. */
export async function assertBatchAdmission(c, owner, scope, batch, item) {
    if (!(await c.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL AND archived_at IS NULL FOR NO KEY UPDATE NOWAIT', [owner, scope])).rowCount)
        throw conflict('INPUT_REVISION_CONFLICT', '项目或来源已不可用。');
    const active = (await c.query(`SELECT bb_batch_child_identity(r.owner_user_id,r.project_id,r.input_revision,r.id,r.execution_request_id) AS membership
    FROM bb_runs r JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id
    WHERE r.owner_user_id=$1 AND COALESCE(p.execution_scope_project_id,p.id)=$2 AND r.task_kind<>'qa' AND NOT(r.state=ANY($3::text[]))`, [owner, scope, terminal])).rows;
    if (active.length >= SHARED_BATCH_CAPACITY || active.some(r => r.membership?.[0] !== batch || r.membership?.[1] === item))
        throw conflict('PROJECT_RUN_ACTIVE', '已有业务任务执行中。');
}
