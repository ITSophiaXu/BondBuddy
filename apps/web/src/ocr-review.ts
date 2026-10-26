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
    context.shell(`<a class="back-link" href="#/projects/${encodeURIComponent(projectId)}">← 返回项目</a><h1>材料识别核对</h1><p class="form-message" role="status">${esc(error instanceof ApiError && error.status===404?'此材料暂时没有可查看的识别结果，或已无法访问。':friendlyError(error,'read'))}</p><p id="page-error" role="alert" hidden></p>`,'projects');return;
  }
  if(token!==context.epoch())return;
  context.shell(`<a class="back-link" href="#/projects/${encodeURIComponent(projectId)}">← 返回项目</a><div class="page-heading"><div><h1>材料识别核对</h1><p class="muted">对照原页片段，保存你的校正说明。用户校正不等于审计确认。</p></div></div>
    <p class="ocr-notice">${review.coverage==='partial'?`本次预检覆盖前 ${review.pages.length} / ${review.page_count} 页，不能代表全文已处理。`:`已处理 ${review.page_count} 页，文字、期间、单位与表格结构仍需核对。`} 跨页表格尚未自动合并。${review.records.length?'':'未识别到可核对文字，请补充清晰材料。'}</p>
    <div class="ocr-layout"><section class="panel ocr-records"><label for="ocr-page-filter">原件页码</label><select id="ocr-page-filter"><option value="">全部已识别页</option>${review.pages.map(page=>`<option value="${page.page}">第 ${page.page} 页</option>`).join('')}</select><label for="ocr-filter">待核对内容</label><input id="ocr-filter" type="search" placeholder="按识别文字搜索"/><p id="ocr-count" class="muted" role="status"></p><div id="ocr-record-list"></div><nav class="ocr-pagination" aria-label="识别内容翻页"><button type="button" class="button secondary" id="ocr-previous">上一组</button><button type="button" class="button secondary" id="ocr-next">下一组</button></nav></section><section class="panel form-panel" id="ocr-detail"><p>从左侧选择一处识别内容。</p></section></div><p id="page-error" role="alert" hidden></p>`,'projects');
  const list=document.querySelector<HTMLElement>('#ocr-record-list')!;
  const pageFilter=document.querySelector<HTMLSelectElement>('#ocr-page-filter')!;
  const textFilter=document.querySelector<HTMLInputElement>('#ocr-filter')!;
  const previous=document.querySelector<HTMLButtonElement>('#ocr-previous')!;
  const next=document.querySelector<HTMLButtonElement>('#ocr-next')!;
  const groupSize=500;
  let offset=0;
  const latest=(id:string)=>review.corrections.filter(c=>c.record_id===id).sort((a,b)=>b.revision-a.revision)[0];
  let selected:string|undefined;
  let dirty=false;
  let submitting=false;
  let selectedGeneration=0;
  let activeImage:HTMLImageElement|undefined;
  const clearImage=()=>{if(activeImage){activeImage.onload=null;activeImage.onerror=null;activeImage.removeAttribute('src');activeImage=undefined;}};
  const protectUnload=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue='';}};
  window.addEventListener('beforeunload',protectUnload);
  activeReview={canLeave:()=>!submitting&&(!dirty||window.confirm('校正内容尚未保存，离开会放弃本次输入，是否继续？')),
    dispose:()=>{dirty=false;selectedGeneration++;clearImage();window.removeEventListener('beforeunload',protectUnload);}};
  function drawList() {
    const query=textFilter.value.trim().toLowerCase();
    const shown=review.records.filter(record=>(!pageFilter.value||record.page===Number(pageFilter.value))&&record.text.toLowerCase().includes(query));
    offset=Math.min(offset,Math.max(0,Math.floor((shown.length-1)/groupSize)*groupSize));
    const end=Math.min(offset+groupSize,shown.length);
    document.querySelector('#ocr-count')!.textContent=`${shown.length} 处识别内容 · 显示 ${shown.length?offset+1:0}–${end} 处 · 已记录 ${new Set(review.corrections.map(c=>c.record_id)).size} 处用户校正`;
    previous.disabled=offset===0;next.disabled=end>=shown.length;
    list.innerHTML=shown.slice(offset,end).map(record=>`<button type="button" class="ocr-record ${record.record_id===selected?'selected':''}" data-record="${esc(record.record_id)}"><span>第 ${record.page} 页${record.cell?` · 表 ${esc(record.cell.table_id)} / 行 ${record.cell.row} / 列 ${record.cell.column}`:''}</span><strong>${esc(record.text||(record.numeric.kind==='blank'?'（空白单元格）':'（未识别文字）'))}</strong><small>${latest(record.record_id)?'已有用户校正':'待核对'} · ${record.confidence===null?'置信度未知':`识别置信度 ${Math.round(record.confidence*100)}%`}</small></button>`).join('')||'<p>没有匹配的识别内容。</p>';
  }
  const select=async(id:string)=>{
    if(submitting)return;
    if(dirty&&!window.confirm('当前校正尚未保存，切换会放弃输入，是否继续？'))return;
    const record=review.records.find(record=>record.record_id===id);if(!record)return;
    dirty=false;selected=id;const generation=++selectedGeneration;clearImage();drawList();
    const correction=latest(id),page=review.pages.find(page=>page.page===record.page)!;
    const historyMarkup=()=>`<summary>校正记录（${review.corrections.filter(c=>c.record_id===id).length}）</summary>${review.corrections.filter(c=>c.record_id===id).map(c=>`<p>v${c.revision} · ${esc(c.created_at)} · ${esc(c.corrected_text)}<br/>说明：${esc(c.reason)}</p>`).join('')}`;
    const detail=document.querySelector<HTMLElement>('#ocr-detail')!;
    detail.innerHTML=`<h2>第 ${record.page} 页原文片段</h2><p class="muted">${record.cell?`表格第 ${record.cell.row} 行、第 ${record.cell.column} 列，跨 ${record.cell.row_span} 行 / ${record.cell.column_span} 列（结构待确认）`:'文字段落'}</p><canvas id="ocr-crop" aria-label="原页识别位置片段" hidden></canvas><p id="ocr-image-status" role="status">正在读取原页…</p><button type="button" class="button secondary" id="ocr-image-retry" hidden>重新读取原页</button><a class="back-link" href="${esc(page.image_url)}" target="_blank" rel="noopener">查看完整原页</a>
      <p>原始识别：<strong>${esc(record.text||(record.numeric.kind==='blank'?'（空白）':'（未识别文字）'))}</strong></p><form id="ocr-correction"><label for="corrected-text">校正后文字或数值</label><textarea id="corrected-text" maxlength="4000">${esc(correction?.corrected_text??record.text)}</textarea>
      <div class="ocr-context-fields"><div><label for="ocr-period">所属期间</label><input id="ocr-period" maxlength="200" value="${esc(correction?.period)}" placeholder="如：2025 年末；未知可留空"/></div><div><label for="ocr-unit">单位</label><input id="ocr-unit" maxlength="200" value="${esc(correction?.unit)}" placeholder="如：万元；未知可留空"/></div></div>
      <label for="ocr-scope">主体与合并口径</label><input id="ocr-scope" maxlength="500" value="${esc(correction?.scope)}" placeholder="如：发行人合并报表；未知可留空"/>
      <label for="ocr-reason">校正依据 / 说明</label><textarea id="ocr-reason" required maxlength="2000">${esc(correction?.reason)}</textarea><p class="muted">留空不代表零值。缺少期间、单位或口径仍需补充；确认不会把资料标记为已审计。</p><p id="ocr-save-status" role="status"></p><button class="button primary" type="submit" disabled>保存用户校正</button></form>
      <section id="ocr-conflict" class="ocr-conflict" aria-label="校正版本冲突" hidden><p>本次输入仍在上方。请先读取并核对最新用户校正，再决定是否继续保存。</p><button type="button" class="button secondary" id="ocr-conflict-reload">读取最新校正</button><div id="ocr-conflict-latest" aria-live="polite"></div><button type="button" class="button secondary" id="ocr-conflict-acknowledge" hidden>已核对最新记录，继续使用本次输入</button></section>
      <details class="ocr-history">${historyMarkup()}</details>`;
    const retry=detail.querySelector<HTMLButtonElement>('#ocr-image-retry')!;
    const canvas=detail.querySelector<HTMLCanvasElement>('#ocr-crop')!;
    const imageStatus=detail.querySelector<HTMLElement>('#ocr-image-status')!;
    const saveButton=detail.querySelector<HTMLButtonElement>('#ocr-correction button')!;
    const currentSelection=()=>token===context.epoch()&&generation===selectedGeneration;
    let imageReady=false,conflicted=false;
    const syncSave=()=>{saveButton.disabled=!imageReady||conflicted||submitting;};
    const loadImage=()=>{
      clearImage();imageReady=false;syncSave();canvas.hidden=true;retry.hidden=true;imageStatus.textContent='正在读取原页…';
      const image=new Image();activeImage=image;
      const current=()=>currentSelection()&&image===activeImage;
      image.onload=()=>{if(!current())return;
        const [x,y,right,bottom]=record.bbox,margin=50,left=Math.max(0,x-margin),top=Math.max(0,y-margin),width=Math.min(page.width,right+margin)-left,height=Math.min(page.height,bottom+margin)-top;
        const scale=Math.min(1,1400/width);canvas.width=Math.ceil(width*scale);canvas.height=Math.ceil(height*scale);
        const ctx=canvas.getContext('2d')!;ctx.drawImage(image,left,top,width,height,0,0,canvas.width,canvas.height);ctx.strokeStyle='#b14a16';ctx.lineWidth=2;ctx.strokeRect((x-left)*scale,(y-top)*scale,(right-x)*scale,(bottom-y)*scale);
        canvas.hidden=false;imageStatus.textContent='框线标出本处识别范围。';imageReady=true;syncSave();};
      image.onerror=()=>{if(current()){imageStatus.textContent='原页暂时无法读取，请稍后重试。';retry.hidden=false;}};
      // Install handlers before src so a cached image follows the same readiness gate.
      image.src=page.image_url;
    };
    retry.addEventListener('click',loadImage);loadImage();
    const form=document.querySelector<HTMLFormElement>('#ocr-correction')!;
    form.addEventListener('input',()=>{dirty=true;});
    let pending:OcrCorrectionRequest|undefined;
    const status=form.querySelector<HTMLElement>('#ocr-save-status')!;
    const conflictPanel=detail.querySelector<HTMLElement>('#ocr-conflict')!;
    const reload=detail.querySelector<HTMLButtonElement>('#ocr-conflict-reload')!;
    const acknowledge=detail.querySelector<HTMLButtonElement>('#ocr-conflict-acknowledge')!;
    const latestPanel=detail.querySelector<HTMLElement>('#ocr-conflict-latest')!;
    let refreshed:OcrReview|undefined;
    reload.addEventListener('click',async()=>{
      if(reload.disabled||!conflicted)return;
      reload.disabled=true;acknowledge.hidden=true;refreshed=undefined;latestPanel.replaceChildren();
      status.textContent='正在读取最新校正，本次输入保留…';
      try {
        const updated=await context.api.request<OcrReview>('GET',path);
        if(!currentSelection())return;
        // Never attach an old draft to a replacement material or OCR snapshot, even if IDs repeat.
        if(updated.material_id!==review.material_id||updated.material_version!==review.material_version||
          updated.snapshot_id!==review.snapshot_id||updated.result_sha256!==review.result_sha256||
          !updated.records.some(item=>item.record_id===id)){
          status.textContent='识别原文已变化，不能将本次输入直接用于新结果。当前输入保留，请复制后重新打开核对页。';return;
        }
        const newest=updated.corrections.filter(item=>item.record_id===id).sort((a,b)=>b.revision-a.revision)[0];
        const display=(value:string|null)=>esc(value===null?'未提供':value===''?'（空白）':value);
        latestPanel.innerHTML=newest?`<h3>最新用户校正 v${newest.revision}</h3><p class="muted">${esc(newest.created_at)} · 用户校正不等于审计确认</p><dl>${[
          ['文字或数值',newest.corrected_text],['所属期间',newest.period],['单位',newest.unit],['主体与合并口径',newest.scope],['校正依据 / 说明',newest.reason]
        ].map(([label,value])=>`<dt>${label}</dt><dd>${display(value)}</dd>`).join('')}</dl>`:'<p>当前原文尚无已保存的用户校正。</p>';
        refreshed=updated;acknowledge.hidden=false;
        status.textContent='已读取最新记录。请与上方本次输入核对；尚未再次保存。';
      } catch(error){if(currentSelection())status.textContent=`${friendlyError(error,'read')} 当前输入保留。`;}
      finally{if(currentSelection())reload.disabled=false;}
    });
    acknowledge.addEventListener('click',()=>{
      if(!currentSelection()||!refreshed||reload.disabled)return;
      review=refreshed;refreshed=undefined;conflicted=false;pending=undefined;
      conflictPanel.hidden=true;detail.querySelector('.ocr-history')!.innerHTML=historyMarkup();drawList();syncSave();
      status.textContent='已保留本次输入。请点击“保存用户校正”提交；若版本再次变化，会重新提示核对。';
    });
    form.addEventListener('submit',async event=>{
      event.preventDefault();const button=form.querySelector<HTMLButtonElement>('button')!;if(button.disabled)return;
      const value=(selector:string)=>(form.querySelector<HTMLInputElement|HTMLTextAreaElement>(selector)!.value);
      const fields={snapshot_id:review.snapshot_id,record_id:id,result_sha256:review.result_sha256,expected_revision:latest(id)?.revision??0,corrected_text:value('#corrected-text'),reason:value('#ocr-reason'),period:value('#ocr-period')||null,scope:value('#ocr-scope')||null,unit:value('#ocr-unit')||null};
      if(!pending||JSON.stringify({...pending,request_id:undefined})!==JSON.stringify(fields))pending={...fields,request_id:crypto.randomUUID()};
      submitting=true;const controls=[...form.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('input,textarea')];controls.forEach(control=>control.disabled=true);
      button.disabled=true;status.textContent='正在保存…';
      try {await context.api.request('POST',`${path}/corrections`,pending);const updated=await context.api.request<OcrReview>('GET',path);
        if(token!==context.epoch())return;review=updated;dirty=false;submitting=false;await select(id);document.querySelector('#ocr-save-status')!.textContent='用户校正已保存，原始识别和历史记录已保留。';
      } catch(error){if(currentSelection()){
        if(error instanceof ApiError&&error.status===409){
          conflicted=true;refreshed=undefined;conflictPanel.hidden=false;acknowledge.hidden=true;latestPanel.replaceChildren();
          status.textContent='识别或校正版本已变化。当前输入保留，请读取最新校正并核对。';
        }else status.textContent=friendlyError(error,'save');
      }}
      finally{submitting=false;syncSave();controls.forEach(control=>control.disabled=false);}
    });
  };
  list.addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLElement>('[data-record]');if(button)void select(button.dataset.record!);});
  const resetList=()=>{offset=0;drawList();list.scrollTop=0;};
  textFilter.addEventListener('input',resetList);pageFilter.addEventListener('change',resetList);
  previous.addEventListener('click',()=>{offset=Math.max(0,offset-groupSize);drawList();list.scrollTop=0;});
  next.addEventListener('click',()=>{offset+=groupSize;drawList();list.scrollTop=0;});
  drawList();
}
