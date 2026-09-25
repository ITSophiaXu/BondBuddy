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
    child.kill('SIGSTOP');
    const paused = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { sweepParseStaging } from ${JSON.stringify(new URL('./parse-staging.js', import.meta.url).href)};
       process.stdout.write(JSON.stringify(await sweepParseStaging(process.argv[1], Number(process.argv[2]))));`, root, String(Date.now() + 31 * 60 * 1000)], { encoding: 'utf8' });
    assert.equal(paused.status, 0, paused.stderr);
    assert.equal(JSON.parse(paused.stdout).removed, 0, 'another process cannot delete SIGSTOP-held source or NDJSON');
    assert.deepEqual((await readdir(directory)).sort(), ['.owner.json', '.owner.lock', 'records.ndjson', 'source']);
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    const live = await createParseStaging(root);
    const unrelated = join(root, 'unrelated');
    await writeFile(unrelated, 'keep');
    const fake = join(root, 'bb-material-ABC123');
    await symlink(outside, fake);
    const foreign = join(root, 'bb-material-XyZ123');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, 'source'), 'foreign same-UID source', { mode: 0o600 });
    const old = new Date(Date.now() - 31 * 60 * 1000);
    await utimes(join(directory, '.owner.json'), old, old);
    const restarted = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { sweepParseStaging } from ${JSON.stringify(new URL('./parse-staging.js', import.meta.url).href)};
       process.stdout.write(JSON.stringify(await sweepParseStaging(process.argv[1], Number(process.argv[2]))));`, root, String(Date.now() + 31 * 60 * 1000)], { encoding: 'utf8' });
    assert.equal(restarted.status, 0, restarted.stderr);
    const result = JSON.parse(restarted.stdout) as { removed: number; bytes: number };
    assert.equal(result.removed, 1);
    assert.ok(result.bytes > 0);
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    assert.ok((await readdir(root)).includes(unrelated.split('/').at(-1)!));
    assert.ok((await lstat(fake)).isSymbolicLink());
    assert.deepEqual(await readdir(foreign), ['source'], 'unregistered same-name directory is untouched');
    assert.ok((await lstat(live.directory)).isDirectory(), 'active parse survives even with a sweep');
    await utimes(join(live.directory, '.owner.json'), old, old);
    assert.equal((await sweepParseStaging(root, Date.now() + 31 * 60 * 1000)).removed, 0, 'same-process active parse survives even a stale marker');
    await live.cleanup();
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('concurrent processes atomically admit only two 384 MiB reservations into a 1 GiB volume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-staging-concurrent-'));
  const script = `import { createParseStaging } from ${JSON.stringify(new URL('./parse-staging.js', import.meta.url).href)};
    try { const s=await createParseStaging(process.argv[1]); process.stdout.write('ADMITTED\\n'); setInterval(()=>{},1000); }
    catch(e) { process.stdout.write(e.message+'\\n'); }`;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    const results = await Promise.all(children.map(child => new Promise<string>((resolve, reject) => {
      let output = '', errors = '';
      child.stdout.on('data', data => { output += String(data); if (output.includes('\n')) resolve(output.trim()); });
      child.stderr.on('data', data => { errors += String(data); });
      child.once('error', reject);
      child.once('exit', code => { if (!output.includes('\n')) reject(new Error(`child exited ${code}: ${errors}`)); });
    })));
    assert.equal(results.filter(value => value === 'ADMITTED').length, 2, JSON.stringify(results));
    assert.equal(results.filter(value => value === 'PARSE_STAGING_CAPACITY').length, 2, JSON.stringify(results));
    assert.equal((await readdir(root)).filter(name => name.startsWith('bb-material-')).length, 2);
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('exit', resolve));
      }
    }));
    await rm(root, { recursive: true, force: true });
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
    assert.equal((await sweepParseStaging(root, Date.now() + 31 * 60 * 1000)).removed, 0);
    assert.deepEqual(await readdir(orphan), ['source']);
  } finally {
    await rm(link, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
