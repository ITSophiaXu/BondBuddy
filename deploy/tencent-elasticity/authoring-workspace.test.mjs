import assert from 'node:assert/strict';
import test from 'node:test';
import {chmod, chown, mkdtemp, mkdir, lstat, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const rootLinux = process.platform === 'linux' && process.getuid() === 0;
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'bb-authoring-workspace-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

test('authoring candidates use a dedicated persistent read-write bind with no automatic host directory', async () => {
  const compose = await readFile(new URL('./compose.yaml', import.meta.url), 'utf8');
  const authoring = compose.split('\n  authoring:')[1].split('\n  review:')[0];
  assert.match(authoring, /BB_FILE_AUTHORING_WORK_ROOT: \/var\/lib\/bondbuddy\/authoring-work/);
  assert.match(authoring, /- type: bind\s+source: \/var\/lib\/bondbuddy\/authoring-work\s+target: \/var\/lib\/bondbuddy\/authoring-work\s+read_only: false\s+bind:\s+create_host_path: false/);
  assert.match(authoring, /read_only: true/);
  const review = compose.split('\n  review:')[1];
  assert.ok(!review.includes('/var/lib/bondbuddy/authoring-work'), 'each role owns its own workspace');
  const adapter = await readFile(new URL('./node-adapter.mjs', import.meta.url), 'utf8');
  assert.match(adapter, /await prepareAuthoringWorkspace\(\)/, 'the controlled directory is prepared before Compose starts');
});

test('node preparation preserves retained bytes and restores the dedicated uid and private mode', {skip: !rootLinux}, async t => {
  const {prepareAuthoringWorkspace} = await import('./authoring-workspace.mjs');
  const parent = join(await workspace(t), 'controlled');
  const path = await prepareAuthoringWorkspace({parent});
  assert.equal(path, join(parent, 'authoring-work'));
  const parentStat = await lstat(parent);
  assert.equal(parentStat.uid, 0);
  assert.equal(parentStat.mode & 0o022, 0);
  const retained = join(path, 'attempt-synthetic');
  await mkdir(retained);
  await writeFile(join(retained, 'capture.json'), 'synthetic retained candidate');
  assert.equal(await prepareAuthoringWorkspace({parent}), path);
  const leaf = await lstat(path);
  assert.equal(leaf.uid, 1000);
  assert.equal(leaf.gid, 1000);
  assert.equal(leaf.mode & 0o777, 0o700);
  assert.equal(await readFile(join(retained, 'capture.json'), 'utf8'), 'synthetic retained candidate');
});

test('node preparation refuses a symlink parent or leaf and never rewrites an outside target', {skip: !rootLinux}, async t => {
  const {prepareAuthoringWorkspace} = await import('./authoring-workspace.mjs');
  const root = await workspace(t);
  const outside = join(root, 'outside');
  await mkdir(outside, {mode: 0o750});
  await writeFile(join(outside, 'marker'), 'outside');
  const parentLink = join(root, 'parent-link');
  await symlink(outside, parentLink);
  await assert.rejects(prepareAuthoringWorkspace({parent: parentLink}), /AUTHORING_WORKSPACE_PARENT/);
  await assert.rejects(prepareAuthoringWorkspace({parent: join(parentLink, 'new-parent')}), /AUTHORING_WORKSPACE_PARENT/);
  await assert.rejects(lstat(join(outside, 'new-parent')), {code: 'ENOENT'});
  const parent = join(root, 'controlled');
  await mkdir(parent, {mode: 0o755});
  await symlink(outside, join(parent, 'authoring-work'));
  await assert.rejects(prepareAuthoringWorkspace({parent}), /AUTHORING_WORKSPACE_DIRECTORY/);
  assert.equal((await lstat(outside)).mode & 0o777, 0o750);
  assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'outside');
  const writable = join(root, 'writable');
  await mkdir(writable); await chmod(writable, 0o777);
  await assert.rejects(prepareAuthoringWorkspace({parent: writable}), /AUTHORING_WORKSPACE_PARENT/);
  const unowned = join(root, 'unowned');
  await mkdir(unowned); await chown(unowned, 1000, 1000);
  await assert.rejects(prepareAuthoringWorkspace({parent: unowned}), /AUTHORING_WORKSPACE_PARENT/);
});
