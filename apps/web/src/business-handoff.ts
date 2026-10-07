import type { M4MaterialPin, M4HandoffBindResponse } from '@bondbuddy/contracts';
import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import { M4Api } from './m4-api';
import { esc } from './ui';

export type BusinessHandoff = { topicId:string; messageId:string; messageVersion:number; intent:string; source:M4MaterialPin|null; sourceProjectId:string|null };
export function handoffParams(query:URLSearchParams){
  const result=new URLSearchParams();for(const key of ['handoff_topic','handoff_message']){const value=query.get(key);if(value)result.set(key,value);}return result;
}
export function carryHandoff(query:URLSearchParams){const params=handoffParams(query);return params.size?'&'+params.toString():'';}
export async function mountBusinessHandoff(api:ApiClient,host:HTMLElement,query:URLSearchParams,current:()=>boolean,adopt?:(handoff:BusinessHandoff)=>Promise<void>){
  const topic=query.get('handoff_topic'),message=query.get('handoff_message');if(!topic||!message)return;
  host.innerHTML='<section class="m4-accepted"><p role="status">正在核对助手带入的需求与来源…</p></section>';
  try{
    const workspace=await new M4Api(api,new AbortController().signal).workspace(topic);
    const origin=workspace.messages.find(m=>m.message_id===message&&m.role==='user');if(!origin)throw new ApiError(404,'NOT_FOUND');
    const handoff:BusinessHandoff={topicId:topic,messageId:message,messageVersion:origin.version,intent:origin.content,source:structuredClone(origin.context.source_material),sourceProjectId:origin.context.source_material?.source_project_id??workspace.topic.source_project_id};
    if(!current()||!host.isConnected)return;
    host.innerHTML=`<section class="m4-accepted"><strong>从材料与问答助手带入的需求</strong><p>${esc(handoff.intent)}</p><p>原消息 ${esc(message)} · <a href="#generate?topic=${encodeURIComponent(topic)}">查看原讨论</a></p>${handoff.source?`<p>准确来源：项目 ${esc(handoff.source.source_project_id)} · 材料 ${esc(handoff.source.material_id)} · V${handoff.source.material_version}<br>SHA-256 ${esc(handoff.source.sha256)}</p>`:`<p class="m4-warning">尚未固定募集书来源。${handoff.sourceProjectId?'已关联项目 '+esc(handoff.sourceProjectId)+'；':''}请在目标工作区明确选择待处理稿及版本。</p>`}<p>请核对目标业务、报告期及范围。采用只保存来源和要求，执行仍需核对报价并明确开始。</p>${adopt?`<button class="btn secondary" data-handoff-adopt>${handoff.source?'采用来源及需求':'采用需求，继续核对来源'}</button>`:'<p>创建目标项目后可明确采用这条需求与准确来源。</p>'}<p data-handoff-status role="status"></p></section>`;
    host.querySelector<HTMLButtonElement>('[data-handoff-adopt]')?.addEventListener('click',async event=>{const button=event.currentTarget as HTMLButtonElement,status=host.querySelector<HTMLElement>('[data-handoff-status]')!;button.disabled=true;status.textContent='正在保存目标任务草稿…';try{await adopt!(handoff);if(current()&&host.isConnected)status.textContent=handoff.source?'来源与需求已采用到目标草稿，尚未执行。':'需求已采用；尚未绑定募集书来源，请继续核对来源，尚未执行。';}catch(error){if(current()&&host.isConnected){status.textContent=`${friendlyError(error)} 原始需求与准确来源保留，请核对后重试。`;button.disabled=false;}}});
  }catch(error){if(current()&&host.isConnected)host.innerHTML=`<section class="m4-warning" role="alert">带入需求暂不可读取。${esc(friendlyError(error))} 请返回原讨论核对；当前业务未执行。</section>`;}
}

/** Copy only after explicit adoption; both read and new upload use existing owner-authorized APIs. */
export async function copyHandoffSource(api:ApiClient,handoff:BusinessHandoff,targetProjectId:string,signal:AbortSignal):Promise<Dto<'MaterialResponse'>|null>{
  const pin=handoff.source;if(!pin)return null;
  const {binding}=await api.request<M4HandoffBindResponse>('POST',`/m4/topics/${encodeURIComponent(handoff.topicId)}/handoffs/bind`,{message_id:handoff.messageId,message_version:handoff.messageVersion,target_project_id:targetProjectId,source_material:pin},{},signal);
  if(binding.topic_id!==handoff.topicId||binding.message_id!==handoff.messageId||binding.message_version!==handoff.messageVersion||binding.target_project_id!==targetProjectId||binding.source_material.source_project_id!==pin.source_project_id||binding.source_material.material_id!==pin.material_id||binding.source_material.material_version!==pin.material_version||binding.source_material.sha256!==pin.sha256)throw new ApiError(0,'DATA_UNAVAILABLE');
  const source=await api.material(pin.source_project_id,pin.material_id,signal);
  if(source.material_version!==pin.material_version||source.sha256!==pin.sha256)throw new ApiError(409,'INPUT_REVISION_CONFLICT');
  if(!['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(source.media_type))throw new ApiError(422,'INPUT_REQUIRED');
  const ids=new Set<string>();let cursor=0;for(;;){const page=await api.projectEvents(targetProjectId,cursor,signal);for(const event of page.items)if(event.type==='material.upload_progress'&&event.payload.material_id)ids.add(event.payload.material_id);if(page.next_cursor===null||page.next_cursor<=cursor)break;cursor=page.next_cursor;}
  const records=await Promise.allSettled([...ids].map(id=>api.material(targetProjectId,id,signal)));
  const duplicate=records.flatMap(result=>result.status==='fulfilled'?[result.value]:[]).find(m=>m.role==='historical'&&m.sha256===pin.sha256&&m.state==='persisted');if(duplicate)return duplicate;
  const bytes=await api.materialBytes(pin.source_project_id,source,signal);
  const session=await api.createUpload(targetProjectId,{filename:source.filename,media_type:source.media_type,byte_size:bytes.size,sha256:source.sha256,role:'historical'},signal);
  await api.uploadBytes(session.upload_url,new File([bytes],source.filename,{type:source.media_type}),()=>{},signal);
  return api.completeUpload(targetProjectId,session.upload_id,{byte_size:bytes.size,sha256:source.sha256},signal);
}
