import test from 'node:test';
import assert from 'node:assert/strict';
import { loadM4RuntimeSkill, type M4SkillId } from './m4-runtime-skills.js';

test('M4 explicitly loads distinct trusted document and QA skills and rejects arbitrary IDs', () => {
  const ids: M4SkillId[] = ['m4-init-report', 'm4-private-summary', 'm4-underwriter', 'm4-legal', 'm4-project-qa', 'm4-workpaper-batch'];
  const skills = ids.map(loadM4RuntimeSkill);
  assert.equal(new Set(skills.map(s => s.sha256)).size, 6);
  for (const skill of skills) {
    assert.equal(skill.version, 'm4-runtime-skills-v1');
    assert.match(skill.sha256, /^[a-f0-9]{64}$/);
    assert.ok(skill.content.startsWith(`---\nname: ${skill.id}\n`));
    assert.ok(!skill.content.includes('\r'));
  }
  for (const id of ['../m3-review', '__proto__', 'missing'])
    assert.throws(() => loadM4RuntimeSkill(id as M4SkillId), /M4_SKILL_PIN_INVALID/);
});
