import type {IntegrityRecord} from '@bondbuddy/contracts';
import type {ApiClient} from './api';
import {esc,date} from './ui';
export function mountIntegrityBrowserEvidence(dialog:HTMLDialogElement,record:IntegrityRecord|undefined,api:ApiClient,project:string,round:string,signal:AbortSignal){
 if(!record?.browser)return;
 const browser=record.browser,section=document.createElement('section');section.className='integrity-browser-evidence';
 section.innerHTML=`<h3>官网自动取证</h3><p>${esc(browser.scope)}</p><p class="muted">${esc(browser.limitation)}</p>${browser.captures.map((c,i)=>`<figure><figcaption>${c.kind==='blocker'?'访问或查询受限页面':c.kind==='detail'?'记录正文':'查询结果'} · ${esc(date(c.captured_at))}</figcaption><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title||'官网页面')} ↗</a><button class="text-button" type="button" data-auto-capture="${i}">查看官网截图</button><div data-auto-preview="${i}"></div></figure>`).join('')||'<p>本项未取得截图，请人工补证。</p>'}`;
 dialog.querySelector('h3')?.before(section);
 const urls:string[]=[];let closed=false;
 const cleanup=()=>{closed=true;urls.splice(0).forEach(u=>URL.revokeObjectURL(u));};
 dialog.addEventListener('close',cleanup,{once:true});signal.addEventListener('abort',cleanup,{once:true});
 section.querySelectorAll<HTMLButtonElement>('[data-auto-capture]').forEach(button=>button.addEventListener('click',async()=>{
  button.disabled=true;const index=Number(button.dataset.autoCapture),c=browser.captures[index],preview=section.querySelector<HTMLElement>(`[data-auto-preview="${index}"]`)!;preview.textContent='正在读取官网截图…';
  try{
   const bytes=await api.integrityCaptureBytes(project,round,c,signal);if(closed||!dialog.isConnected)return;
   const url=URL.createObjectURL(bytes);urls.push(url);const img=document.createElement('img');img.src=url;img.alt=`${record.site_name} ${record.query} ${date(c.captured_at)} 官网取证截图`;preview.replaceChildren(img);
   const download=document.createElement('a');download.href=url;download.download=`官网核查-${c.id}.png`;download.className='text-button';download.textContent='下载原始截图';preview.append(download);button.remove();
  }catch{if(!closed){preview.textContent='截图读取失败，请重试。';button.disabled=false;}}
 }));
}
