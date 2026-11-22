import { startPerformanceSpan, withPerformanceSpan } from '@bondbuddy/api/performance-trace';
import { readFile } from 'node:fs/promises';
import type { StageOutcome } from './run-pipeline.js';

type Span = ReturnType<typeof startPerformanceSpan>;
const TOOL_TYPES = new Set(['command_execution', 'file_change', 'image_view', 'mcp_tool_call', 'web_search']);
const MAX_TOOL_ITEMS = 128;
const MAX_OVERFLOW_ACTIVE = 256;
const MAX_OVERFLOW_RECENT = 256;
const SAMPLE_INTERVAL_MS = 30000;
let activeCodexChildren=0;
export function modelChildStarted(){activeCodexChildren++;}
export function modelChildFinished(){activeCodexChildren=Math.max(0,activeCodexChildren-1);}

async function cgroupSample():Promise<Record<string,unknown>> {
  try {
    const [cpu,memory,pids]=await Promise.all([
      readFile('/sys/fs/cgroup/cpu.stat','utf8'),readFile('/sys/fs/cgroup/memory.current','utf8'),
      readFile('/sys/fs/cgroup/pids.current','utf8')]);
    const metric=(key:string)=>Number(new RegExp(`^${key} (\\d+)$`,'m').exec(cpu)?.[1]);
    const usage=metric('usage_usec'),throttled=metric('throttled_usec');
    const memoryBytes=Number(memory.trim()),processes=Number(pids.trim());
    if(![usage,throttled,memoryBytes,processes].every(v=>Number.isSafeInteger(v)&&v>=0))throw Error('CGROUP_SAMPLE_UNAVAILABLE');
    return {resource_scope:'shared_worker_container',resource_availability:'cgroup_v2',
      cgroup_cpu_usage_usec:usage,cgroup_cpu_throttled_usec:throttled,
      cgroup_memory_bytes:memoryBytes,cgroup_process_count:processes,
      worker_process_active_codex:activeCodexChildren};
  }catch{return {resource_scope:'shared_worker_container',resource_availability:'unavailable',
    worker_process_active_codex:activeCodexChildren};}
}
const noop = { stdout() {}, jsonEvent() {}, activity(_event: Record<string, unknown>) {},
  finish(_status: Parameters<Span['end']>[0], _attributes?: Record<string, unknown>) {} };

/** Stage functions return business failures as values; preserve their real status. */
export function withModelStagePerformance<T extends StageOutcome>(step: string, attributes: Record<string, unknown>, run: () => T | Promise<T>): Promise<T> {
  return withPerformanceSpan(step, attributes, async span => {
    const result = await run();
    span.end(result.kind === 'fail' ? 'failed' : result.kind === 'pause' ? 'paused' : result.kind === 'stopped' ? 'interrupted' : 'succeeded',
      { result_status: result.kind, ...(result.kind === 'fail' ? { error_code: result.code } : {}) });
    return result;
  });
}

/** Host observation times only. CLI events do not expose supplier token timestamps.
 * No command, text, output, or item identifier is copied to telemetry. All event
 * callbacks are synchronous and bounded; persistence belongs to the trace queue. */
