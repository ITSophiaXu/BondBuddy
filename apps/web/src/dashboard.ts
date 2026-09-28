import { ApiClient, friendlyError, type Dto } from './api';
import { date, esc } from './ui';
import { prototypeIcon as icon } from './prototype-design';

type Project = Dto<'ProjectListResponse'>['items'][number];
const states: Record<string, string> = { draft:'待提供材料',preparing:'准备中',queued:'排队中',running:'正在更新',awaiting_input:'待补充材料',paused:'等待继续',validating:'检查成果',delivering:'生成文档',settlement_pending:'结算处理中',succeeded:'已完成',test_completed:'内部测试稿',failed:'处理失败',cancelled:'已停止',rejected:'未启动' };

/** Dashboard DOM and card copy migrated from product-prototype/public/app.js:dashboard. */
export class Dashboard {
  private controller = new AbortController();
  private filter = 'all';
  private items: Project[] = [];
  constructor(private api: ApiClient, private shell: (html: string, section: string) => void, private current: () => boolean) {}
  dispose() { this.controller.abort(); }
  async render() {
    this.shell(`<div class="page-head"><div><div class="eyebrow">INTELLIGENCE DASHBOARD</div><h1>工作台</h1><p>查看项目成果与处理进度，选择下一项任务。</p></div></div>
      <div class="stats">${[['update','募集书更新','查看更新项目','update'],['review','募集书复核','尚未开放','review'],['qa','项目问答','尚未开放','chat']].map(([kind,title,status,ico]) => `<a class="stat" href="${kind === 'update' ? '#tasks?kind=update' : `#${kind}`}"><div class="stat-icon">${icon(ico)}</div><div><div class="stat-label">${title}</div><div class="stat-number stat-availability">${kind === 'update' ? '成果与进度' : status}</div></div><span class="stat-tail">${kind === 'update' ? '查看成果 ↗' : '准备中'}</span></a>`).join('')}</div>
      <section><div class="section-head"><h2>今天，从哪一步开始？</h2><span class="muted">专为债券项目工作而设计</span></div><div class="workflow-cards">${[
        ['update','01','更新募集书','结合项目资料与发行安排，<br>完成整份募集书的更新。','材料评估 · Word 导出'],
        ['review','02','复核募集书','财务数据、合规与格式、<br>公开信息，三类依据交叉复核。','尚未开放'],
        ['generate','03','材料生成','关联募集书，按模板生成<br>立项报告、核查意见等材料。','尚未开放'],
        ['qa','04','项目问答','解读项目与财务材料，<br>查询工商、股权和债券信息。','尚未开放']
      ].map(([route,n,title,description,tail]) => `<a class="workflow-card" href="#${route}"><span class="card-number">${n} /</span><div class="feature-icon">${icon(route === 'generate' ? 'spark' : route === 'qa' ? 'chat' : route)}</div><h3>${title}</h3><p>${description}</p><div class="card-bottom"><span>${tail}</span>${icon('arrow')}</div></a>`).join('')}</div></section>
      <div class="dashboard-lower projects-only"><section class="panel"><div class="panel-head"><h2>最近项目</h2><a class="text-btn" href="#tasks">全部项目 ${icon('arrow')}</a></div><div class="tabs" role="tablist" aria-label="项目类别">${[['all','全部'],['update','募集书更新'],['review','募集书复核']].map(([value,label]) => `<button type="button" role="tab" aria-selected="${this.filter === value}" class="tab ${this.filter === value ? 'active' : ''}" data-dashboard-filter="${value}">${label}</button>`).join('')}</div><div id="dashboard-projects" aria-live="polite"></div></section></div>
      <div class="dashboard-foot">${icon('lock')} 材料按账号保存在平台工作空间 · <a href="#/data-policy">数据保存与删除说明</a></div>`, 'dashboard');
    document.querySelectorAll<HTMLButtonElement>('[data-dashboard-filter]').forEach(button => button.addEventListener('click', () => {
      this.filter = button.dataset.dashboardFilter!;
      document.querySelectorAll<HTMLButtonElement>('[data-dashboard-filter]').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); });
      void this.load();
    }));
    await this.load();
  }
  private async load() {
    this.controller.abort(); this.controller = new AbortController();
    const signal = this.controller.signal, host = document.querySelector<HTMLElement>('#dashboard-projects')!;
    host.innerHTML = '<p class="empty" role="status">正在同步最近项目…</p>';
    try {
      const result = await this.api.projects(undefined, { limit:'4', ...(this.filter === 'all' ? {} : { kind:this.filter as 'update' | 'review' }) }, signal);
      if (!this.current() || signal.aborted) return;
      this.items = result.items;
      host.innerHTML = this.items.length ? `<div class="table-wrap"><table><thead><tr><th>项目名称</th><th>状态</th><th>最近更新</th><th></th></tr></thead><tbody>${this.items.map(item => `<tr><td><a class="task-title" href="#/projects/${encodeURIComponent(item.project_id)}">${esc(item.name)}</a><span class="sub">${esc(item.issuer_name || '发行人待填写')}</span></td><td><span class="badge ${item.status === 'failed' ? 'error' : 'neutral'}">${esc(states[item.status ?? 'draft'] ?? '正在同步')}</span></td><td class="muted">${esc(date(item.updated_at))}</td><td><a href="#/projects/${encodeURIComponent(item.project_id)}" aria-label="继续${esc(item.name)}">${icon('chevron')}</a>${item.latest_artifact ? `<a class="text-btn" href="#/artifacts/${encodeURIComponent(item.latest_artifact.artifact_id)}">查看成果</a>` : ''}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty"><div class="empty-icon">${icon('folder')}</div><h3>你的下一份成果，从这里开始</h3><p>项目、材料和处理结果会汇集在这里。</p><a class="btn secondary small" href="#update">${icon('plus')}新建募集书项目</a></div>`;
    } catch (error) {
      if (!this.current() || signal.aborted) return;
      host.innerHTML = `<div class="empty"><p role="alert">${esc(friendlyError(error))}</p><button class="btn secondary" id="retry-dashboard">重新读取项目</button></div>`;
      host.querySelector('#retry-dashboard')!.addEventListener('click', () => { void this.load(); });
    }
  }
}
