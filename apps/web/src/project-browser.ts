import { PROJECT_STATES, PROJECT_ARCHIVE_VIEWS, PROJECT_FIELD_LIMITS, TASK_KINDS } from '@bondbuddy/contracts';
import { ApiClient, friendlyError, type Dto } from './api';
import { date, esc, icon } from './ui';
import './project-browser.css';

type Item = Dto<'ProjectListResponse'>['items'][number];
type Filters = Dto<'ProjectListQuery'>;
const states: Record<typeof PROJECT_STATES[number], string> = {
  draft:'草稿',preparing:'准备中',rejected:'未启动',queued:'排队中',running:'处理中',awaiting_input:'待补材料',paused:'等待恢复',
  validating:'检查中',delivering:'交付中',settlement_pending:'结算处理中',succeeded:'已完成',failed:'失败',cancelled:'已取消'
};
const kinds: Record<typeof TASK_KINDS[number], string> = {update:'募集书更新',review:'募集书复核',generation:'材料生成',qa:'QA 问答'};
const folder = icon('M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z');
const options = (values: readonly string[], labels: Record<string,string>, selected?: string) => values.map(value => `<option value="${value}" ${value===selected?'selected':''}>${labels[value]}</option>`).join('');

export class ProjectBrowser {
  private items: Item[] = [];
  private cursor: string | null = null;
  private busy = false;
  private generation = 0;
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private filters: Filters = {};
  constructor(private api: ApiClient, private shell: (html: string, section: string) => void, private current: () => boolean) {}
  dispose() { this.generation++; this.controller.abort(); clearTimeout(this.timer); }

  async render() {
    const saved = new URLSearchParams(location.hash.split('?')[1]);
    this.filters = {q:(saved.get('q') ?? '').slice(0,PROJECT_FIELD_LIMITS.issuer)};
    for (const [key, values] of [['kind',TASK_KINDS],['status',PROJECT_STATES],['archive',PROJECT_ARCHIVE_VIEWS]] as const) {
      const value = saved.get(key);
      if (value && (values as readonly string[]).includes(value)) Object.assign(this.filters,{[key]:value});
    }
    this.shell(`<div class="page-heading"><div><p class="eyebrow">从上次停下的地方继续</p><h1>我的项目</h1><p class="muted">查找已保存的资料，继续准备下一次更新。</p></div><a class="button primary" href="#/new">新建更新项目</a></div>
      <section class="panel" aria-labelledby="projects-title"><div class="panel-heading"><h2 id="projects-title">项目列表</h2><button class="text-button" id="refresh-projects">刷新列表</button></div>
      <form id="project-filters" class="project-filters"><div class="search-field"><label for="project-search">搜索项目名称或发行人</label><input id="project-search" name="q" type="search" maxlength="${PROJECT_FIELD_LIMITS.issuer}" value="${esc(this.filters.q ?? '')}" placeholder="输入名称或发行人" autocomplete="off"/></div>
      <div><label for="project-kind">项目类型</label><select id="project-kind" name="kind"><option value="">全部类型</option>${options(TASK_KINDS,kinds,this.filters.kind)}</select></div>
      <div><label for="project-status">任务状态</label><select id="project-status" name="status"><option value="">全部状态</option>${options(PROJECT_STATES,states,this.filters.status)}</select></div>
      <div><label for="project-archive">项目范围</label><select id="project-archive" name="archive">${options(PROJECT_ARCHIVE_VIEWS,{active:'未归档',archived:'已归档',all:'全部项目'},this.filters.archive ?? 'active')}</select></div>
      <button type="submit" class="button secondary">搜索</button></form>
      <div class="project-list-meta"><p class="muted" id="list-count" role="status">正在加载…</p><span class="muted">按最近活动排序</span></div>
      <p id="page-error" class="form-message" role="alert" hidden></p><p id="project-action-status" class="project-action-status" role="status"></p>
      <div id="project-list" aria-live="polite" aria-busy="true"></div><div class="list-footer"><button class="button secondary" id="load-more" hidden>加载更多项目</button></div></section>
      <p class="page-footnote">可保存项目、上传材料并查看解析状态。全文更新将在完成验证后开放。</p>`, 'projects');
    const form = document.querySelector<HTMLFormElement>('#project-filters')!;
    const search = form.elements.namedItem('q') as HTMLInputElement;
    const change = () => {
      clearTimeout(this.timer);
      this.filters = Object.fromEntries([...new FormData(form)].filter(([,v]) => v !== '')) as Filters;
      const params = new URLSearchParams(this.filters);
      history.replaceState(null,'',`${location.pathname}${location.search}#/${params.size?`?${params}`:''}`);
      void this.load(true);
    };
    form.addEventListener('submit',event => {event.preventDefault();change();});
    form.querySelectorAll('select').forEach(select => select.addEventListener('change',change));
    let composing = false;
    search.addEventListener('compositionstart',() => {composing=true;clearTimeout(this.timer);});
    search.addEventListener('compositionend',() => {composing=false;change();});
    search.addEventListener('input',() => {if(!composing){clearTimeout(this.timer);this.timer=setTimeout(change,250);}});
    document.querySelector('#refresh-projects')!.addEventListener('click',() => {void this.load(true);});
    document.querySelector('#load-more')!.addEventListener('click',() => {void this.load(false);});
    await this.load(true);
  }

