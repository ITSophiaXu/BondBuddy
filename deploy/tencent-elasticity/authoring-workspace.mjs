import {chmod, chown, lstat, mkdir, realpath} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {requireThat} from './policy.mjs';

export async function prepareAuthoringWorkspace({parent = '/var/lib/bondbuddy'} = {}) {
  requireThat(process.getuid?.() === 0 && resolve(parent) === parent, 'AUTHORING_WORKSPACE_PARENT');
  requireThat(await realpath(dirname(parent)) === dirname(parent), 'AUTHORING_WORKSPACE_PARENT');
  try { await mkdir(parent, {mode: 0o755}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const controlled = await lstat(parent);
  requireThat(controlled.isDirectory() && !controlled.isSymbolicLink() && controlled.uid === 0 &&
    (controlled.mode & 0o022) === 0, 'AUTHORING_WORKSPACE_PARENT');
  const path = join(parent, 'authoring-work');
  try { await mkdir(path, {mode: 0o700}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const existing = await lstat(path);
  requireThat(existing.isDirectory() && !existing.isSymbolicLink(), 'AUTHORING_WORKSPACE_DIRECTORY');
  await chown(path, 1000, 1000);
  await chmod(path, 0o700);
  return path;
}
