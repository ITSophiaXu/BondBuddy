import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceProspectus, UpdateDetails, ProjectMessageSetPin, Market, Offering, FormatTemplatePin, SourceFormatPolicy, UnifiedAuthoringInput, ProspectusVersions } from '@bondbuddy/contracts';
import { isMarketOffering, hasAuthoringAudit, AUDIT_REPORT_REQUIRED_MESSAGE, sourceProspectusInputGaps, recommendFormatTemplate, sameFormatTemplate, hasAuthoringSource, SOURCE_PROSPECTUS_REQUIRED_MESSAGE, type SourceMaterialPin } from '@bondbuddy/contracts';
import type { PoolClient } from 'pg';
import { nafmiiMtnDraftRulePack, nafmiiMtnChapterTemplate, nafmiiCpDraftRulePack, nafmiiCpChapterTemplate, nafmiiScpDraftRulePack, nafmiiScpChapterTemplate } from '@bondbuddy/domain';
import { conflict, digest, missing, Problem } from './data.js';

const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
export { isUnifiedInput } from '@bondbuddy/contracts';
/** previousOutput must come from the owned, validated continuation or locked snapshot. */
export function assertAuthoringSourceRequired(materials: readonly SourceMaterialPin[], previousOutput?: UnifiedAuthoringInput['previous_output']) {
  if (!hasAuthoringSource(materials, Boolean(previousOutput)))
    throw Object.assign(new Problem(422, 'INPUT_REQUIRED', SOURCE_PROSPECTUS_REQUIRED_MESSAGE), { sourceProspectusRequired: true });
}
export function assertAuthoringAuditRequired(materials: readonly SourceMaterialPin[]) {
  if (!hasAuthoringAudit(materials))
    throw Object.assign(new Problem(422, 'INPUT_REQUIRED', AUDIT_REPORT_REQUIRED_MESSAGE), { auditReportRequired: true });
}
export function assertAuthoringSourceInformation(materials: readonly SourceMaterialPin[], sources: readonly SourceProspectus[] = []) {
  const gaps = sourceProspectusInputGaps(materials, sources);
  if (gaps.length) throw new Problem(422, 'INPUT_REQUIRED', `请在材料页补齐 ${gaps.length} 份历史／参考募集书的信息：${[...new Set(gaps.flatMap(g => g.missing))].join('、')}，保存后再继续。`);
}
type FormatMaterial = SourceMaterialPin & { media_type?: string };
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
type AuthoringEditBase = { artifact_id: string; artifact_version: number; sha256: string };
/** An adopted clean result cannot become first draft; explicit result choices keep their trusted verification. */
export function lockProspectusEditBase(current: Pick<ProspectusVersions['versions'][number], 'artifact_id' | 'artifact_version' | 'sha256'> | undefined,
  requested: AuthoringEditBase | null | undefined): AuthoringEditBase | null | undefined {
  if (!current) return requested;
  if (!current.artifact_id) return requested === undefined ? null : requested;
  if (requested === null)
    throw conflict('INPUT_REVISION_CONFLICT', '当前已采用清洁稿，请使用当前稿默认基线，或选择准确的历史成果后重新开始。');
  // A viewed successful historical result may differ from current. The existing
  // owner/quality/source/issuer checks below input locking verify its exact pin.
  if (requested !== undefined) return requested;
  const selected = { artifact_id: current.artifact_id, artifact_version: current.artifact_version!, sha256: current.sha256 };
  if (!Number.isSafeInteger(selected.artifact_version) || selected.artifact_version < 1 || !/^[a-f0-9]{64}$/.test(selected.sha256))
    throw conflict('INPUT_REVISION_CONFLICT', '当前已采用的清洁稿版本无法确认，请刷新后重新开始。');
  return selected;
}
/** Called under the project draft lock. Foreign and unknown material references share 404. */
export async function assertOwnedFormatTemplate(client: Pick<PoolClient, 'query'>, owner: string, projectId: string,
  pin: FormatTemplatePin | null | undefined): Promise<void> {
  if (!pin) return;
  const result = await client.query(`SELECT role,media_type,sha256 FROM bb_material_versions
    WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL FOR SHARE`,
  [owner, projectId, pin.material_id, pin.material_version]);
  if (result.rows.length !== 1) throw missing();
  const row = result.rows[0];
  if (!['historical', 'reference'].includes(row.role) || ![DOCX, 'application/pdf'].includes(row.media_type) || String(row.sha256).trim() !== pin.sha256)
    throw conflict('INPUT_REVISION_CONFLICT', '所选格式模板与原稿版本不一致，请重新选择。');
}
/** A pin can only refer to selected, already owner-checked materials. */
export function lockSourceFormatPolicy(details: UpdateDetails, materials: readonly FormatMaterial[], adoptedSource?: FormatTemplatePin): SourceFormatPolicy {
  const explicit = details.format_template;
  const adopted = adoptedSource ? materials.find(m => sameFormatTemplate(m, adoptedSource)) : undefined;
  if (adoptedSource && (!adopted || !['historical', 'reference'].includes(adopted.role) || ![DOCX, 'application/pdf'].includes(adopted.media_type ?? '')))
    throw conflict('INPUT_REVISION_CONFLICT', '已采用原稿未包含在本次材料中，或其版本已经变化，请刷新后重新开始。');
  if (adoptedSource && explicit && !sameFormatTemplate(explicit, adoptedSource))
    throw conflict('INPUT_REVISION_CONFLICT', '格式模板与当前已采用原稿不同，请清除旧格式选择，或改用对应原稿后重新开始。');
  const selected = adopted ?? (explicit ? materials.find(m => sameFormatTemplate(m, explicit)) : recommendFormatTemplate(materials, details.source_prospectuses));
  if (explicit && (!selected || !['historical', 'reference'].includes(selected.role) || ![DOCX, 'application/pdf'].includes(selected.media_type ?? '')))
    throw conflict('INPUT_REVISION_CONFLICT', '所选格式模板未包含在本次材料中，或其版本已经变化。');
  if (!selected) return { version: 'source-format-v1', mode: 'new_document', template: null, selection: 'automatic' };
  return { version: 'source-format-v1', mode: selected.media_type === DOCX ? 'preserve_docx' : 'reconstruct_pdf',
    template: { kind: 'material', material_id: selected.material_id, material_version: selected.material_version, sha256: selected.sha256 },
    selection: explicit ? 'explicit' : 'automatic' };
}
/** The selected clean result remains both the editing base and the inherited format reference. */
export function inheritPreviousOutputFormat(authoring: UnifiedAuthoringInput): void {
  if (authoring.previous_output) authoring.format_policy = { version: 'source-format-v1', mode: 'preserve_docx',
    template: { kind: 'artifact', ...authoring.previous_output }, selection: 'previous_output' };
}
export async function lockUnifiedAuthoring(project: { market: Market | null; offering: Offering | null; update_details: UpdateDetails },
  materials: readonly FormatMaterial[], messages: ProjectMessageSetPin, adoptedSource?: FormatTemplatePin) {
  const sources: SourceProspectus[] = [];
  for (const source of project.update_details.source_prospectuses ?? []) {
    const pin = materials.find(m => m.material_id === source.material_id);
    if (!pin) continue; // A removed/deselected material cannot become task input.
    if (!['historical', 'reference'].includes(pin.role) || pin.material_version !== source.material_version || pin.sha256 !== source.sha256)
      throw conflict('INPUT_REVISION_CONFLICT', 'Source declaration does not match selected material version');
    sources.push(structuredClone(source));
  }
  const knowledge = await loadAuthoringKnowledge(project);
  return { version: 'unified_v1' as const, source_prospectuses: sources, requirements: messages.members, knowledge,
    format_policy: lockSourceFormatPolicy(project.update_details, materials, adoptedSource),
    knowledge_status: 'authoring_reference_not_compliance_approval' as const };
}

