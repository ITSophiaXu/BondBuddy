import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadM3RuntimeSkill, type M3RuntimeSkillId } from './m3-runtime-skills.js';

const skillIds: M3RuntimeSkillId[] = [
  'm3-review',
  'm3-public-review',
  'm3-review-revision',
  'm3-project-assistant',
];
const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

test('all four runtime skills load actual bundled bytes through the trusted manifest pins', async () => {
  const manifest = JSON.parse(
    await readFile(join(repo, 'apps/worker/skills/m3-runtime-manifest.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(manifest.skills).sort(), [...skillIds].sort());
  const hashes = new Set<string>();
  for (const id of skillIds) {
    const skill = loadM3RuntimeSkill(id),
      bytes = await readFile(join(repo, manifest.skills[id].path));
    assert.equal(skill.id, id);
    assert.equal(skill.version, 'm3-runtime-skills-v1');
    assert.equal(skill.sha256, manifest.skills[id].sha256);
    assert.equal(skill.sha256, sha256(bytes));
    assert.equal(skill.content, bytes.toString('utf8'));
    assert(skill.content.startsWith(`---\nname: ${id}\n`));
    assert(
      !skill.content.includes('\r'),
      'pinned skill bytes must be portable between Linux and Windows checkouts',
    );
    hashes.add(skill.sha256);
    assert.deepEqual(loadM3RuntimeSkill(id), skill);
  }
  assert.equal(hashes.size, 4, 'each task has its own explicit skill');
  for (const id of ['../../outside', 'missing', '__proto__'])
    assert.throws(() => loadM3RuntimeSkill(id as M3RuntimeSkillId), /M3_SKILL_PIN_INVALID/);
});

test('runtime loader rejects altered skill or manifest bytes in an isolated copy without modifying repository assets', async () => {
  const prefix = join(tmpdir(), 'bb-m3-skill-pins-'),
    directory = await mkdtemp(prefix);
  try {
    const dist = join(directory, 'apps/worker/dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    await cp(join(repo, 'apps/worker/skills'), join(directory, 'apps/worker/skills'), {
      recursive: true,
    });
    const modulePath = join(dist, 'm3-runtime-skills.js');
    await copyFile(fileURLToPath(new URL('./m3-runtime-skills.js', import.meta.url)), modulePath);
    const isolated = (await import(
      pathToFileURL(modulePath).href
    )) as typeof import('./m3-runtime-skills.js');
    for (const id of skillIds)
      assert.deepEqual(isolated.loadM3RuntimeSkill(id), loadM3RuntimeSkill(id));
    const skillPath = join(directory, 'apps/worker/skills/m3-review/SKILL.md');
    await writeFile(
      skillPath,
      loadM3RuntimeSkill('m3-review').content + '\nAltered local instructions.\n',
    );
    assert.throws(() => isolated.loadM3RuntimeSkill('m3-review'), /M3_SKILL_CONTENT_CHANGED/);
    const manifestPath = join(directory, 'apps/worker/skills/m3-runtime-manifest.json');
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')) + '\n');
    assert.throws(
      () => isolated.loadM3RuntimeSkill('m3-public-review'),
      /M3_SKILL_MANIFEST_CHANGED/,
    );
  } finally {
    assert(directory.startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  }
});
