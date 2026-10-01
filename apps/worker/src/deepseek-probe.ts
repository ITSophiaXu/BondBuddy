// Isolated #16 compatibility probe. It is deliberately not wired into runOnce.
// The caller owns a durable, owner-checked journal; recordIntent must commit before fetch.
import type { ProviderCallIntent as ProbeIntent, ProviderCallObservation as ProbeObservation, ProviderResultReference, ProviderUsage as Usage } from '@bondbuddy/api/provider-results';
export type { ProbeIntent, ProbeObservation, Usage };
export interface ProbeJournal {
  recordIntent(intent: ProbeIntent): Promise<void>;
  storeResult(intent: ProbeIntent, bytes: Buffer, schemaVersion: string): Promise<ProviderResultReference>;
  recordObservation(observation: ProbeObservation): Promise<void>;
}
export type ProbeInput = ProbeIntent & {
  apiKey: string; messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  stream: boolean; result_schema_version: string; signal?: AbortSignal; timeoutMs?: number;
  // Callers may only use immutable, owner-authorized prompt snapshots. No tools or URLs.
  validate: (value: unknown) => boolean;
};
const endpoint = 'https://api.deepseek.com/chat/completions';
const emptyUsage = (): Usage => ({status:'pending',input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null});
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function normalizeUsage(raw: unknown): Usage {
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const u = raw as Record<string,unknown>;
  const input=u.prompt_tokens, output=u.completion_tokens, total=u.total_tokens;
  const cached=u.prompt_cache_hit_tokens ?? (u.prompt_tokens_details as Record<string,unknown> | undefined)?.cached_tokens ?? null;
  const reasoning=(u.completion_tokens_details as Record<string,unknown> | undefined)?.reasoning_tokens ?? null;
  const valid=count(input) && count(output) && count(total) && total===input+output && (cached===null || (count(cached) && cached<=input)) && (reasoning===null || (count(reasoning) && reasoning<=output));
  if (!valid) return {status:'pending',input_tokens:count(input)?input:null,cached_input_tokens:count(cached)&&count(input)&&cached<=input?cached:null,output_tokens:count(output)?output:null,reasoning_tokens:count(reasoning)&&count(output)&&reasoning<=output?reasoning:null,total_tokens:count(total)?total:null};
  // Cached input and reasoning output are subsets, never extra tokens.
  return {status:'measured',input_tokens:input,cached_input_tokens:cached,output_tokens:output,reasoning_tokens:reasoning,total_tokens:total};
}

function parseSse(raw: string) {
  const chunks: unknown[]=[];
  let done=false;
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
    if (!data) continue;
    if (data==='[DONE]') {done=true;continue;}
    try {chunks.push(JSON.parse(data));} catch {throw new Error('INVALID_STREAM_JSON');}
  }
  return {chunks,done};
}