/** Shared source selection; callers persist the returned bytes in their input snapshot. */
export async function loadAuthoringKnowledge(project: { market: Market | null; offering: Offering | null }, purpose: 'authoring' | 'review' = 'authoring') {
  const knowledge: { path: string; sha256: string; markdown: string }[] = [];
  if (project.market && project.offering && isMarketOffering(project.market, project.offering)) {
    const paths = project.market === 'nafmii'
      ? ['knowledge/nafmii/APPLICABILITY.md', ...(['ppn', 'dfi'].includes(project.offering!) ? [`knowledge/nafmii/drafts/${project.offering}/README.md`] : []),
        ...(project.offering === 'ppn' && purpose === 'authoring' ? ['knowledge/nafmii/drafts/ppn/writing-20261013/writing-framework.md'] : [])]
      : [`knowledge/exchange-bonds/drafts/${project.market}-${project.offering}/README.md`, 'knowledge/exchange-bonds/共通方法与差异.md', 'knowledge/exchange-bonds/冲突与未覆盖项.md'];
    for (const path of paths) {
      const markdown = await readFile(resolve(repo, path), 'utf8');
      knowledge.push({ path, sha256: digest(markdown), markdown });
    }
    if (project.market === 'nafmii' && ['mtn', 'cp', 'scp'].includes(project.offering!)) {
      const assets = { mtn: [nafmiiMtnDraftRulePack, nafmiiMtnChapterTemplate], cp: [nafmiiCpDraftRulePack, nafmiiCpChapterTemplate], scp: [nafmiiScpDraftRulePack, nafmiiScpChapterTemplate] }[project.offering as 'mtn' | 'cp' | 'scp']!;
      const markdown = `# ${project.offering!.toUpperCase()} 编制知识\n来源：现有独立品种规则及章节模板。状态保留，不表示合规审核通过。\n\n\`\`\`json\n${JSON.stringify(assets, null, 2)}\n\`\`\``;
      knowledge.push({ path: `packages/domain/src/nafmii-${project.offering}.ts`, sha256: digest(markdown), markdown });
    }
  }
  return knowledge;
}
