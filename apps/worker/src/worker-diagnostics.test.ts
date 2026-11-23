import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionNodeFromEnv, workerIdentity, kernelCpu, processCgroupDirectory, resourceInterval } from './worker-diagnostics.js';

test('server labels are explicit deployment metadata and never copied from credentials', () => {
  const node = executionNodeFromEnv({ BB_EXECUTION_NODE_ID: 'ins-synthetic', BB_EXECUTION_NODE_NAME: 'synthetic-vm',
    BB_EXECUTION_CLOUD_PROVIDER: 'tencent', BB_MODEL_EXECUTION_HOST_ID: 'a'.repeat(64), DATABASE_URL: 'private', TOKEN: 'private' });
  const identity = workerIdentity('authoring_synthetic', node);
  assert.equal(identity.worker_id, 'authoring_synthetic');
  assert.equal(identity.server_id, 'ins-synthetic');
  assert.equal(identity.execution_host_id, 'a'.repeat(64));
  assert.equal(identity.server_identity_source, 'deployment_config');
  assert.ok(identity.container_hostname);
  assert.equal(JSON.stringify(identity).includes('private'), false);
  assert.equal(workerIdentity('synthetic', executionNodeFromEnv({})).server_identity_source, 'unavailable');
  for (const env of [{ BB_EXECUTION_NODE_ID: 'node\nsecret' }, { BB_EXECUTION_NODE_NAME: 'invalid name' },
    { BB_EXECUTION_CLOUD_PROVIDER: 'guess' }, { BB_EXECUTION_HOST_ID: 'invalid' },
    { BB_EXECUTION_HOST_ID: 'a'.repeat(64), BB_MODEL_EXECUTION_HOST_ID: 'b'.repeat(64) }])
    assert.throws(() => executionNodeFromEnv(env));
});

test('cgroup resolution handles private namespaces, nested mounts and rejects unrelated mounts', () => {
  assert.equal(processCgroupDirectory('0::/\n', '1 0 0:1 / /sys/fs/cgroup ro - cgroup2 cgroup rw'), '/sys/fs/cgroup');
  assert.equal(processCgroupDirectory('0::/system.slice/worker.scope\n',
    '1 0 0:1 / /sys/fs/cgroup ro - cgroup2 cgroup rw'), '/sys/fs/cgroup/system.slice/worker.scope');
  assert.equal(processCgroupDirectory('0::/system.slice/worker.scope\n',
    '1 0 0:1 /system.slice /sys/fs/cgroup ro - cgroup2 cgroup rw'), '/sys/fs/cgroup/worker.scope');
  assert.throws(() => processCgroupDirectory('0::/other\n', '1 0 0:1 /private /sys/fs/cgroup ro - cgroup2 cgroup rw'));
  assert.throws(() => processCgroupDirectory('1:cpu:/\n', ''));
});

test('kernel CPU excludes duplicated guest counters and includes idle plus iowait', () => {
  assert.deepEqual(kernelCpu('cpu 10 20 30 40 50 60 70 80 90 100\ncpu0 1\ncpu1 2\n'),
    { total: 360, idle: 90, logical_cpus: 2 });
  assert.throws(() => kernelCpu('cpu 1 2 3\ncpu0 1\n'));
});

test('CPU uses counter deltas, memory is cgroup charged and no per-task attribution is invented', () => {
  const prior = { at: 1000, kernel: { total: 1000, idle: 700, logical_cpus: 4 }, cpu_usec: 1e6,
    throttled_usec: 0, memory_bytes: 100, memory_limit_bytes: 1000, cpu_limit_cores: 2, oom: 0 };
  const current = { ...prior, at: 3000, kernel: { total: 1200, idle: 800, logical_cpus: 4 },
    cpu_usec: 4e6, throttled_usec: 5e6, memory_bytes: 200 };
  const result = resourceInterval(prior, current);
  assert.equal(result.kernel_cpu_percent, 50);
  assert.equal(result.cgroup_cpu_cores, 1.5);
  assert.equal(result.cgroup_throttled_seconds, 5);
  assert.equal(result.interval_seconds, 2);
  assert.equal(result.cgroup_memory_bytes, 200);
  assert.equal(result.task_cpu_attribution, 'unavailable');
  assert.equal(resourceInterval(undefined, current).kernel_cpu_percent, null);
  assert.equal(resourceInterval(undefined, current).status, 'baseline');
  assert.throws(() => resourceInterval(prior, { ...current, cpu_usec: 0 }));
  assert.throws(() => resourceInterval(prior, { ...current, at: 1000 }));
  assert.throws(() => resourceInterval(prior, { ...current, kernel: { ...current.kernel, logical_cpus: 8 } }));
});
