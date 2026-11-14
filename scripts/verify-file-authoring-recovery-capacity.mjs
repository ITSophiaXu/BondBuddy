// Explicit, synthetic Linux resource check. Run in an isolated helper with no
// network, credentials or service volumes, after building contracts/API/worker.
// Uses a disk-backed Blob test double, not Azure SDK or a real provider.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FILE_AUTHORING_RECOVERY_LIMITS as limits } from '../packages/contracts/dist/index.js';
import { validFileAuthoringRecovery } from '../apps/api/dist/queue.js';
import { authorizedFileAuthoringRecovery, recoverFileAuthoringInput, restoreFileAuthoringWork,
  saveFileAuthoringRecovery } from '../apps/worker/dist/file-authoring-recovery.js';

assert.equal(process.platform, 'linux', 'Use a dedicated Linux helper');
assert.equal(process.argv[2], '--verify', 'Explicit --verify is required');
assert.deepEqual(limits, { files: 4096, fileBytes: 100 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 });
const base = resolve(process.argv[3] ?? '/capacity');
const reportFile = resolve(process.argv[4] ?? '/evidence/result.json');
const root = await mkdtemp(join(base, 'bb-recovery-byte-capacity-'));
const input = Buffer.from(JSON.stringify({ version: 'synthetic', input_hash: 'a'.repeat(64) }));
const intent = { call_id: 'synthetic-capacity', logical_call_id: 'file-authoring-v1' };
const scope = { owner: 'synthetic-owner', project: 'synthetic-project', run: 'synthetic-run', inputHash: 'a'.repeat(64),
  attempt: intent.call_id, logical: intent.logical_call_id };
const readOptional = path => readFile(path, 'utf8').then(v => v.trim(), () => null);
const disk = async () => { const s = await statfs(root); return { blockBytes: s.bsize, totalBytes: s.blocks * s.bsize, availableBytes: s.bavail * s.bsize }; };
const report = { version: 'synthetic-recovery-byte-capacity-v1', startedAt: new Date().toISOString(), limits,
  storage: 'disk-backed synthetic Blob interface; no Azure SDK/network/model/database', root,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  constraints: { memoryMax: await readOptional('/sys/fs/cgroup/memory.max'), cpuMax: await readOptional('/sys/fs/cgroup/cpu.max') },
  diskBefore: await disk(), profiles: [], success: false };
