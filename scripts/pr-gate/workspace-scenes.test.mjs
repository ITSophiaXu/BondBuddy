import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { workspaceSceneArtifacts } from './workspace-scenes.mjs';

test('scene consumers require their same-worker producer and retain all original JSON/CSS bytes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bb-workspace-scenes-'));
  try {
    const source = join(base, 'source'), directory = join(base, 'evidence/scenes'), writer = workspaceSceneArtifacts(source);
    await assert.rejects(writer.read('workspace-ux-scenes.json'), /producer must complete/);
    const json = JSON.stringify({ create: '<main>合成\n完整段落</main>', materials: '<div>  spaced  </div>' }, null, 2) + '\n', css = '/* 合成样式 */\n.app { color: red; }\n\n';
    const manifest = await writer.publish(json, css, directory);
    assert.equal((await writer.read('workspace-ux-scenes.json')).toString('utf8'), json);
    assert.equal((await writer.read('workspace-ux-preview.css')).toString('utf8'), css);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'generation.json'), 'utf8')), manifest);
    await assert.rejects(workspaceSceneArtifacts(source).read('workspace-ux-scenes.json'), /producer must complete/);
    await assert.rejects(writer.read('../workspace-ux-scenes.json'), /Unknown/);
    await writeFile(join(directory, 'workspace-ux-scenes.json'), json.replace('合成', '异值'));
    await assert.rejects(writer.read('workspace-ux-scenes.json'), /changed after its producer/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('scene producer never overwrites earlier artifacts or writes inside source; failed publish cannot be consumed', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bb-workspace-scenes-'));
  try {
    const source = join(base, 'source'), directory = join(base, 'evidence/scenes'), writer = workspaceSceneArtifacts(source);
    await assert.rejects(writer.publish('{}\n', 'css', undefined), /Set BB_WORKSPACE_SCENES_DIR/);
    await assert.rejects(writer.publish('{}\n', 'css', join(source, 'product-prototype/public')), /outside/);
    await writer.publish('{}\n', 'css', directory);
    await assert.rejects(writer.publish('new\n', 'new css', directory), /EEXIST/);
    assert.equal((await readFile(join(directory, 'workspace-ux-scenes.json'))).toString(), '{}\n');
    await assert.rejects(writer.read('workspace-ux-scenes.json'), /producer must complete/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
