import { createHash } from 'node:crypto';
import type { ReviewAction, ReviewActionCode } from '@bondbuddy/contracts';

export type ReviewActionMode = 'review' | 'public_search' | 'public_compare' | 'revision';
const readTools = new Set(['list_materials','search_material','read_records']);
const object = (value:unknown):Record<string,unknown>|undefined =>
  value!==null && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined;

/** Only existing M3 calls may publish activity; ordinary authoring and assistant replies are untouched. */
export function reviewActionMode(call:string):ReviewActionMode|undefined {
  if(/^review-cli-v[23]-[a-f0-9]+$/.test(call))return 'review';
  if(call==='m3-public-search-v2'||call==='m3-public-search')return 'public_search';
  if(call==='m3-public-compare-v2'||/^m3-public-compare-\d+$/.test(call))return 'public_compare';
  if(call==='review-revision-cli-v1')return 'revision';
  return undefined;
}

function failed(value:unknown,depth=0):boolean {
  const v=object(value);if(!v)return false;
  if(v.isError===true || v.status==='failed' || v.status==='error' || (v.error!==undefined && v.error!==null))return true;
  if(depth>=2)return false;
  return ['result','output','structuredContent'].some(key=>failed(v[key],depth+1));
}

/** No textual CLI items, arguments or output fields survive this projection. */
export function projectReviewAction(event:Record<string,unknown>,callId:string,mode:ReviewActionMode):ReviewAction|null {
  if(event.type!=='item.started' && event.type!=='item.completed')return null;
  const item=object(event.item);
  if(!item || typeof item.id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item.id))return null;
  let code:ReviewActionCode|undefined;
  if(item.type==='mcp_tool_call'){
    if(mode==='review' && item.server==='bb_review'){
      if(typeof item.tool==='string' && readTools.has(item.tool))code='read_materials';
      else if(item.tool==='read_knowledge')code='read_knowledge';
      else if(item.tool==='check_financial')code='check_financial';
      else if(item.tool==='check_compliance')code='check_compliance';
    } else if(mode==='public_compare' && item.server==='bb_materials' && typeof item.tool==='string' && readTools.has(item.tool))code='compare_sources';
  } else if(mode==='public_search' && item.type==='web_search')code='search_public';
  else if(mode==='revision' && ['command_execution','file_change'].includes(String(item.type)))code='revise_document';
  if(!code)return null;
  // A tool item completing with an error is not a completed action. Unknown completion statuses are ignored.
  const hasFailed=failed(item) || (typeof item.exit_code==='number' && item.exit_code!==0);
  if(event.type==='item.completed' && !hasFailed && item.status!==undefined && !['completed','succeeded'].includes(String(item.status)))return null;
  return {version:'review-action-v1',action_id:createHash('sha256').update(`${callId}:${item.id}`).digest('hex'),code,
    state:event.type==='item.started'?'started':hasFailed?'failed':'completed'};
}

/** Bounded, serialized best-effort progress. The model path never awaits writes in a stdout callback. */
export function createReviewActionObserver(options:{mode:ReviewActionMode;signal:AbortSignal;
  persist:(action:ReviewAction)=>Promise<unknown>;onError?:()=>void;maxPending?:number}) {
  const limit=Math.max(1,Math.min(256,options.maxPending??64)),pending:ReviewAction[]=[];
  const seen=new Map<string,ReviewAction['state']>();
  let working:Promise<void>|undefined,closed=false;
  const pump=()=>{
    if(working)return;
    working=(async()=>{
      while(pending.length && !options.signal.aborted){
        const action=pending.shift()!;
        try { await options.persist(action); }
        catch { try { options.onError?.(); } catch { /* Progress diagnostics cannot change execution. */ } }
      }
      if(options.signal.aborted)pending.length=0;
    })().finally(()=>{working=undefined;if(pending.length&&!options.signal.aborted)pump();});
  };
  return {
    onEvent(event:Record<string,unknown>,intent:{call_id:string}){
      if(closed||options.signal.aborted)return;
      const action=projectReviewAction(event,intent.call_id,options.mode);if(!action)return;
      const prior=seen.get(action.action_id);
      if(prior && (prior===action.state || prior!=='started'))return;
      seen.set(action.action_id,action.state);
      if(seen.size>256)seen.delete(seen.keys().next().value!);
      // Under a burst preserve the newest real activity rather than retain an unbounded tool log.
      if(pending.length>=limit)pending.shift();
      pending.push(action);pump();
    },
    async drain(){closed=true;while(working)await working;},
  };
}
