import {constants} from 'node:fs';
import {open, mkdir} from 'node:fs/promises';
import {canonical, sha256, requireThat} from './policy.mjs';

export async function readPrivateJson(path, {maxBytes = 65536} = {}) {
  requireThat(path?.startsWith('/'), 'PRIVATE_PATH_REQUIRED');
  requireThat(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 262144, 'PRIVATE_FILE_BOUND');
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await f.stat();
    requireThat(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid() && stat.size <= maxBytes, 'PRIVATE_FILE_PERMISSIONS');
    return JSON.parse(await f.readFile('utf8'));
  } finally { await f.close(); }
}

/** Content-addressed observation evidence, never a task queue or credential log. */
export function observationArchive(directory) {
  return async bytes => {
    requireThat(Buffer.byteLength(bytes) <= 131072, 'OBSERVATION_BOUND');
    await mkdir(directory, {recursive: true, mode: 0o700});
    const digest = sha256(bytes), ref = `${directory}/${digest}.json`;
    let f;
    try {
      f = await open(ref, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await f.writeFile(bytes); await f.sync();
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      requireThat(sha256(canonical(await readPrivateJson(ref))) === digest, 'OBSERVATION_COLLISION');
    } finally { if (f) await f.close(); }
    return {ref, sha256: digest};
  };
}
