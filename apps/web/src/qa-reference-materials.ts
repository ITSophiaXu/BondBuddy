import type {ProjectFileAsset,QaWorkspace} from './billing-types.js';
import {qaAssetKey as key} from './qa-continuation';
import {esc} from './ui';
import './qa-reference-materials.css';

type Materials=QaWorkspace['materials'];
type View={search:string;open:Map<string,boolean>;scroll:number;selectedScroll:number;focus:string|null;selection:[number|null,number|null]|null};
export function qaReferenceInfo(asset:ProjectFileAsset,materials:Materials){
 const matches=materials.filter(m=>key(m.asset)===key(asset)),names=[...new Set(matches.map(m=>m.filename))];
 const filename=names.length===1&&names[0].trim()?names[0]:undefined;
 return {filename,name:filename??'材料名称暂不可核实',reason:!matches.length?'当前可用列表中暂未定位到此准确版本。':!filename?'同一准确引用的名称记录无法唯一核实。':'',
  kind:asset.kind==='material'?'项目材料':'生成成果',version:asset.kind==='material'?asset.pin.material_version:asset.pin.artifact_version,
  search:names.join(' ').toLocaleLowerCase()};
}
function reference(asset:ProjectFileAsset,materials:Materials,identity:string,open=false,review=false){
 const info=qaReferenceInfo(asset,materials),id=asset.kind==='material'?asset.pin.material_id:asset.pin.artifact_id;
 return '<details class="qa-reference-pin" data-qa-reference-detail="'+esc(identity)+'" data-material-key="'+esc(key(asset))+'" '+(review?'data-qa-reference-review-detail':'data-qa-reference-view-detail')+'="'+esc(identity)+'"'+(open?' open':'')+'><summary '+(review?'data-qa-reference-review-focus':'data-qa-reference-focus')+'="'+esc('detail:'+identity)+'">核对准确引用</summary><p>类别 '+info.kind+'<br>来源项目 '+esc(asset.pin.source_project_id)+'<br>'+(asset.kind==='material'?'材料':'成果')+' '+esc(id)+'<br>版本 V'+info.version+'<br>SHA-256 '+esc(asset.pin.sha256)+'</p></details>';
}
export function qaReferenceSummary(selected:ProjectFileAsset[],materials:Materials,scope:string){
 return '<div data-qa-reference-review="'+esc(scope)+'" tabindex="-1"><ol class="qa-reference-summary">'+selected.map(a=>{const info=qaReferenceInfo(a,materials);return '<li data-material-key="'+esc(key(a))+'"><strong>'+esc(info.name)+'</strong><span>'+info.kind+' · '+(a.kind==='material'?'材料':'成果')+'版本 V'+info.version+'</span>'+(info.reason?'<p class="muted">'+esc(info.reason)+' 原引用保留。</p>':'')+reference(a,materials,scope+':'+key(a),false,true)+'</li>';}).join('')+'</ol></div>';
}
/** Tab-local view state only. Business selection stays in the original complete QaDraft. */
export class QaReferenceMaterials {
 private views=new Map<string,View>();
 private reviewIdentities=new Map<string,string>();
 private reviewOpen=new Map<string,boolean>();
 private reviewFocus:{scope:string;token:string}|null=null;
 reviewScope(identity:unknown){const serialized=JSON.stringify(identity);let scope=this.reviewIdentities.get(serialized);if(!scope){scope='review-'+this.reviewIdentities.size;this.reviewIdentities.set(serialized,scope);}return scope;}
 reviewDetails(identity:unknown,title:string,content:string,initiallyOpen=false){const scope=this.reviewScope(identity);return '<details data-qa-reference-review="'+scope+'" data-qa-reference-review-detail="'+scope+'" tabindex="-1"'+(initiallyOpen?' open':'')+'><summary data-qa-reference-review-focus="'+scope+'">'+esc(title)+'</summary>'+content+'</details>';}
 composing=false;
 private view(scope:string){let value=this.views.get(scope);if(!value){value={search:'',open:new Map(),scroll:0,selectedScroll:0,focus:null,selection:null};this.views.set(scope,value);}return value;}
 capture(){
  document.querySelectorAll<HTMLDetailsElement>('[data-qa-reference-review-detail]').forEach(d=>this.reviewOpen.set(d.dataset.qaReferenceReviewDetail!,d.open));
  const activeReview=document.activeElement as HTMLElement|null,review=activeReview?.closest<HTMLElement>('[data-qa-reference-review]');
  this.reviewFocus=activeReview?.dataset.qaReferenceReviewFocus&&review?{scope:review.dataset.qaReferenceReview!,token:activeReview.dataset.qaReferenceReviewFocus}:null;
  const panel=document.querySelector<HTMLElement>('[data-qa-reference-panel]');if(!panel)return;
  const view=this.view(panel.dataset.qaReferenceScope!),search=panel.querySelector<HTMLInputElement>('#qa-reference-search');
  view.search=search?.value??view.search;
  panel.querySelectorAll<HTMLDetailsElement>('[data-qa-reference-view-detail]').forEach(d=>view.open.set(d.dataset.qaReferenceViewDetail!,d.open));
  view.open.set('panel',(panel as HTMLDetailsElement).open);
  view.scroll=panel.querySelector<HTMLElement>('[data-qa-reference-list]')?.scrollTop??0;
  view.selectedScroll=panel.querySelector<HTMLElement>('[data-qa-reference-selected]')?.scrollTop??0;
  const active=document.activeElement as HTMLElement|null;
  view.focus=active&&panel.contains(active)?active.dataset.qaReferenceFocus??null:null;
  view.selection=active===search&&search?[search.selectionStart,search.selectionEnd]:null;
 }
 render(scope:string,available:Materials,selected:ProjectFileAsset[],uploadHtml:string){
  const view=this.view(scope),unique=available.filter((m,i,all)=>all.findIndex(n=>key(n.asset)===key(m.asset))===i);
  const missing=selected.filter(a=>!unique.some(m=>key(m.asset)===key(a))),atLimit=selected.length>=50;
  const rows=[...unique.map(m=>({asset:m.asset,missing:false})),...missing.map(asset=>({asset,missing:true}))];
  const row=(asset:ProjectFileAsset,missing:boolean,index:number)=>{
   const info=qaReferenceInfo(asset,available),chosen=selected.some(a=>key(a)===key(asset)),identity='choice:'+key(asset);
   return '<article class="qa-reference-row'+(missing?' qa-reference-unavailable':'')+'" data-qa-reference-row data-qa-reference-key="'+esc(key(asset))+'" data-qa-reference-name="'+esc(info.search)+'" data-qa-reference-available="'+(!missing)+'"><label><input type="checkbox" data-qa-material="'+(missing?'missing':index)+'" data-material-key="'+esc(key(asset))+'" data-qa-reference-focus="'+esc('choice:'+key(asset))+'"'+(chosen?' checked':'')+(atLimit&&!chosen?' disabled aria-describedby="qa-reference-limit"':'')+'><span><strong>'+esc(info.name)+'</strong><small>'+info.kind+' · '+(asset.kind==='material'?'材料':'成果')+'版本 V'+info.version+'</small></span></label>'+(missing?'<p class="qa-warning">原材料版本暂不可用。原引用已保留，请恢复此版本或明确取消勾选；不会改用同名新版本。</p>':info.reason?'<p class="muted">'+esc(info.reason)+'</p>':'')+reference(asset,available,identity,view.open.get(identity))+'</article>';
  };
  const selectedRows=selected.map(a=>{const info=qaReferenceInfo(a,available),identity='selected:'+key(a);return '<li data-material-key="'+esc(key(a))+'"><strong>'+esc(info.name)+'</strong><span>'+info.kind+' · '+(a.kind==='material'?'材料':'成果')+'版本 V'+info.version+'</span>'+(info.reason?'<p class="muted">'+esc(info.reason)+' 原引用保留。</p>':'')+reference(a,available,identity,view.open.get(identity))+'</li>';}).join('');
  return '<details class="qa-materials qa-reference-panel" data-qa-reference-panel data-qa-reference-scope="'+esc(scope)+'" data-qa-reference-focus="panel" tabindex="-1"'+(view.open.get('panel')!==false?' open':'')+'><summary data-qa-reference-count data-qa-reference-focus="panel-summary">本轮参考材料 · '+selected.length+' 份已选</summary><p class="muted">按文件名查找，核对类别与版本后再勾选；查找不会改变已选材料。版本号不代表稿次或最新状态。</p><details class="qa-reference-selection" data-qa-reference-view-detail="selected"'+(view.open.get('selected')?' open':'')+'><summary data-qa-reference-focus="selected-summary">查看已选材料 · '+selected.length+' 份（保留本轮顺序）</summary>'+(selected.length?'<ol data-qa-reference-selected>'+selectedRows+'</ol>':'<p>本轮尚未选择参考材料。</p>')+'</details><label class="qa-reference-search">查找参考材料<input type="search" id="qa-reference-search" data-qa-reference-focus="search" placeholder="输入文件名" value="'+esc(view.search)+'"></label><p class="muted" data-qa-reference-matches role="status"></p><p id="qa-reference-limit" data-qa-reference-limit class="'+(atLimit?'qa-warning':'muted')+'">'+(atLimit?'已选满每轮 50 份。请先取消一份，再添加其他材料。':'每轮最多选择 50 份；取消只影响本轮，文件仍保留。')+'</p><div class="qa-reference-list" data-qa-reference-list role="region" aria-label="可核对的参考材料">'+rows.map((m,i)=>row(m.asset,m.missing,i)).join('')+'<p data-qa-reference-empty hidden>当前查找没有匹配的可用材料，已选引用仍保留。</p></div>'+uploadHtml+'</details>';
 }
 private filter(panel:HTMLElement,view:View){
  const q=view.search.trim().toLocaleLowerCase();let matches=0,total=0,missing=0;
  panel.querySelectorAll<HTMLElement>('[data-qa-reference-row]').forEach(row=>{
   if(row.dataset.qaReferenceAvailable==='false'){row.hidden=false;missing++;return;}
   total++;const match=!q||(row.dataset.qaReferenceName??'').includes(q);row.hidden=!match;if(match)matches++;
  });
  const count=panel.querySelector('[data-qa-reference-matches]');if(count)count.textContent='当前可用列表：'+matches+' / '+total+' 份'+(missing?'；另有 '+missing+' 份原引用待核对':'')+'。';
  const empty=panel.querySelector<HTMLElement>('[data-qa-reference-empty]');if(empty)empty.hidden=matches!==0;
 }
 bind(onCompositionEnd:()=>void){
  document.querySelectorAll<HTMLDetailsElement>('[data-qa-reference-review-detail]').forEach(d=>{const open=this.reviewOpen.get(d.dataset.qaReferenceReviewDetail!);if(open!==undefined)d.open=open;});
  if(this.reviewFocus){const saved=this.reviewFocus,target=[...document.querySelectorAll<HTMLElement>('[data-qa-reference-review-focus]')].find(n=>n.dataset.qaReferenceReviewFocus===saved.token&&n.closest<HTMLElement>('[data-qa-reference-review]')?.dataset.qaReferenceReview===saved.scope);
   const fallback=[...document.querySelectorAll<HTMLElement>('[data-qa-reference-review]')].find(n=>n.dataset.qaReferenceReview===saved.scope)??document.querySelector<HTMLElement>('.qa-recovery');
   if(target&&target.getClientRects().length)target.focus({preventScroll:true});else if(fallback){fallback.tabIndex=-1;fallback.focus({preventScroll:true});}
  }
  const panel=document.querySelector<HTMLElement>('[data-qa-reference-panel]');if(!panel){this.composing=false;return;}
  const view=this.view(panel.dataset.qaReferenceScope!),search=panel.querySelector<HTMLInputElement>('#qa-reference-search')!;
  search.addEventListener('input',()=>{view.search=search.value;this.filter(panel,view);});
  search.addEventListener('compositionstart',()=>{this.composing=true;});
  search.addEventListener('compositionend',()=>{this.composing=false;view.search=search.value;onCompositionEnd();});
  this.filter(panel,view);
  const list=panel.querySelector<HTMLElement>('[data-qa-reference-list]');if(list)list.scrollTop=view.scroll;
  const chosen=panel.querySelector<HTMLElement>('[data-qa-reference-selected]');if(chosen)chosen.scrollTop=view.selectedScroll;
  if(view.focus){const target=[...panel.querySelectorAll<HTMLElement>('[data-qa-reference-focus]')].find(n=>n.dataset.qaReferenceFocus===view.focus),fallback=panel;
   (target&&!target.matches(':disabled')&&!target.closest('[hidden]')&&target.getClientRects().length?target:fallback).focus({preventScroll:true});
   if(target===search&&view.selection)try{search.setSelectionRange(...view.selection);}catch{/* Read-only view focus remains usable. */}
  }
 }
}
