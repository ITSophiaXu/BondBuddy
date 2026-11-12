import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['workspace-ux-scenes.json', 'workspace-ux-preview.css'];

/** A worker restart cannot adopt a failed producer's artifacts or the old
 * checked-in prototype. Only this worker's completed producer is readable. */
export function workspaceSceneArtifacts(sourceRoot = root) {
  let published;
  return {
    async publish(json, css, directory = process.env.BB_WORKSPACE_SCENES_DIR) {
      published = undefined;
      assert.ok(typeof directory === 'string' && isAbsolute(directory), 'Set BB_WORKSPACE_SCENES_DIR to this run\'s absolute evidence directory');
      directory = resolve(directory);
      const fromSource = relative(resolve(sourceRoot), directory);
      assert.ok(fromSource === '..' || fromSource.startsWith('..' + sep) || isAbsolute(fromSource), 'Generated scenes must be outside the candidate source tree');
      await mkdir(dirname(directory), { recursive: true });
      await mkdir(directory); // Refuse to overwrite/adopt previous artifacts.
      const values = [Buffer.from(json, 'utf8'), Buffer.from(css, 'utf8')], entries = [];
      for (const [index, name] of names.entries()) {
        await writeFile(join(directory, name), values[index], { flag: 'wx' });
        const actual = await readFile(join(directory, name)); assert.ok(actual.equals(values[index]));
        entries.push({ name, bytes: actual.length, sha256: hash(actual) });
      }
      const manifest = { schema: 'workspace-scene-artifacts-v1', producer: 'synthetic workspace design scenes',
        generation_id: randomUUID(), pid: process.pid, created_at: new Date().toISOString(), files: entries };
      await writeFile(join(directory, 'generation.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      published = { directory, manifest }; return manifest;
    },
    async read(name) {
      assert.ok(published, 'The scene producer must complete in this same worker before a prototype consumer runs');
      const row = published.manifest.files.find(row => row.name === name); assert.ok(row, 'Unknown generated prototype asset');
      const bytes = await readFile(join(published.directory, name)); assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256, 'Generated scene asset changed after its producer');
      return bytes;
    },
  };
}
