import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceProspectus, UpdateDetails, ProjectMessageSetPin, Market, Offering } from '@bondbuddy/contracts';
import { isMarketOffering } from '@bondbuddy/contracts';
import { nafmiiMtnDraftRulePack, nafmiiMtnChapterTemplate, nafmiiCpDraftRulePack, nafmiiCpChapterTemplate, nafmiiScpDraftRulePack, nafmiiScpChapterTemplate } from '@bondbuddy/domain';
import { conflict, digest } from './data.js';

const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
export { isUnifiedInput } from '@bondbuddy/contracts';
export async function lockUnifiedAuthoring(project: { market: Market | null; offering: Offering | null; update_details: UpdateDetails },
  materials: readonly { material_id: string; material_version: number; role: string; sha256: string }[], messages: ProjectMessageSetPin) {
  const sources: SourceProspectus[] = [];
  for (const source of project.update_details.source_prospectuses ?? []) {
    const pin = materials.find(m => m.material_id === source.material_id);
    if (!pin) continue; // A removed/deselected material cannot become task input.
    if (!['historical', 'reference'].includes(pin.role) || pin.material_version !== source.material_version || pin.sha256 !== source.sha256)
      throw conflict('INPUT_REVISION_CONFLICT', 'Source declaration does not match selected material version');
    sources.push(structuredClone(source));
  }
  const knowledge: { path: string; sha256: string; markdown: string }[] = [];
  if (project.market && project.offering && isMarketOffering(project.market, project.offering)) {
    const paths = project.market === 'nafmii'
      ? ['knowledge/nafmii/APPLICABILITY.md', ...(['ppn', 'dfi'].includes(project.offering!) ? [`knowledge/nafmii/drafts/${project.offering}/README.md`] : [])]
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
  return { version: 'unified_v1' as const, source_prospectuses: sources, requirements: messages.members, knowledge,
    knowledge_status: 'authoring_reference_not_compliance_approval' as const };
}
