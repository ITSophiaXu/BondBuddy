import {PROJECT_DOCUMENT_CATALOG,WORKPAPER_DECISION_LABELS,type FileGenerationBatch,type ProjectFileWorkspace,type M4ArtifactPin} from './billing-types.js';
import {esc} from './ui.js';

export const deliveryKinds={document:'实际文档',explanation:'情况说明',unfinished:'未完成',unknown:'待核对'} as const;
type Kind=keyof typeof deliveryKinds;
export type DeliveryFile={filename:string;pin?:M4ArtifactPin;runId?:string;explanation?:{batchId:string;itemId:string;sha256:string}};
export type DeliveryRow={key:string;title:string;source:string;kind:Kind;reason:string;missing:string[];files:DeliveryFile[];href?:string;linkLabel:string};
const validPin=(pin:M4ArtifactPin)=>!!pin.source_project_id&&!!pin.artifact_id&&Number.isSafeInteger(pin.artifact_version)&&pin.artifact_version>0&&/^[a-f0-9]{64}$/.test(pin.sha256);
const knownUnfinished=new Set(['preparing','queued','running','validating','delivering','settlement_pending','paused','awaiting_input','failed','rejected','cancelled']);
const unknown='本次任务的成果尚未读取完整；不会使用后来同类文件替代。';
/** Presentation projection only: enumerate the embedded submitted child batches, never current preparation or latest-by-type results. */
export function deliveryRows(batch:FileGenerationBatch,project:string,workspace?:ProjectFileWorkspace):DeliveryRow[]{
 const rows:DeliveryRow[]=[];
 const wp=batch.workpapers,counts=new Map<string,number>();
 for(const item of wp?.items??[])counts.set(item.entry.id,(counts.get(item.entry.id)??0)+1);
 if(wp)for(const item of wp.items){
  const repeated=counts.get(item.entry.id)!==1;
  const decision=item.decision?.item_id===item.entry.id&&Object.hasOwn(WORKPAPER_DECISION_LABELS,item.decision.status)?item.decision:undefined;
  const artifacts=item.artifacts.filter(a=>a.kind==='document');
  const valid=!repeated&&!!item.run_id&&artifacts.length===1&&validPin(artifacts[0].pin);
  const explanation=!repeated&&item.explanation&&/^[a-f0-9]{64}$/.test(item.explanation.sha256)?item.explanation:undefined;
  const kind:Kind=repeated?'unknown':item.state==='succeeded'&&valid&&!explanation?'document':explanation&&!artifacts.length?'explanation':knownUnfinished.has(item.state)&&!explanation?'unfinished':'unknown';
  rows.push({key:'wp:'+wp.batch_id+':'+item.entry.id,title:[item.entry.code,item.entry.title].filter(Boolean).join(' '),source:'底稿 · '+wp.source.filename+' · V'+wp.source.sequence,kind,
   reason:kind==='unknown'?unknown:decision&&decision.status!=='generate'?WORKPAPER_DECISION_LABELS[decision.status]+'：'+decision.reason:kind==='explanation'?'说明原因尚未分类，请阅读原说明；不能据此认定业务不适用。':kind==='document'?'本任务文档已生成，仍需人工审阅。':item.error||'本项尚未完成；请查看原批次的任务状态。',missing:decision?.missing_materials??[],
   files:kind==='document'?item.artifacts.filter(a=>validPin(a.pin)).map(a=>({filename:a.filename,pin:a.pin,runId:item.run_id!})):kind==='explanation'?[{filename:explanation!.filename,explanation:{batchId:wp.batch_id,itemId:item.entry.id,sha256:explanation!.sha256}}]:[],
   href:repeated?undefined:'#generate?'+new URLSearchParams({project,step:'workpapers',view:'results',batch:wp.batch_id}),linkLabel:'查看原底稿批次'});
 }
 const w=workspace?.project_id===project&&workspace.workspace.topic.source_project_id===project?workspace.workspace:undefined;
 if(batch.documents)for(const item of batch.documents.items){
  const matches=w?.tasks.filter(t=>t.run.run_id===item.run_id)??[],task=matches.length===1?matches[0]:undefined;
  const bound=task?.manifest.kind==='document'&&task.manifest.input.document_type===item.document_type&&task.manifest.topic_id===w?.topic.topic_id&&task.run.project_id===w?.topic.project_id&&task.manifest.input.project_file?.project_id===project;
  const artifacts=bound?task!.artifacts.filter(a=>a.kind!=='qa_text'&&a.run_id===item.run_id&&a.document_type===item.document_type&&a.topic_id===w!.topic.topic_id&&a.source_project_id===task!.run.project_id&&validPin(a)):[];
  const documents=artifacts.filter(a=>a.kind==='document');
  const repeated=batch.documents.items.filter(i=>i.document_type===item.document_type||!!i.run_id&&i.run_id===item.run_id).length!==1;
  const kind:Kind=repeated?'unknown':bound&&item.state==='succeeded'&&task?.run.state==='succeeded'&&documents.length===1?'document':knownUnfinished.has(item.state)?'unfinished':'unknown';
  const source=bound&&task!.manifest.kind==='document'&&wp&&wp.source.version_id===task!.manifest.input.project_file?.source_version_id?wp.source.filename+' · V'+wp.source.sequence:'来源详情见原任务';
  rows.push({key:'doc:'+batch.documents.batch_id+':'+item.document_type,title:PROJECT_DOCUMENT_CATALOG.find(d=>d.id===item.document_type)?.name??item.document_type,source:'其他文件 · '+source,kind,reason:kind==='document'?'本任务文档已生成，仍需人工审阅。':kind==='unknown'?unknown:item.error||'本项尚未完成；请查看原任务的处理状态。',missing:[],files:kind==='document'?artifacts.map(a=>({filename:a.filename,pin:a,runId:item.run_id!})):[],
   href:!repeated&&item.run_id&&w?'#generate?'+new URLSearchParams({project,topic:w.topic.topic_id,run:item.run_id,return_project:project}):undefined,linkLabel:'查看原任务'});
 }
 return rows;
}
export function deliveryChecklistHtml(batch:FileGenerationBatch,rows:DeliveryRow[],open=false){
 return `<details class="fg-delivery" data-delivery-batch="${esc(batch.batch_id)}" ${open?'open':''}><summary>本批交付清单 · ${rows.length} 项</summary><div class="fg-delivery-body"><p class="fg-delivery-note">只列本次提交的底稿及其他文件；文档已生成不代表专业审核通过。情况说明不等同于实际文档。</p><dl class="fg-delivery-stats">${Object.entries(deliveryKinds).map(([kind,label])=>`<div><dt>${label}</dt><dd>${rows.filter(r=>r.kind===kind).length}</dd></div>`).join('')}</dl>${!rows.length?'<p>本批原清单暂未提供，范围待核对；不使用当前准备清单代替。</p>':''}<ul class="fg-delivery-list">${rows.map(row=>`<li data-delivery-row="${esc(row.key)}"><div><strong>${esc(row.title)}</strong><p>${esc(row.source)}</p><span class="fg-delivery-tag" data-kind="${row.kind}">${deliveryKinds[row.kind]}</span><p>${esc(row.reason)}</p>${row.missing.length?`<p>需补充：${row.missing.map(esc).join('、')}</p>`:''}</div><div class="fg-delivery-files">${row.files.map((file,index)=>`<button type="button" class="btn secondary" data-delivery-download="${esc(row.key)}" data-delivery-file="${index}" data-delivery-parent="${esc(batch.batch_id)}">${file.explanation?'下载情况说明':'下载 '+esc(file.filename)+' · V'+file.pin!.artifact_version}</button>`).join('')}${row.href?`<a href="${esc(row.href)}">${row.linkLabel}</a>`:''}</div></li>`).join('')}</ul><p class="fg-delivery-note">资料不足不等于业务不适用。补齐材料后仍需明确准备下一轮，不会自动重跑本批。</p><p role="status" data-delivery-status></p></div></details>`;
}
