import { hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { performance } from 'node:perf_hooks';

export type ExecutionNode = {
  server_id: string | null;
  server_name: string | null;
  cloud_provider: string | null;
  execution_host_id: string | null;
};
export type WorkerIdentity = ExecutionNode & {
  worker_id: string;
  container_hostname: string;
  process_id: number;
  server_identity_source: 'deployment_config' | 'unavailable';
};

export function executionNodeFromEnv(env: NodeJS.ProcessEnv = process.env): ExecutionNode {
  const identifier = (key: string, pattern: RegExp) => {
    const value = env[key];
    if (value === undefined || value === '') return null;
    if (!pattern.test(value)) throw new Error(`Invalid ${key}`);
    return value;
  };
  const executionHost = identifier('BB_EXECUTION_HOST_ID', /^[a-f0-9]{64}$/);
  const modelHost = identifier('BB_MODEL_EXECUTION_HOST_ID', /^[a-f0-9]{64}$/);
  if (executionHost && modelHost && executionHost !== modelHost) throw new Error('Execution host identity mismatch');
  return {
    server_id: identifier('BB_EXECUTION_NODE_ID', /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
    server_name: identifier('BB_EXECUTION_NODE_NAME', /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    cloud_provider: identifier('BB_EXECUTION_CLOUD_PROVIDER', /^(azure|tencent|local|other)$/),
    execution_host_id: executionHost ?? modelHost,
  };
}

export function workerIdentity(workerId: string, node: ExecutionNode): WorkerIdentity {
  return { ...node, worker_id: workerId, container_hostname: hostname(), process_id: process.pid,
    server_identity_source: node.server_id ? 'deployment_config' : 'unavailable' };
}

function counter(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error('INVALID_RESOURCE_COUNTER');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('INVALID_RESOURCE_COUNTER');
  return number;
}

export function kernelCpu(text: string) {
  const fields = text.match(/^cpu\s+(.+)$/m)?.[1]?.trim().split(/\s+/);
  if (!fields || fields.length < 8) throw new Error('INVALID_KERNEL_CPU');
  // Guest time is already included in user/nice; count only the first eight fields.
  const values = fields.slice(0, 8).map(value => counter(value));
  const logicalCpus = text.match(/^cpu\d+\s/gm)?.length ?? 0;
  if (!logicalCpus) throw new Error('INVALID_KERNEL_CPU');
  return { total: values.reduce((sum, value) => sum + value, 0), idle: values[3]! + values[4]!,
    logical_cpus: logicalCpus };
}

export function processCgroupDirectory(cgroup: string, mounts: string): string {
  const group = cgroup.match(/^0::(\/.*)$/m)?.[1];
  if (!group) throw new Error('CGROUP_V2_UNAVAILABLE');
  const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  for (const line of mounts.split('\n')) {
    const [metadata, filesystem] = line.split(' - ');
    if (!filesystem?.startsWith('cgroup2 ')) continue;
    const fields = metadata!.split(' ');
    const root = decode(fields[3] ?? ''), mount = decode(fields[4] ?? '');
    if (!root.startsWith('/') || !mount.startsWith('/')) continue;
    const relative = posix.relative(root, group);
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) continue;
    return posix.join(mount, relative);
  }
  throw new Error('CGROUP_V2_UNAVAILABLE');
}

type ResourceReading = {
  at: number; kernel: ReturnType<typeof kernelCpu>; cpu_usec: number; throttled_usec: number;
  memory_bytes: number; memory_limit_bytes: number | null; cpu_limit_cores: number | null; oom: number;
};

export function resourceInterval(previous: ResourceReading | undefined, current: ResourceReading) {
  const interval = previous ? (current.at - previous.at) / 1000 : null;
  let kernelPercent: number | null = null, cores: number | null = null, throttle: number | null = null;
  if (previous) {
    const total = current.kernel.total - previous.kernel.total;
    const idle = current.kernel.idle - previous.kernel.idle;
    const cpu = current.cpu_usec - previous.cpu_usec;
    const throttled = current.throttled_usec - previous.throttled_usec;
    if (!(interval! > 0) || total <= 0 || idle < 0 || idle > total || cpu < 0 || throttled < 0 ||
        current.kernel.logical_cpus !== previous.kernel.logical_cpus) throw new Error('RESOURCE_COUNTER_RESET');
    kernelPercent = 100 * (total - idle) / total;
    cores = cpu / 1e6 / interval!;
    throttle = throttled / 1e6;
  }
  return {
    status: previous ? 'sampled' : 'baseline',
    interval_seconds: interval,
    kernel_cpu_percent: kernelPercent,
    kernel_logical_cpus: current.kernel.logical_cpus,
    kernel_cpu_scope: 'execution_kernel_proc_stat',
    cgroup_cpu_cores: cores,
    cgroup_cpu_limit_cores: current.cpu_limit_cores,
    cgroup_cpu_scope: 'worker_process_cgroup_including_children',
    cgroup_throttled_seconds: throttle,
    cgroup_memory_bytes: current.memory_bytes,
    cgroup_memory_limit_bytes: current.memory_limit_bytes,
    cgroup_oom_count: current.oom,
    task_cpu_attribution: 'unavailable',
  };
}

export class WorkerResourceSampler {
  private previous?: ResourceReading;
  private directory?: string;
  async sample() {
    this.directory ??= processCgroupDirectory(await readFile('/proc/self/cgroup', 'utf8'), await readFile('/proc/self/mountinfo', 'utf8'));
    const [kernel, cpu, quota, memory, memoryLimit, events] = await Promise.all([
      readFile('/proc/stat', 'utf8'), readFile(posix.join(this.directory, 'cpu.stat'), 'utf8'),
      readFile(posix.join(this.directory, 'cpu.max'), 'utf8'), readFile(posix.join(this.directory, 'memory.current'), 'utf8'),
      readFile(posix.join(this.directory, 'memory.max'), 'utf8'), readFile(posix.join(this.directory, 'memory.events'), 'utf8'),
    ]);
    const cpuValue = (key: string) => counter(cpu.match(new RegExp(`^${key} (\\d+)$`, 'm'))?.[1]);
    const [maximum, period] = quota.trim().split(/\s+/);
    const periodValue = counter(period);
    if (periodValue === 0) throw new Error('INVALID_RESOURCE_COUNTER');
    const current: ResourceReading = {
      at: performance.now(), kernel: kernelCpu(kernel), cpu_usec: cpuValue('usage_usec'), throttled_usec: cpuValue('throttled_usec'),
      memory_bytes: counter(memory.trim()), memory_limit_bytes: memoryLimit.trim() === 'max' ? null : counter(memoryLimit.trim()),
      cpu_limit_cores: maximum === 'max' ? null : counter(maximum) / periodValue,
      oom: counter(events.match(/^oom (\d+)$/m)?.[1]),
    };
    const previous = this.previous;
    this.previous = current;
    return { ...resourceInterval(previous, current), cgroup_path: this.directory };
  }
}