  private async load(reset: boolean) {
    if (!this.current() || (!reset && this.busy)) return;
    if (reset) {this.controller.abort();this.controller=new AbortController();this.generation++;this.items=[];this.cursor=null;}
    const generation=this.generation;
    this.busy=true;
    const button=document.querySelector<HTMLButtonElement>('#load-more')!;
    const list=document.querySelector<HTMLElement>('#project-list')!;
    const error=document.querySelector<HTMLElement>('#page-error')!;
    button.disabled=true;error.hidden=true;list.setAttribute('aria-busy','true');
    if(reset) list.innerHTML='<p class="project-list-loading" role="status">正在同步项目…</p>';
    document.querySelector('#list-count')!.textContent='正在同步…';
    try {
      const result=await this.api.projects(this.cursor ?? undefined,this.filters,this.controller.signal);
      if(!this.current() || generation!==this.generation)return;
      const seen=new Map(this.items.map(item=>[item.project_id,item]));
      result.items.forEach(item=>seen.set(item.project_id,item));this.items=[...seen.values()];
      this.cursor=result.page.has_more?result.page.next_cursor:null;
      this.renderItems();
    } catch(problem) {
      if(!this.current() || generation!==this.generation)return;
      error.textContent=friendlyError(problem);error.hidden=false;
      if(reset)list.innerHTML='';
      document.querySelector('#list-count')!.textContent='列表未能同步，请刷新重试。';
    } finally {
      if(this.current() && generation===this.generation){this.busy=false;button.disabled=false;button.hidden=!this.cursor;list.setAttribute('aria-busy','false');}
    }
  }

  private renderItems() {
    const filtered=!!(this.filters.q?.trim() || this.filters.kind || this.filters.status || this.filters.archive==='archived');
    document.querySelector('#list-count')!.textContent=`已加载 ${this.items.length} 个项目${this.cursor?'，可继续加载':''}`;
    const list=document.querySelector<HTMLElement>('#project-list')!;
    list.innerHTML=this.items.length?`<ul class="project-list">${this.items.map(item=>`<li class="managed-project" data-project-id="${esc(item.project_id)}">
      <a class="project-row" href="#/projects/${encodeURIComponent(item.project_id)}"><span class="project-icon">${folder}</span><div class="project-info"><h3>${esc(item.name)}</h3><p>${esc(item.issuer_name || '发行人待填写')} · ${item.kind?kinds[item.kind]:'项目资料已保存'}</p><span class="project-state">${item.status?states[item.status]:'已保存'}</span>${item.archived_at?'<span class="project-state">已归档</span>':''}</div><time datetime="${esc(item.updated_at)}">${esc(date(item.updated_at))}</time><span class="row-arrow" aria-hidden="true">↗</span></a>
      <div class="project-row-actions">${item.latest_artifact?`<span>最近成果 v${item.latest_artifact.version} · ${esc(date(item.latest_artifact.created_at))}</span><button class="text-button" data-download="${esc(item.project_id)}">下载最近成果</button>`:'<span>尚无成功成果</span>'}
      <button class="text-button" data-archive="${esc(item.project_id)}" aria-label="${item.archived_at?'恢复':'归档'} ${esc(item.name)}">${item.archived_at?'恢复项目':'归档'}</button></div></li>`).join('')}</ul>`:
      `<div class="empty-state"><div class="empty-icon">${folder}</div><h3>${filtered?'没有找到匹配的项目':'还没有项目'}</h3><p>${filtered?'试试其他名称或发行人，或调整筛选条件。':'创建第一个更新项目，先把基本资料保存下来。'}</p>${filtered?'<button class="button secondary" id="reset-project-filters">清除筛选</button>':'<a class="button secondary" href="#/new">新建更新项目</a>'}</div>`;
    list.querySelector('#reset-project-filters')?.addEventListener('click',()=>{
      const form=document.querySelector<HTMLFormElement>('#project-filters')!;
      for(const name of ['q','kind','status']) (form.elements.namedItem(name) as HTMLInputElement).value='';
      (form.elements.namedItem('archive') as HTMLSelectElement).value='active';form.requestSubmit();
    });
    list.querySelectorAll<HTMLButtonElement>('[data-archive]').forEach(button=>button.addEventListener('click',()=>{void this.archive(button);}));
    list.querySelectorAll<HTMLButtonElement>('[data-download]').forEach(button=>button.addEventListener('click',()=>{void this.download(button);}));
  }

  private async archive(button: HTMLButtonElement) {
    const item=this.items.find(item=>item.project_id===button.dataset.archive)!;
    button.disabled=true;
    const feedback=document.querySelector<HTMLElement>('#project-action-status')!;
    try {
      await this.api.archiveProject(item.project_id,!item.archived_at);
      if(!this.current())return;
      feedback.textContent=item.archived_at?'项目已恢复。': '项目已归档，可在“已归档”列表恢复；材料、任务和成果保留。';
      await this.load(true);
    } catch(error) {if(this.current())feedback.textContent=friendlyError(error);}
    finally {button.disabled=false;}
  }

  private async download(button: HTMLButtonElement) {
    const item=this.items.find(item=>item.project_id===button.dataset.download)!;
    button.disabled=true;
    try {
      const artifact=await this.api.artifact(item.latest_artifact!.artifact_id);
      if(!this.current())return;
      const url=new URL(artifact.download_url,location.origin);
      if(url.origin!==location.origin || !url.pathname.startsWith('/api/v1/artifacts/'))throw new Error('Invalid download URL');
      const link=document.createElement('a');link.href=url.href;link.download=`${item.name}.docx`;link.click();
    } catch(error) {if(this.current())document.querySelector('#project-action-status')!.textContent=friendlyError(error);}
    finally {button.disabled=false;}
  }
}
