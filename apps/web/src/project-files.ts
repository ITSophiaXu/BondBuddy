import { ApiClient, ApiError, friendlyError } from './api';
import { ArtifactDownloads, artifactError } from './artifact-download';
import { esc, date } from './ui';
import { prototypeIcon as ico } from './prototype-design';
import { fileFolders, inFolder, type ProjectFile } from './project-collection-model';
import './project-browser.css';

export class ProjectFiles {
  private controller=new AbortController();private downloads=new ArtifactDownloads();private files:ProjectFile[]=[];private disposed=false;
  private dialog?:HTMLDialogElement;private q='';private folder='all';private name='';
  private timer?:ReturnType<typeof setTimeout>;private refreshing=false;
  private pendingDownloads=new Set<string>();
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private id:string){}
  private live(){return !this.disposed&&this.current();}
  dispose(){this.disposed=true;clearTimeout(this.timer);this.controller.abort();this.downloads.dispose();this.dialog?.remove();}
  async render(){
    const query=new URLSearchParams(location.hash.split('?')[1]);this.folder=query.get('folder')==='prospectus'||fileFolders.some(f=>f.id===query.get('folder'))?query.get('folder')!:'all';
    this.shell('<p role="status">正在读取项目文件…</p>','projects');
    try{
      const [project,result]=await Promise.all([this.api.project(this.id,this.controller.signal),this.api.projectFiles(this.id,this.controller.signal)]);
      if(!this.live())return;this.files=result.items;this.name=project.name;
      this.shell(`<a class="back-link" href="#tasks">← 返回全部项目</a><div class="page-head"><div><div class="eyebrow">PROJECT FILES</div><h1>项目文件</h1><p>${esc(project.name)} · ${esc(project.issuer_name??'发行人待填写')}</p></div><a class="btn secondary" href="#update?project=${encodeURIComponent(this.id)}&from=projects">上传 / 管理募集书版本</a></div>
        <p class="collection-file-note">已上传材料与成功生成的成果归档于此，历史版本保留。检查文件一致性暂未开放。</p>
        <div class="collection-file-workspace"><nav id="file-folders" class="collection-folders" aria-label="项目文件目录"></nav><section class="collection-panel collection-file-panel"><header class="collection-heading"><h2 id="folder-title"></h2><div><span id="folder-count"></span><button class="text-button" id="refresh-files">刷新文件</button></div></header>
        <div class="collection-search">${ico('search')}<input id="file-search" type="search" aria-label="搜索项目文件" placeholder="搜索文件名称"/></div><p id="file-action-status" role="status"></p><div id="file-list"></div></section></div>`,'projects');
      document.querySelector('#file-search')!.addEventListener('input',()=>{this.q=document.querySelector<HTMLInputElement>('#file-search')!.value;this.paintFiles();});
      document.querySelector('#refresh-files')!.addEventListener('click',()=>void this.refresh());this.paint();this.schedule();
    }catch(error){if(this.live()){this.shell(`<a class="back-link" href="#tasks">← 返回全部项目</a><div class="collection-empty"><h1>项目文件暂时无法打开</h1><p role="alert">${esc(friendlyError(error))}</p><button class="btn secondary" id="retry-files">重新读取</button></div>`,'projects');document.querySelector('#retry-files')!.addEventListener('click',()=>void this.render());}}
  }
  private schedule(){clearTimeout(this.timer);this.timer=setTimeout(()=>{if(this.live()&&document.visibilityState==='visible')void this.refresh();else if(this.live())this.schedule();},30000);}
  private async refresh(){
    if(!this.live()||this.refreshing)return;this.refreshing=true;
    const button=document.querySelector<HTMLButtonElement>('#refresh-files')!;button.disabled=true;
    try{const result=await this.api.projectFiles(this.id,this.controller.signal);if(this.live()){this.files=result.items;this.paint();document.querySelector('#file-action-status')!.textContent='';}}
    catch(error){if(this.live())document.querySelector('#file-action-status')!.textContent='刷新未成功，当前显示上次同步结果。'+friendlyError(error);}
    finally{this.refreshing=false;if(this.live()){button.disabled=false;this.schedule();}}
  }
  private paint(){
    const nav=document.querySelector('#file-folders')!;
    nav.innerHTML=fileFolders.filter(f=>!f.parent).map(f=>{
      const children=fileFolders.filter(c=>c.parent===f.id);
      const node=(id:string,name:string)=>`<button data-folder="${id}" ${id===this.folder?'aria-current="page"':''}>${ico('folder')}<span>${name}</span><small>${this.files.filter(x=>x.latest&&inFolder(x,id)).length}</small></button>`;
      return children.length?`<details open><summary>${f.name}</summary>${f.id==='2'?node('prospectus','募集说明书'):''}${children.map(c=>node(c.id,c.name)).join('')}</details>`:node(f.id,f.name);
    }).join('');
    nav.querySelectorAll<HTMLButtonElement>('[data-folder]').forEach(b=>b.addEventListener('click',()=>{this.folder=b.dataset.folder!;history.replaceState(null,'',location.pathname+location.search+'#/projects/'+encodeURIComponent(this.id)+'/files?folder='+this.folder);this.paint();}));
    this.paintFiles();
  }
  private paintFiles(){
    const visible=this.files.filter(f=>f.latest&&inFolder(f,this.folder)&&f.filename.toLocaleLowerCase().includes(this.q.trim().toLocaleLowerCase()));
    document.querySelector('#folder-title')!.textContent=this.folder==='prospectus'?'募集说明书':fileFolders.find(f=>f.id===this.folder)!.name;
    document.querySelector('#folder-count')!.textContent=visible.length+' 份已有文件';
    document.querySelector('#file-list')!.innerHTML=visible.length?visible.map(f=>`<article class="collection-file"><span class="collection-file-icon">${ico('file')}</span><div class="collection-file-info"><strong>${esc(f.filename)}</strong><small>${f.source==='material'?'原始文件':'生成成果'} · V${f.display_version} · ${esc(date(f.created_at))}${f.current?' · 当前募集书':''}</small></div><button class="text-button" data-file-history="${esc(f.file_key)}">版本记录 (${f.version_count})</button><button class="btn secondary small" data-file-download="${esc(f.file_id)}" data-version="${f.version}">${ico('download')}下载</button></article>`).join(''):'<div class="collection-empty"><h3>暂无文件</h3><p>此目录的已有文件会在上传或相关任务完成后显示。</p></div>';
    this.bindDownloads(document.querySelector('#file-list')!);
    document.querySelectorAll<HTMLButtonElement>('[data-file-history]').forEach(b=>b.addEventListener('click',()=>this.history(b.dataset.fileHistory!)));
  }
  private history(key:string){
    this.dialog?.remove();const rows=this.files.filter(f=>f.file_key===key);const dialog=document.createElement('dialog');this.dialog=dialog;dialog.className='collection-file-dialog';dialog.setAttribute('aria-label','文件版本记录');
    dialog.innerHTML=`<header><h2>版本记录</h2><button class="icon-btn" data-close aria-label="关闭版本记录">${ico('close')}</button></header><p>${esc(this.name)} · 旧版本保留</p>${rows.map(f=>`<article><div><strong>V${f.display_version} · ${esc(f.filename)}</strong><small>${esc(date(f.created_at))}${f.current?' · 当前募集书':''}${f.latest?' · 最新文件':''}</small></div><button class="btn secondary small" data-file-download="${esc(f.file_id)}" data-version="${f.version}">下载</button></article>`).join('')}<p id="file-dialog-status" role="status"></p>`;
    document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-close]')!.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>dialog.remove());this.bindDownloads(dialog);
  }
  private bindDownloads(host:Element){
    host.querySelectorAll<HTMLButtonElement>('[data-file-download]').forEach(b=>{b.disabled=this.pendingDownloads.has(b.dataset.fileDownload!+':'+b.dataset.version);b.addEventListener('click',()=>void this.download(b));});
  }
  private async download(button:HTMLButtonElement){
    const f=this.files.find(f=>f.file_id===button.dataset.fileDownload&&f.version===Number(button.dataset.version));if(!f)return;
    const key=f.file_id+':'+f.version;if(this.pendingDownloads.has(key))return;this.pendingDownloads.add(key);button.disabled=true;
    const status=this.dialog?.open?this.dialog.querySelector('#file-dialog-status'):document.querySelector('#file-action-status');
    if(status)status.textContent='正在读取并核验文件…';
    try{
      let bytes:Blob;
      if(f.source==='artifact'){
        const a=await this.api.artifact(f.file_id,this.controller.signal);
        if(a.version!==f.version||a.run_id!==f.run_id||a.sha256!==f.sha256)throw new ApiError(0,'DATA_UNAVAILABLE');
        const run=await this.api.run(a.run_id,this.controller.signal);
        if(run.project_id!==f.project_id||run.state!=='succeeded')throw new ApiError(0,'DATA_UNAVAILABLE');
        bytes=await this.api.artifactBytes(a,this.controller.signal);
      }
      else{const m=await this.api.material(f.project_id,f.file_id,this.controller.signal,f.version);if(m.material_version!==f.version||m.sha256!==f.sha256)throw new ApiError(409,'INPUT_REVISION_CONFLICT');bytes=await this.api.materialBytes(f.project_id,m,this.controller.signal);}
      if(!this.live())return;this.downloads.save(bytes,f.filename);if(status)status.textContent='文件已交给浏览器下载。';
    }catch(error){if(this.live()&&status)status.textContent=artifactError(error);}finally{this.pendingDownloads.delete(key);if(this.live())document.querySelectorAll<HTMLButtonElement>('[data-file-download]').forEach(b=>{b.disabled=this.pendingDownloads.has(b.dataset.fileDownload!+':'+b.dataset.version);});}
  }
}
