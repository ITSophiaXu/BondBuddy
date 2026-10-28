import type { Pool, PoolClient } from 'pg';
import type { ReviewDraftInput } from '@bondbuddy/contracts';

/** Use saved business roles, never filename guesses or all attachments from another workflow. */
export async function reviewNonEvidenceMaterialIds(db: Pool | PoolClient, owner: string, project: string): Promise<Set<string>> {
  const rows = (await db.query(`WITH RECURSIVE originals(id) AS (
      SELECT q.manifest#>>'{source,asset,pin,material_id}' FROM bb_project_qa_runs q
        WHERE q.owner_user_id=$1 AND q.manifest#>>'{source,asset,kind}'='material'
      UNION SELECT material->>'material_id' FROM bb_workpaper_catalogues WHERE owner_user_id=$1
      UNION SELECT material->>'material_id' FROM bb_m4_templates WHERE owner_user_id=$1
      UNION SELECT asset#>>'{pin,material_id}' FROM bb_project_file_versions
        WHERE owner_user_id=$1 AND asset->>'kind'='material'
    ), excluded(id) AS (
      SELECT id FROM originals
      UNION
      SELECT c.material_id FROM bb_update_material_copies c JOIN excluded e ON e.id=c.source_material_id
      WHERE c.owner_user_id=$1 AND c.material_id IS NOT NULL
    ) SELECT DISTINCT m.id FROM bb_material_versions m JOIN excluded e ON e.id=m.id
      WHERE m.owner_user_id=$1 AND m.project_id=$2`, [owner, project])).rows;
  return new Set(rows.map(row => row.id));
}

/** Only the editable draft is cleaned; immutable executions and QA originals stay intact. */
export function withoutWorkflowMaterials<T extends ReviewDraftInput>(input: T, excluded: Set<string>): T {
  return { ...input,
    source_material_ref: input.source_material_ref && excluded.has(input.source_material_ref.material_id) ? null : input.source_material_ref,
    material_versions: input.material_versions.filter(pin => !excluded.has(pin.material_id)),
    ...(input.evidence_links ? { evidence_links: input.evidence_links.filter(link => !excluded.has(link.material_ref.material_id)) } : {}),
  };
}
