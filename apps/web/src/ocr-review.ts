import type { ApiClient } from './api';
import { ApiError, friendlyError } from './api';
import { esc } from './ui';
import type { OcrReview, OcrCorrectionRequest } from '@bondbuddy/contracts';

let activeReview: { canLeave:()=>boolean; dispose:()=>void } | undefined;
export const canLeaveOcrReview=()=>activeReview?.canLeave()??true;
export function disposeOcrReview(){activeReview?.dispose();activeReview=undefined;}

type Context={api:ApiClient;shell:(content:string,section:string)=>void;epoch:()=>number};
export async function renderOcrReview(context:Context,projectId:string,materialId:string) {
  const token=context.epoch();
  const path=`/projects/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(materialId)}/ocr`;
  let review:OcrReview;
  try {review=await context.api.request<OcrReview>('GET',path);}
  catch(error){
    if(token!==context.epoch())return;
    context.shell(`<a class="back-link" href="#/projects/${encodeURIComponent(projectId)}">← 返回项目</a><h1>材料识别核对</h1><p class="form-message" role="status">${esc(error instanceof ApiError && error.status===404?'此材料暂时没有可查看的识别结果，或已无法访问。':friendlyError(error))}</p><p id="page-error" role="alert" hidden></p>`,'projects');return;
  }
  if(token!==context.epoch())return;
  context.shell(`<a class="back-link" href="#/projects/${encodeURIComponent(projectId)}">← 返回项目</a><div class="page-heading"><div><h1>材料识别核对</h1><p class="muted">对照原页片段，保存你的校正说明。用户校正不等于审计确认。</p></div></div>
    <p class="ocr-notice">${review.coverage==='partial'?`本次预检覆盖前 ${review.pages.length} / ${review.page_count} 页，不能代表全文已处理。`:`已处理 ${review.page_count} 页，文字、期间、单位与表格结构仍需核对。`} 跨页表格尚未自动合并。${review.records.length?'':'未识别到可核对文字，请补充清晰材料。'}</p>
    <div class="ocr-layout"><section class="panel ocr-records"><label for="ocr-filter">待核对内容</label><input id="ocr-filter" type="search" placeholder="按识别文字搜索"/><p id="ocr-count" class="muted" role="status"></p><div id="ocr-record-list"></div></section><section class="panel form-panel" id="ocr-detail"><p>从左侧选择一处识别内容。</p></section></div><p id="page-error" role="alert" hidden></p>`,'projects');
  const list=document.querySelector<HTMLElement>('#ocr-record-list')!;
  const latest=(id:string)=>review.corrections.filter(c=>c.record_id===id).sort((a,b)=>b.revision-a.revision)[0];
  let selected:string|undefined;
  let dirty=false;
  let submitting=false;
  let selectedGeneration=0;
  const protectUnload=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue='';}};
  window.addEventListener('beforeunload',protectUnload);
  activeReview={canLeave:()=>!submitting&&(!dirty||window.confirm('校正内容尚未保存，离开会放弃本次输入，是否继续？')),
    dispose:()=>{dirty=false;selectedGeneration++;window.removeEventListener('beforeunload',protectUnload);}};
  function drawList() {
    const query=document.querySelector<HTMLInputElement>('#ocr-filter')!.value.trim().toLowerCase();
    const shown=review.records.filter(record=>record.text.toLowerCase().includes(query));
    document.querySelector('#ocr-count')!.textContent=`${shown.length} 处识别内容 · 已记录 ${new Set(review.corrections.map(c=>c.record_id)).size} 处用户校正`;
    list.innerHTML=shown.slice(0,500).map(record=>`<button type="button" class="ocr-record ${record.record_id===selected?'selected':''}" data-record="${esc(record.record_id)}"><span>第 ${record.page} 页${record.cell?` · 表 ${esc(record.cell.table_id)} / 行 ${record.cell.row} / 列 ${record.cell.column}`:''}</span><strong>${esc(record.text||(record.numeric.kind==='blank'?'（空白单元格）':'（未识别文字）'))}</strong><small>${latest(record.record_id)?'已有用户校正':'待核对'} · ${record.confidence===null?'置信度未知':`识别置信度 ${Math.round(record.confidence*100)}%`}</small></button>`).join('')+(shown.length>500?'<p>匹配内容较多，请缩小搜索范围。</p>':'');
  }
  const select=async(id:string)=>{
    if(submitting)return;
    if(dirty&&!window.confirm('当前校正尚未保存，切换会放弃输入，是否继续？'))return;
    const record=review.records.find(record=>record.record_id===id);if(!record)return;
    dirty=false;selected=id;const generation=++selectedGeneration;drawList();
    const correction=latest(id),page=review.pages.find(page=>page.page===record.page)!;
    const detail=document.querySelector<HTMLElement>('#ocr-detail')!;
    detail.innerHTML=`<h2>第 ${record.page} 页原文片段</h2><p class="muted">${record.cell?`表格第 ${record.cell.row} 行、第 ${record.cell.column} 列，跨 ${record.cell.row_span} 行 / ${record.cell.column_span} 列（结构待确认）`:'文字段落'}</p><canvas id="ocr-crop" aria-label="原页识别位置片段"></canvas><p id="ocr-image-status" role="status">正在读取原页…</p><a class="back-link" href="${esc(page.image_url)}" target="_blank" rel="noopener">查看完整原页</a>
      <p>原始识别：<strong>${esc(record.text||(record.numeric.kind==='blank'?'（空白）':'（未识别文字）'))}</strong></p><form id="ocr-correction"><label for="corrected-text">校正后文字或数值</label><textarea id="corrected-text" maxlength="4000">${esc(correction?.corrected_text??record.text)}</textarea>
      <div class="ocr-context-fields"><div><label for="ocr-period">所属期间</label><input id="ocr-period" maxlength="200" value="${esc(correction?.period)}" placeholder="如：2025 年末；未知可留空"/></div><div><label for="ocr-unit">单位</label><input id="ocr-unit" maxlength="200" value="${esc(correction?.unit)}" placeholder="如：万元；未知可留空"/></div></div>
      <label for="ocr-scope">主体与合并口径</label><input id="ocr-scope" maxlength="500" value="${esc(correction?.scope)}" placeholder="如：发行人合并报表；未知可留空"/>
      <label for="ocr-reason">校正依据 / 说明</label><textarea id="ocr-reason" required maxlength="2000">${esc(correction?.reason)}</textarea><p class="muted">留空不代表零值。缺少期间、单位或口径仍需补充；确认不会把资料标记为已审计。</p><p id="ocr-save-status" role="status"></p><button class="button primary" type="submit" disabled>保存用户校正</button></form>
      <details class="ocr-history"><summary>校正记录（${review.corrections.filter(c=>c.record_id===id).length}）</summary>${review.corrections.filter(c=>c.record_id===id).map(c=>`<p>v${c.revision} · ${esc(c.created_at)} · ${esc(c.corrected_text)}<br/>说明：${esc(c.reason)}</p>`).join('')}</details>`;
    const image=new Image();image.src=page.image_url;
    image.onload=()=>{if(token!==context.epoch()||generation!==selectedGeneration)return;const canvas=document.querySelector<HTMLCanvasElement>('#ocr-crop')!;
      const [x,y,right,bottom]=record.bbox,margin=50,left=Math.max(0,x-margin),top=Math.max(0,y-margin),width=Math.min(page.width,right+margin)-left,height=Math.min(page.height,bottom+margin)-top;
      const scale=Math.min(1,1400/width);canvas.width=Math.ceil(width*scale);canvas.height=Math.ceil(height*scale);
      const ctx=canvas.getContext('2d')!;ctx.drawImage(image,left,top,width,height,0,0,canvas.width,canvas.height);ctx.strokeStyle='#b14a16';ctx.lineWidth=2;ctx.strokeRect((x-left)*scale,(y-top)*scale,(right-x)*scale,(bottom-y)*scale);
      document.querySelector('#ocr-image-status')!.textContent='框线标出本处识别范围。';
      document.querySelector<HTMLButtonElement>('#ocr-correction button')!.disabled=false;};
    image.onerror=()=>{if(token===context.epoch()&&generation===selectedGeneration)document.querySelector('#ocr-image-status')!.textContent='原页暂时无法读取，请稍后重试。';};
    const form=document.querySelector<HTMLFormElement>('#ocr-correction')!;
    form.addEventListener('input',()=>{dirty=true;});
    let pending:OcrCorrectionRequest|undefined;
    form.addEventListener('submit',async event=>{
      event.preventDefault();const button=form.querySelector<HTMLButtonElement>('button')!;if(button.disabled)return;
      const value=(selector:string)=>(form.querySelector<HTMLInputElement|HTMLTextAreaElement>(selector)!.value);
      const fields={snapshot_id:review.snapshot_id,record_id:id,result_sha256:review.result_sha256,expected_revision:latest(id)?.revision??0,corrected_text:value('#corrected-text'),reason:value('#ocr-reason'),period:value('#ocr-period')||null,scope:value('#ocr-scope')||null,unit:value('#ocr-unit')||null};
      if(!pending||JSON.stringify({...pending,request_id:undefined})!==JSON.stringify(fields))pending={...fields,request_id:crypto.randomUUID()};
      submitting=true;const controls=[...form.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('input,textarea')];controls.forEach(control=>control.disabled=true);
      button.disabled=true;const status=form.querySelector<HTMLElement>('#ocr-save-status')!;status.textContent='正在保存…';
      try {await context.api.request('POST',`${path}/corrections`,pending);const updated=await context.api.request<OcrReview>('GET',path);
        if(token!==context.epoch())return;review=updated;dirty=false;submitting=false;await select(id);document.querySelector('#ocr-save-status')!.textContent='用户校正已保存，原始识别和历史记录已保留。';
      } catch(error){if(token===context.epoch())status.textContent=error instanceof ApiError&&error.status===409?'识别或校正版本已变化。当前输入保留，请复制后重新打开核对页。':friendlyError(error);}
      finally{submitting=false;button.disabled=false;controls.forEach(control=>control.disabled=false);}
    });
  };
  list.addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLElement>('[data-record]');if(button)void select(button.dataset.record!);});
  document.querySelector('#ocr-filter')!.addEventListener('input',drawList);drawList();
}
