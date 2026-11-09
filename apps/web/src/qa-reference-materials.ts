import type {ProjectFileAsset,QaWorkspace} from './billing-types.js';
import {qaAssetKey as key} from './qa-continuation';
import {esc} from './ui';
import './qa-reference-materials.css';

type Materials=QaWorkspace['materials'];
type View={open:Map<string,boolean>;scroll:number;focus:string|null};
export function qaReferenceInfo(asset:ProjectFileAsset,materials:Materials){
 const matches=materials.filter(m=>key(m.asset)===key(asset)),names=[...new Set(matches.map(m=>m.filename))];
 const filename=names.length===1&&names[0].trim()?names[0]:undefined;
 return {filename,name:filename??'材料名称暂不可核实',reason:!matches.length?'当前可用列表中暂未定位到此准确版本。':!filename?'同一准确引用的名称记录无法唯一核实。':'',
  kind:asset.kind==='material'?'项目材料':'生成成果',version:asset.kind==='material'?asset.pin.material_version:asset.pin.artifact_version};
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
 private view(scope:string){let value=this.views.get(scope);if(!value){value={open:new Map(),scroll:0,focus:null};this.views.set(scope,value);}return value;}
 capture(){
  document.querySelectorAll<HTMLDetailsElement>('[data-qa-reference-review-detail]').forEach(d=>this.reviewOpen.set(d.dataset.qaReferenceReviewDetail!,d.open));
  const activeReview=document.activeElement as HTMLElement|null,review=activeReview?.closest<HTMLElement>('[data-qa-reference-review]');
  this.reviewFocus=activeReview?.dataset.qaReferenceReviewFocus&&review?{scope:review.dataset.qaReferenceReview!,token:activeReview.dataset.qaReferenceReviewFocus}:null;
  const panel=document.querySelector<HTMLElement>('[data-qa-reference-panel]');if(!panel)return;
  const view=this.view(panel.dataset.qaReferenceScope!);
  view.open.set('panel',(panel as HTMLDetailsElement).open);
  view.scroll=panel.querySelector<HTMLElement>('[data-qa-reference-list]')?.scrollTop??0;
  const active=document.activeElement as HTMLElement|null;
  view.focus=active&&panel.contains(active)?active.dataset.qaReferenceFocus??null:null;
 }
 render(scope:string,available:Materials,selected:ProjectFileAsset[],uploadHtml:string){
  const view=this.view(scope),unique=available.filter((m,i,all)=>all.findIndex(n=>key(n.asset)===key(m.asset))===i);
  const missing=selected.filter(a=>!unique.some(m=>key(m.asset)===key(a))),atLimit=selected.length>=50;
  const rows=[...unique.map(m=>({asset:m.asset,missing:false})),...missing.map(asset=>({asset,missing:true}))];
  const row=(asset:ProjectFileAsset,missing:boolean,index:number)=>{
   const info=qaReferenceInfo(asset,available),chosen=selected.some(a=>key(a)===key(asset));
   return '<article class="qa-reference-row'+(missing?' qa-reference-unavailable':'')+'" data-qa-reference-row data-qa-reference-key="'+esc(key(asset))+'" data-qa-reference-available="'+(!missing)+'"><label><input type="checkbox" data-qa-material="'+(missing?'missing':index)+'" data-material-key="'+esc(key(asset))+'" data-qa-reference-focus="'+esc('choice:'+key(asset))+'"'+(chosen?' checked':'')+(atLimit&&!chosen?' disabled aria-describedby="qa-reference-limit"':'')+'><span><strong>'+esc(info.name)+'</strong><small>'+info.kind+' · '+(asset.kind==='material'?'材料':'成果')+'版本 V'+info.version+'</small></span></label>'+(missing?'<p class="qa-warning">原材料版本暂不可用。原引用已保留，请恢复此版本或明确取消勾选；不会改用同名新版本。</p>':info.reason?'<p class="muted">'+esc(info.reason)+'</p>':'')+'</article>';
  };
  return '<section class="qa-materials"><details class="qa-reference-panel" data-qa-reference-panel data-qa-reference-scope="'+esc(scope)+'" data-qa-reference-focus="panel" tabindex="-1"'+(view.open.get('panel')||missing.length?' open':'')+'><summary data-qa-reference-count data-qa-reference-focus="panel-summary">参考材料 · '+selected.length+' 份</summary>'+(atLimit?'<p id="qa-reference-limit" data-qa-reference-limit class="qa-warning">已使用 50 份材料，添加前请先取消一份。</p>':'')+'<div class="qa-reference-list" data-qa-reference-list role="region" aria-label="参考材料">'+rows.map((m,i)=>row(m.asset,m.missing,i)).join('')+(rows.length?'':'<p>尚未添加参考材料。</p>')+'</div></details><div class="qa-material-upload">'+uploadHtml+'</div></section>';
 }
 bind(){
  document.querySelectorAll<HTMLDetailsElement>('[data-qa-reference-review-detail]').forEach(d=>{const open=this.reviewOpen.get(d.dataset.qaReferenceReviewDetail!);if(open!==undefined)d.open=open;});
  if(this.reviewFocus){const saved=this.reviewFocus,target=[...document.querySelectorAll<HTMLElement>('[data-qa-reference-review-focus]')].find(n=>n.dataset.qaReferenceReviewFocus===saved.token&&n.closest<HTMLElement>('[data-qa-reference-review]')?.dataset.qaReferenceReview===saved.scope);
   const fallback=[...document.querySelectorAll<HTMLElement>('[data-qa-reference-review]')].find(n=>n.dataset.qaReferenceReview===saved.scope)??document.querySelector<HTMLElement>('.qa-recovery');
   if(target&&target.getClientRects().length)target.focus({preventScroll:true});else if(fallback){fallback.tabIndex=-1;fallback.focus({preventScroll:true});}
  }
  const panel=document.querySelector<HTMLElement>('[data-qa-reference-panel]');if(!panel)return;
  const view=this.view(panel.dataset.qaReferenceScope!);
  const list=panel.querySelector<HTMLElement>('[data-qa-reference-list]');if(list)list.scrollTop=view.scroll;
  if(view.focus){const target=[...panel.querySelectorAll<HTMLElement>('[data-qa-reference-focus]')].find(n=>n.dataset.qaReferenceFocus===view.focus),fallback=panel;
   (target&&!target.matches(':disabled')&&!target.closest('[hidden]')&&target.getClientRects().length?target:fallback).focus({preventScroll:true});
  }
 }
}