let sampledRss = process.memoryUsage().rss;
const sampler = setInterval(() => { sampledRss = Math.max(sampledRss, process.memoryUsage().rss); }, 10);
async function shaFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}
// Fully materialize each fixture from a 64 KiB buffer (no sparse shortcuts).
async function materialize(path, size, seed) {
  const handle = await open(path, 'wx', 0o600), block = Buffer.alloc(64 * 1024, seed % 251);
  try { for (let left = size; left > 0; left -= Math.min(left, block.length)) await handle.write(block, 0, Math.min(left, block.length)); }
  finally { await handle.close(); }
}
async function profile(name, totalBytes, maximumBytes) {
  const directory = join(root, name), source = join(directory, 'source'), store = join(directory, 'blobs'), target = join(directory, 'restored');
  await mkdir(join(source, 'scratch'), { recursive: true }); await mkdir(join(source, 'output')); await mkdir(store); await mkdir(target);
  await writeFile(join(source, 'input.json'), input);
  const fileCount = 929, sizes = [maximumBytes];
  let remaining = totalBytes - input.length - maximumBytes;
  for (let n = 1; n < fileCount - 1; n++) { const size = Math.ceil(remaining / (fileCount - 1 - n)); sizes.push(size); remaining -= size; }
  assert.equal(remaining, 0); assert.equal(Math.max(...sizes), maximumBytes);
  for (let n = 0; n < sizes.length; n++) await materialize(join(source, n % 2 ? 'output' : 'scratch', `file-${String(n).padStart(4, '0')}.bin`), sizes[n], n);
  let puts = 0, reads = 0, published = 0, inFlight = 0, maximumInFlight = 0, maxRequestBytes = 0;
  const blobPath = key => { assert.match(key, /^owners\/synthetic-owner\/projects\/synthetic-project\/runs\/synthetic-run\/file-authoring\/recovery\/[a-z-]+\/[a-f0-9]{64}\/(?:input\.json|(?:scratch|output)\/[a-z0-9.-]+)$/); return join(store, key); };
  const enter = () => { maximumInFlight = Math.max(maximumInFlight, ++inFlight); };
  const ctx = { run: { id: scope.run, owner_user_id: scope.owner, project_id: scope.project, input_hash: scope.inputHash },
    lease: { checkpoint: {} }, checkpoint: {}, signal: new AbortController().signal,
    blobs: {
      async put(key, bytes) { enter(); try { puts++; maxRequestBytes = Math.max(maxRequestBytes, bytes.length); const path = blobPath(key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); } finally { inFlight--; } },
      // Match production's bounded chunked read/concat shape to measure its
      // extra single-file buffer, while explicitly excluding HTTP/SDK overhead.
      async getIfExistsBounded(key, bound) {
        enter(); try {
          reads++; const path = blobPath(key), size = (await lstat(path)).size; assert.ok(size <= bound);
          const chunks = []; let length = 0;
          for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) { length += chunk.length; assert.ok(length <= bound); chunks.push(Buffer.from(chunk)); }
          assert.equal(length, size); return Buffer.concat(chunks, length);
        } finally { inFlight--; }
      },
    } };
  const checkpoint = async (_pool, lease, stage, value, completed) => {
    assert.equal(stage, 'file_authoring_recovery'); assert.equal(completed, false); published++;
    lease.checkpoint = structuredClone({ ...lease.checkpoint, stages: { [stage]: value } });
  };
  const cpuStart = process.cpuUsage(), start = performance.now();
  const snapshot = await saveFileAuthoringRecovery(ctx, source, intent, { checkpoint });
  const saveMs = performance.now() - start;
  assert.equal(snapshot.files.length, fileCount); assert.equal(snapshot.files.reduce((sum, f) => sum + f.byte_size, 0), totalBytes);
  assert.equal(published, 1); assert.equal(puts, fileCount); assert.equal(reads, fileCount); assert.equal(maximumInFlight, 1);
  assert.ok(maxRequestBytes <= limits.fileBytes); assert.equal(validFileAuthoringRecovery(snapshot, scope), true);
  assert.equal(authorizedFileAuthoringRecovery(ctx, intent.logical_call_id), null);
  ctx.lease.checkpoint.operator_reconciliations = { [intent.call_id]: { attempt_id: intent.call_id, logical_call_id: intent.logical_call_id,
    reason_code: 'file_authoring_timeout_auto_retry', decision: 'retry_unknown_usage' } };
  const restarted = { ...ctx, lease: { checkpoint: structuredClone(ctx.lease.checkpoint) }, checkpoint: {} };
  const approved = authorizedFileAuthoringRecovery(restarted, intent.logical_call_id);
  assert.ok(approved);
  const restoreStart = performance.now();
  await writeFile(join(target, 'input.json'), await recoverFileAuthoringInput(restarted, approved, input));
  await restoreFileAuthoringWork(restarted, target, approved);
  const restoreMs = performance.now() - restoreStart, verifyStart = performance.now();
  for (const file of snapshot.files) {
    assert.equal(await shaFile(join(source, file.path)), file.sha256);
    assert.equal(await shaFile(join(target, file.path)), file.sha256);
  }
  const verifyMs = performance.now() - verifyStart;
  const result = { name, files: fileCount, totalBytes, maximumBytes, saveMs, restoreMs, verifyMs,
    puts, reads, published, maximumInFlight, maxRequestBytes, cpuMicroseconds: process.cpuUsage(cpuStart),
    maxRssKiB: process.resourceUsage().maxRSS, diskWithFullCopy: await disk(), rejected: [] };
  if (totalBytes === limits.totalBytes) {
    const excessive = structuredClone(snapshot), last = excessive.files.at(-1); last.byte_size++;
    assert.equal(validFileAuthoringRecovery(excessive, scope), false);
    const rejectedTarget = join(directory, 'rejected'); await mkdir(rejectedTarget); const readsBefore = reads;
    await assert.rejects(recoverFileAuthoringInput(ctx, excessive, input), /AUTHORING_RECOVERY_UNSAFE/);
    await assert.rejects(restoreFileAuthoringWork(ctx, rejectedTarget, excessive), /AUTHORING_RECOVERY_UNSAFE/);
    assert.equal(reads, readsBefore); assert.deepEqual(await readdir(rejectedTarget), []);
    await appendFile(join(source, last.path), Buffer.from([1]));
    const putsBefore = puts;
    await assert.rejects(saveFileAuthoringRecovery(ctx, source, intent, { checkpoint }));
    assert.equal(published, 1, 'total +1 cannot publish a partial/new checkpoint');
    result.rejected.push({ kind: 'totalBytes+1', bytes: limits.totalBytes + 1, blobPuts: puts - putsBefore, published: 0, metadataReads: reads - readsBefore - (puts - putsBefore) });
    const large = snapshot.files.find(f => f.byte_size === limits.fileBytes); assert.ok(large);
    await appendFile(join(source, large.path), Buffer.from([2]));
    const beforeLarge = puts;
    await assert.rejects(saveFileAuthoringRecovery(ctx, source, intent, { checkpoint }));
    assert.equal(puts, beforeLarge); assert.equal(published, 1);
    result.rejected.push({ kind: 'fileBytes+1', bytes: limits.fileBytes + 1, blobPuts: 0, published: 0 });
  }
  result.elapsedMs = performance.now() - start;
  report.profiles.push(result); console.log(JSON.stringify(result));
  // Only this helper's generated profile directory is removed.
  assert.ok(resolve(directory).startsWith(root + '/')); await rm(directory, { recursive: true });
}
try {
  assert.ok(report.diskBefore.availableBytes > 4 * 1024 ** 3, 'Need at least 4 GiB free for full source/store/restore fixture copies');
  await profile('observed-byte-shape', 272_333_666, 5_634_998);
  await profile('exact-512mib-and-100mib-file', limits.totalBytes, limits.fileBytes);
  report.success = true;
} catch (error) { report.error = String(error.stack ?? error); throw error; }
finally {
  clearInterval(sampler);
  report.sampledRssBytes = sampledRss; report.maxRssKiB = process.resourceUsage().maxRSS;
  report.cgroupMemoryPeak = await readOptional('/sys/fs/cgroup/memory.peak');
  report.cgroupMemoryEvents = await readOptional('/sys/fs/cgroup/memory.events');
  report.diskAfter = await disk(); report.finishedAt = new Date().toISOString();
  await mkdir(dirname(reportFile), { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  assert.ok(root.startsWith(base + '/bb-recovery-byte-capacity-')); await rm(root, { recursive: true });
  console.log(JSON.stringify({ success: report.success, reportFile, maxRssKiB: report.maxRssKiB }));
}
