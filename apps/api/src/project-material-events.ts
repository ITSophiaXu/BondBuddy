import type { PoolClient } from 'pg';
import { missing, uid } from './data.js';
export async function appendProjectMaterialEvent(client: PoolClient, ownerId: string, projectId: string, materialId: string, byteSize: number) {
  const allocated = await client.query('UPDATE bb_projects SET event_cursor=event_cursor+1 WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING event_cursor', [ownerId, projectId]);
  if (!allocated.rows[0]) throw missing();
  const payload = { material_id: materialId, uploaded_bytes: byteSize, total_bytes: byteSize };
  await client.query('INSERT INTO bb_project_events(id,owner_user_id,project_id,seq,trace_id,type,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [uid(), ownerId, projectId, allocated.rows[0].event_cursor, uid(), 'material.upload_progress', payload]);
}

