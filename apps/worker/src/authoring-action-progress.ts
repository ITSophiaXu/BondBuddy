import {createHash} from 'node:crypto';
import {AUTHORING_ACTIVITY_LABELS,type AuthoringActivity} from '@bondbuddy/contracts';
const object=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
/** Only explicit public progress messages survive; reasoning and tool output remain private. */
export function projectAuthoringActivity(event:Record<string,unknown>,callId:string):AuthoringActivity|null {
  if(!['item.started','item.updated','item.completed'].includes(String(event.type)))return null;
  const item=object(event.item);
  if(!item||typeof item.id!=='string'||item.id.length>128)return null;
  let code:AuthoringActivity['code']|undefined;
  let summary:string|undefined;
  if(item.type==='reasoning')code='analyze';
  else if(item.type==='file_change')code='write_document';
  else if(item.type==='image_view')code='check_document';
  else if(item.type==='command_execution'){
    const command=String(item.command??'');
    code=command.includes('read_material.py')?'read_materials':command.includes('word_patch.py')?'write_document':'process_document';
  }else if(item.type==='agent_message'&&typeof item.text==='string'){
    const match=/^BB_PROGRESS:([a-z_]+)(?:\s*\|\s*([^\r\n]{1,240}))?\s*$/.exec(item.text.trim());
    if(match&&Object.hasOwn(AUTHORING_ACTIVITY_LABELS,match[1])){
      code=match[1] as AuthoringActivity['code'];
      // A status sentence is data, never HTML or an instruction. Discard technical payloads.
      const text=match[2]?.trim();
      if(text&&!/[<>`{}\u0000-\u001f]|https?:|[A-Za-z]:\\|\/(?:tmp|home|users|data|workspace)\b|api[_-]?key|bearer\s|token\s*[:=]/i.test(text))summary=text;
    }
  }
  if(!code)return null;
  const failed=item.status==='failed'||item.status==='error'||item.isError===true||(typeof item.exit_code==='number'&&item.exit_code!==0);
  return {activity_id:createHash('sha256').update(callId+':'+item.id).digest('hex'),code,...(summary?{summary}:{}),
    state:failed?'failed':event.type==='item.completed'&&item.type!=='agent_message'?'completed':'started'};
}
/** Bounded, serialized best-effort progress. The model path never awaits writes in a stdout callback. */
export function createAuthoringActivityObserver(options:{signal:AbortSignal;
  persist:(action:AuthoringActivity)=>Promise<unknown>;onError?:()=>void;maxPending?:number}) {
  const limit=Math.max(1,Math.min(256,options.maxPending??64)),pending:AuthoringActivity[]=[];
  const seen=new Map<string,AuthoringActivity['state']>();
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
      const action=projectAuthoringActivity(event,intent.call_id);if(!action)return;
      const prior=seen.get(action.activity_id);
      if(prior && (prior===action.state || prior!=='started'))return;
      seen.set(action.activity_id,action.state);
      if(seen.size>256)seen.delete(seen.keys().next().value!);
      // Under a burst preserve the newest real activity rather than retain an unbounded tool log.
      if(pending.length>=limit)pending.shift();
      pending.push(action);pump();
    },
    async drain(){closed=true;while(working)await working;},
  };
}