export function createModelProcessPerformance(exec: Span, options: {
  now?: () => number; startSpan?: typeof startPerformanceSpan;
  sampleIntervalMs?:number;resourceSampler?:()=>Promise<Record<string,unknown>>;
} = {}) {
  if (!exec.spanId) return noop;
  const now = options.now ?? (() => Number(process.hrtime.bigint()) / 1e6);
  const startSpan = options.startSpan ?? startPerformanceSpan;
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  let firstStdout: number | null = null, firstEvent: number | null = null, firstAgent: number | null = null;
  const seen = new Set<string>();
  const active = new Map<string, { span: Span; started: number }>();
  const overflowActive = new Map<string, number>();
  const overflowRecent = new Set<string>();
  let missingStart = 0, missingEnd = 0, omitted = 0;
  let observedStarts=0,measuredCount=0,trackingOverflow=0,dedupUncertain=false;
  let resourceSamples=0,resourceErrors=0;
  let durationSum = 0, busyUnion = 0, busySince: number | null = null, finished = false;
  const activeCount=()=>active.size+overflowActive.size;
  const recent=(id:string)=>{
    if(overflowRecent.has(id))return;
    if(overflowRecent.size>=MAX_OVERFLOW_RECENT){overflowRecent.delete(overflowRecent.values().next().value!);dedupUncertain=true;}
    overflowRecent.add(id);
  };
  const snapshot=()=>({tool_observed_start_count:observedStarts,tool_measured_count:measuredCount,
    tool_measured_duration_sum_ms:durationSum,tool_measured_busy_union_ms:busyUnion,
    tool_tracking_overflow_count:trackingOverflow,tool_active_count:activeCount(),
    tool_missing_start_count:missingStart,tool_omitted_count:omitted,
    tool_aggregate_timing_complete:missingStart===0&&trackingOverflow===0&&!dedupUncertain,
    tool_dedup_uncertain:dedupUncertain,resource_sample_count:resourceSamples,
    resource_sample_error_count:resourceErrors});
  const timer=setInterval(()=>{
    if(finished)return;
    void (options.resourceSampler??cgroupSample)().then(resource=>{
      if(finished)return;
      resourceSamples++;if(resource.resource_availability==='unavailable')resourceErrors++;
      exec.annotate({...snapshot(),...resource});
    }).catch(()=>{resourceErrors++;exec.annotate(snapshot());});
  },options.sampleIntervalMs??SAMPLE_INTERVAL_MS);
  timer.unref();
  return {
    stdout() { if (!finished && firstStdout === null) firstStdout = elapsed(); },
    jsonEvent() { if (!finished && firstEvent === null) firstEvent = elapsed(); },
    /** Call only after existing tool-containment checks accepted the event. */
    activity(event: Record<string, unknown>) {
      if (finished) return;
      if (!['item.started', 'item.updated', 'item.completed'].includes(String(event.type))) return;
      const item = event.item as Record<string, unknown> | undefined;
      if (!item || typeof item !== 'object') return;
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.length && firstAgent === null) firstAgent = elapsed();
      if (typeof item.type !== 'string' || !TOOL_TYPES.has(item.type)
        || !['item.started', 'item.completed'].includes(String(event.type))) return;
      if (typeof item.id !== 'string' || !item.id || item.id.length > 128) { omitted++; return; }
      const existing = active.get(item.id);
      const overflowStart=overflowActive.get(item.id);
      if (seen.has(item.id) && !existing || overflowRecent.has(item.id) && overflowStart===undefined) return;
      const time = elapsed();
      if (event.type === 'item.started') {
        if (existing || overflowStart!==undefined) return;
        observedStarts++;
        if (seen.size >= MAX_TOOL_ITEMS) {
          omitted++;recent(item.id);
          if(overflowActive.size>=MAX_OVERFLOW_ACTIVE){trackingOverflow++;return;}
          overflowActive.set(item.id,time);
          if(busySince===null)busySince=time;
          return;
        }
        seen.add(item.id);
        const attributes: Record<string, unknown> = { tool_type: item.type };
        if (item.type === 'mcp_tool_call' && ['bb_materials', 'bb_review'].includes(String(item.server))) {
          attributes.tool_server = item.server;
          if (typeof item.tool === 'string' && /^[a-z_]{1,64}$/.test(item.tool)) attributes.tool_name = item.tool;
        }
        active.set(item.id, { span: startSpan('model.tool', attributes), started: time });
        if (busySince === null) busySince = time;
      } else if (existing) {
        const failed = item.status === 'failed' || item.status === 'error' || item.isError === true
          || typeof item.exit_code === 'number' && item.exit_code !== 0;
        existing.span.end(failed ? 'failed' : 'succeeded', { timing_complete: true });
        durationSum += Math.max(0, time - existing.started);
        measuredCount++;
        active.delete(item.id);
        if (!activeCount() && busySince !== null) { busyUnion += Math.max(0, time - busySince); busySince = null; }
      } else if (overflowStart!==undefined) {
        durationSum+=Math.max(0,time-overflowStart);measuredCount++;
        overflowActive.delete(item.id);
        if(!activeCount()&&busySince!==null){busyUnion+=Math.max(0,time-busySince);busySince=null;}
      } else {
        // A completed-only item has no known start. Never fabricate a zero span.
        if (seen.size >= MAX_TOOL_ITEMS) { omitted++;recent(item.id);missingStart++;return; }
        seen.add(item.id); missingStart++;
      }
    },
    finish(status: Parameters<Span['end']>[0], attributes: Record<string, unknown> = {}) {
      if (finished) return;
      finished = true;clearInterval(timer);missingEnd = activeCount();
      for (const entry of active.values()) entry.span.end('interrupted', { timing_complete: false, end_missing: true });
      active.clear();overflowActive.clear();
      const complete = missingStart === 0 && missingEnd === 0 && omitted === 0;
      exec.end(status, { ...attributes, first_stdout_ms: firstStdout, first_event_ms: firstEvent,
        first_agent_message_observed_ms: firstAgent, ttft_ms: null, ttft_availability: 'not_exposed',
        tool_count: seen.size, tool_missing_end_count: missingEnd, tool_timing_complete: complete,
        tool_duration_sum_ms: complete ? durationSum : null, tool_busy_union_ms: complete ? busyUnion : null,
        ...snapshot(),tool_aggregate_timing_complete:missingStart===0&&missingEnd===0&&trackingOverflow===0&&!dedupUncertain });
    }
  };
}