export async function runDeepSeekProbe(input: ProbeInput, journal: ProbeJournal, fetcher: typeof fetch = fetch): Promise<ProbeObservation> {
  if (!['deepseek-flash','deepseek-v4-pro'].includes(input.model_id) || !input.model_config_version || !input.prompt_snapshot_ref || !input.result_schema_version || !input.apiKey || !input.owner_user_id || !input.project_id || !input.job_id || !input.run_id || !input.trace_id || !input.messages.length || input.messages.some(m=>!['system','user','assistant'].includes(m.role) || typeof m.content!=='string')) throw new Error('INVALID_PROBE_INPUT');
  // A request cancelled before intent has no possible provider attempt to ledger.
  if (input.signal?.aborted) throw new Error('PROBE_CANCELLED_BEFORE_INTENT');
  const intent:ProbeIntent={owner_user_id:input.owner_user_id,project_id:input.project_id,job_id:input.job_id,run_id:input.run_id,trace_id:input.trace_id,logical_call_id:input.logical_call_id,call_id:input.call_id,attempt_no:input.attempt_no,model_id:input.model_id,model_config_version:input.model_config_version,prompt_snapshot_ref:input.prompt_snapshot_ref};
  await journal.recordIntent(intent);
  const base:ProbeObservation={...intent,provider_request_id:null,finish_reason:null,outcome:'pending_reconcile',usage:emptyUsage(),error_code:null,result_ref:null,result_sha256:null,result_schema_version:null,result_byte_size:null};
  const controller=new AbortController();
  const abort=()=>controller.abort();
  input.signal?.addEventListener('abort',abort,{once:true});
  const timer=input.signal?.aborted?null:setTimeout(abort,input.timeoutMs ?? 30000);
  let observation=base;
  try {
    // Intent may have committed while cancellation arrived. No fetch occurred.
    if (input.signal?.aborted) {observation={...observation,outcome:'confirmed_not_sent',usage:{...observation.usage,status:'unknown'},error_code:'CANCELLED'};return observation;}
    // No provider-side tools, external URLs, file access or automatic retry.
    const response=await fetcher(endpoint,{method:'POST',headers:{Authorization:`Bearer ${input.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:input.model_id,messages:[{role:'system',content:'Return one valid JSON object only.'},...input.messages],response_format:{type:'json_object'},stream:input.stream,...(input.stream?{stream_options:{include_usage:true}}:{})}),signal:controller.signal});
    const requestId=response.headers.get('x-request-id');
    observation={...observation,provider_request_id:requestId};
    if (!response.ok) {observation={...observation,outcome:'failed',error_code:`PROVIDER_HTTP_${response.status}`};return observation;}
    const raw=await response.text();
    let content='',finishReason:null|string=null,usage:Usage=emptyUsage(),providerId=requestId;
    if (input.stream) {
      const parsed=parseSse(raw);
      let finalUsageObserved=false;
      for(const [index,item] of parsed.chunks.entries()) {
        const chunk=item as Record<string,unknown>;
        providerId=providerId ?? (typeof chunk.id==='string'?chunk.id:null);
        const choice=(chunk.choices as Record<string,unknown>[] | undefined)?.[0];
        const delta=choice?.delta as Record<string,unknown> | undefined;
        if (typeof delta?.content==='string') content+=delta.content;
        if (typeof choice?.finish_reason==='string') finishReason=choice.finish_reason;
        // Earlier reports remain evidence, but only the last frame can establish a final total.
        if (chunk.usage) {usage=normalizeUsage(chunk.usage);finalUsageObserved=index===parsed.chunks.length-1;}
        if (delta?.tool_calls || (choice?.message as Record<string,unknown> | undefined)?.tool_calls) throw new Error('TOOL_DENIED');
      }
      if (!parsed.done || !finishReason) throw new Error('INTERRUPTED_STREAM');
      if (!finalUsageObserved) usage={...usage,status:'pending'};
    } else {
      let body:Record<string,unknown>;
      try {body=JSON.parse(raw);} catch {throw new Error('INVALID_PROVIDER_JSON');}
      providerId=providerId ?? (typeof body.id==='string'?body.id:null);
      const choice=(body.choices as Record<string,unknown>[] | undefined)?.[0];
      const message=choice?.message as Record<string,unknown> | undefined;
      if (message?.tool_calls) throw new Error('TOOL_DENIED');
      content=typeof message?.content==='string'?message.content:'';
      finishReason=typeof choice?.finish_reason==='string'?choice.finish_reason:null;
      usage=normalizeUsage(body.usage);
    }
    observation={...observation,provider_request_id:providerId,finish_reason:finishReason,usage};
    if (finishReason!=='stop') throw new Error('INCOMPLETE_OUTPUT');
    let value:unknown;
    try {value=JSON.parse(content);} catch {throw new Error('INVALID_MODEL_JSON');}
    if (!input.validate(value)) throw new Error('SCHEMA_REJECTED');
    // Preserve a schema-checked JSON value in private, content-addressed Blob storage
    // even when supplier token evidence is incomplete. It remains non-reusable until
    // durable reconciliation sees agreed measured usage.
    let result:ProviderResultReference;
    try { result=await journal.storeResult(intent,Buffer.from(JSON.stringify(value)),input.result_schema_version); }
    catch { throw new Error('RESULT_STORE_FAILED'); }
    observation={...observation,...result};
    if (usage.status!=='measured') throw new Error('USAGE_PENDING');
    observation={...observation,outcome:'completed'};
    return observation;
  } catch(error) {
    const code=error instanceof Error && ['INVALID_STREAM_JSON','TOOL_DENIED','INTERRUPTED_STREAM','INVALID_PROVIDER_JSON','INCOMPLETE_OUTPUT','INVALID_MODEL_JSON','SCHEMA_REJECTED','USAGE_PENDING','RESULT_STORE_FAILED'].includes(error.message)?error.message:'PROVIDER_TRANSPORT_UNKNOWN';
    observation={...observation,error_code:controller.signal.aborted?(input.signal?.aborted?'CANCELLED':'TIMEOUT'):code};
    // A sent call with uncertain final state remains pending; never auto resend it.
    return observation;
  } finally {
    if(timer)clearTimeout(timer);input.signal?.removeEventListener('abort',abort);
    await journal.recordObservation(observation);
  }
}
