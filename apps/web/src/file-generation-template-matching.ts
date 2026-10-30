import type {FileGenerationPreparation, FileTemplateMatch, FileTemplateSet} from './billing-types';

// Selecting a package adopts its unambiguous suggestions. Never replace a manual
// choice, choose between alternatives, or add an unselected catalogue entry.
export function applyTemplateSuggestions(preparation: FileGenerationPreparation, matches: FileTemplateMatch[], set?: FileTemplateSet): number {
  if (!set || set.set_id !== preparation.template_set_id) return 0;
  const selected = new Set(preparation.item_ids);
  let count = 0;
  for (const match of matches) {
    if (!selected.has(match.item_id) || preparation.mappings[match.item_id] || match.status !== 'suggested' || match.candidates.length !== 1) continue;
    const candidate = match.candidates[0];
    if (candidate.set_id !== set.set_id || !set.records.some(record => record.document_type === 'workpaper' && record.record_id === candidate.record_id && record.sha256 === candidate.sha256)) continue;
    preparation.mappings[match.item_id] = {...candidate};
    count++;
  }
  return count;
}
