import { Value } from '@sinclair/typebox/value';
import { schemas, MARKETS, MARKET_LABELS, MARKET_OFFERINGS, OFFERING_LABELS, PROJECT_FIELD_LIMITS, emptyUpdateDetails, updateDetailsErrors, type Market, type Offering, type Project, type UpdateDetails } from './billing-types.js';
import type { Dto } from './api.js';
export type ProjectCreate = Dto<'ProjectCreateRequest'>;

/** No in-issuer history routes the project to the controlled new-draft (generation) path. */
export function projectKind(hasHistorical: boolean | null | undefined): 'generation' | 'update' {
  return hasHistorical === false ? 'generation' : 'update';
}
export function blankDraft(): ProjectCreate {
  return { name: '', kind: 'update', issuer_name: null, market: null, offering: null, update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', source_prospectuses: [] } };
}
export function generatedProjectName(issuer: string | null, market: Market | null, offering: Offering | null, purpose: 'update' | 'review' = 'update'): string {
  const name = issuer?.trim();
  if (!name) return '';
  const applicable = market && offering && (MARKET_OFFERINGS[market] as readonly Offering[]).includes(offering);
  const suffix = [market && MARKET_LABELS[market], applicable && OFFERING_LABELS[offering!], purpose === 'review' ? '募集书复核' : '募集书更新'].filter(Boolean).join('-');
  const limit = PROJECT_FIELD_LIMITS.name - suffix.length - 1;
  let prefix = '';
  for (const character of name) {
    if (prefix.length + character.length > limit) break;
    prefix += character;
  }
  return `${prefix}-${suffix}`;
}
export function draftFromProject(project: Project): ProjectCreate {
  return { name: project.name, kind: project.kind, issuer_name: project.issuer_name, market: project.market, offering: project.offering,
    update_details: structuredClone(project.update_details ?? emptyUpdateDetails()) };
}
export function changeMarket(draft: ProjectCreate, market: Market | null): { draft: ProjectCreate; cleared: boolean } {
  const offering = draft.offering;
  const valid = market !== null && offering !== null && (MARKET_OFFERINGS[market] as readonly Offering[]).includes(offering);
  return { draft: { ...draft, market, offering: valid ? offering : null }, cleared: offering !== null && !valid };
}
export function validateDraft(draft: ProjectCreate): string[] {
  if (!Value.Check(schemas.ProjectCreateRequest, draft)) return ['请核对文字长度、金额格式（非负数，最多六位小数）及必需的选项格式。'];
  if (draft.offering && (!draft.market || !(MARKET_OFFERINGS[draft.market] as readonly string[]).includes(draft.offering))) return ['发行方式与发行市场不匹配，请重新选择。'];
  return updateDetailsErrors(draft.update_details ?? emptyUpdateDetails()).map(error => error.message);
}
export function materialHints(details: UpdateDetails): string[] {
  if (details.authoring_mode === 'unified_v1') return ['发行人材料：审计报告、财务报表及附注等', '历史／参考募集书（选填）'];
  const hints = ['审计报告，或财务报表及附注'];
  if (details.has_historical === true) hints.unshift('本发行人的历史募集书');
  if (details.has_historical === false) hints.push('相似募集书（可选）');
  return hints;
}
export function marketValue(value: string): Market | null { return MARKETS.find(market => market === value) ?? null; }
