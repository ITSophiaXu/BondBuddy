import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type M4SkillId = 'm4-application' | 'm4-recommendation' | 'm4-init-report' | 'm4-private-summary' | 'm4-underwriter' | 'm4-legal' | 'm4-project-qa' | 'global-project-assistant';
const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const manifestHash = 'aee143f06ce089b6836b3a22e97d361171bfe1ca5c243c824594eae37e7a66d0';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Load only the bundled, pinned bytes; never discover personal CLI skills. */
export function loadM4RuntimeSkill(id: M4SkillId) {
  const bytes = readFileSync(resolve(root, 'apps/worker/skills/m4-runtime-manifest.json'));
  if (hash(bytes) !== manifestHash) throw Error('M4_SKILL_MANIFEST_CHANGED');
  const manifest = JSON.parse(bytes.toString('utf8')) as {version: string; skills: Record<M4SkillId, {path: string; sha256: string}>};
  const pin = Object.hasOwn(manifest.skills, id) ? manifest.skills[id] : null;
  if (manifest.version !== 'm4-runtime-skills-v1' || !pin || pin.path !== `apps/worker/skills/${id}/SKILL.md`)
    throw Error('M4_SKILL_PIN_INVALID');
  const content = readFileSync(resolve(root, pin.path));
  if (hash(content) !== pin.sha256) throw Error('M4_SKILL_CONTENT_CHANGED');
  return {id, version: manifest.version, sha256: pin.sha256, content: content.toString('utf8')};
}
