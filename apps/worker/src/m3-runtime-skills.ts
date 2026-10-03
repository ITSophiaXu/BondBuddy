import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type M3RuntimeSkillId = 'm3-review' | 'm3-public-review' | 'm3-review-revision' | 'm3-project-assistant';
export type M3RuntimeSkill = { id: M3RuntimeSkillId; version: string; sha256: string; content: string };
const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
const manifestPath = resolve(repo, 'apps/worker/skills/m3-runtime-manifest.json');
const manifestSHA = 'b4d2898a669561255c2df61731e50e9b7c502807bd7c3310eacec23231eaa853';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Explicit trusted injection: worker calls ignore user config and do not discover skills. */
export function loadM3RuntimeSkill(id: M3RuntimeSkillId): M3RuntimeSkill {
  const manifestBytes = readFileSync(manifestPath);
  if (hash(manifestBytes) !== manifestSHA) throw Error('M3_SKILL_MANIFEST_CHANGED');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    version: string; skills: Record<M3RuntimeSkillId, { path: string; sha256: string }>;
  };
  const pin = manifest.skills[id];
  if (manifest.version !== 'm3-runtime-skills-v1' || !pin || pin.path !== `apps/worker/skills/${id}/SKILL.md`)
    throw Error('M3_SKILL_PIN_INVALID');
  const bytes = readFileSync(resolve(repo, pin.path));
  if (hash(bytes) !== pin.sha256) throw Error('M3_SKILL_CONTENT_CHANGED');
  return { id, version: manifest.version, sha256: pin.sha256, content: bytes.toString('utf8') };
}
