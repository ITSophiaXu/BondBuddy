import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { lstat, mkdtemp, open, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParseStaging, sweepParseStaging } from './parse-staging.js';

test('SIGKILL leaves private staging; restart sweep reclaims only expired inactive managed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-staging-test-'));
  const outside = await mkdtemp(join(tmpdir(), 'bb-staging-outside-'));
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { createParseStaging } from ${JSON.stringify(new URL('./parse-staging.js', import.meta.url).href)};
     import { writeFile } from 'node:fs/promises';
     import { join } from 'node:path';
     const s = await createParseStaging(process.argv[1]);
     await writeFile(join(s.directory, 'source'), 'synthetic private source');
     await writeFile(join(s.directory, 'records.ndjson'), 'synthetic evidence');
     process.stdout.write(s.directory + '\\n');
     setInterval(() => {}, 1000);`, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const directory = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('\n')) resolve(output.trim()); });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`child exited ${code}`)));
    });
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    const live = await createParseStaging(root);
    const unrelated = join(root, 'unrelated');
    await writeFile(unrelated, 'keep');
    const fake = join(root, 'bb-material-ABC123');
    await symlink(outside, fake);
    const old = new Date(Date.now() - 31 * 60 * 1000);
    await utimes(join(directory, '.active'), old, old);
    const restarted = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { sweepParseStaging } from ${JSON.stringify(new URL('./parse-staging.js', import.meta.url).href)};
       process.stdout.write(JSON.stringify(await sweepParseStaging(process.argv[1])));`, root], { encoding: 'utf8' });
    assert.equal(restarted.status, 0, restarted.stderr);
    const result = JSON.parse(restarted.stdout) as { removed: number; bytes: number };
    assert.equal(result.removed, 1);
    assert.ok(result.bytes > 0);
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    assert.ok((await readdir(root)).includes(unrelated.split('/').at(-1)!));
    assert.ok((await lstat(fake)).isSymbolicLink());
    assert.ok((await lstat(live.directory)).isDirectory(), 'active parse survives even with a sweep');
    await utimes(join(live.directory, '.active'), old, old);
    assert.equal((await sweepParseStaging(root)).removed, 0, 'same-process active parse survives even a stale marker');
    await live.cleanup();
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('staging admission caps accumulated orphan bytes and refuses a symlink root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-staging-budget-'));
  const link = `${root}-link`;
  try {
    await symlink(root, link);
    await assert.rejects(createParseStaging(link), /PARSE_STAGING_UNSAFE_ROOT/);
    const orphan = join(root, 'bb-material-Z9x8Y7');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(orphan, { mode: 0o700 });
    const file = await open(join(orphan, 'source'), 'wx', 0o600);
    try { await file.truncate(800 * 1024 * 1024); } finally { await file.close(); }
    await assert.rejects(createParseStaging(root), /PARSE_STAGING_CAPACITY/);
    assert.deepEqual(await readdir(orphan), ['source']);
  } finally {
    await rm(link, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
