import { schemas, type FirstDraftExclusionsResponse, type ProspectusVersions, type SourceMaterialPin } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';

/** The API's explicit none-baseline rejection is required before using this UI helper. */
export function canReviewFirstDraft(projectId: string, kind: string, materials: readonly SourceMaterialPin[], versions: ProspectusVersions): boolean {
  return kind === 'generation' && versions.project_id === projectId && versions.current_version_id === null &&
    Number.isSafeInteger(versions.selection_revision) && versions.selection_revision >= 0 && Array.isArray(versions.versions) &&
    !materials.some(m => ['historical', 'reference', 'project_output'].includes(m.role));
}
export function checkedFirstDraftExclusions(value: unknown, projectId: string, draftRevision: number): FirstDraftExclusionsResponse | null {
  return Value.Check(schemas.FirstDraftExclusionsResponse, value) && value.project_id === projectId && value.project_kind === 'generation'
    && value.draft_revision === draftRevision && value.excluded_historical.length > 0 &&
    new Set(value.excluded_historical.map(p => JSON.stringify([p.material_id, p.material_version]))).size === value.excluded_historical.length ? value : null;
}
export function sameFirstDraftExclusions(a: FirstDraftExclusionsResponse, b: FirstDraftExclusionsResponse): boolean {
  const key = (value: FirstDraftExclusionsResponse) => JSON.stringify([value.project_id, value.project_kind, value.draft_revision, value.scope,
    value.excluded_historical.map(p => [p.material_id, p.material_version, p.sha256, p.filename]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  return key(a) === key(b);
}
