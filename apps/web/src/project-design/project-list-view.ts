import { esc, date } from '../ui';
import { prototypeIcon as ico } from '../prototype-design';
import { fileConsistencyState } from './consistency-model';
import { latestFiles, type Project, type DesignState } from './model';

export function projectRowsDesign(projects: Project[], state: DesignState) {
  if (!projects.length) return '<div class="pd-empty">没有找到匹配的项目。</div>';
  return `<div class="pd-table-wrap pd-project-list-wrap"><table class="pd-table pd-project-list-table"><thead><tr><th>项目名称</th><th>文件与一致性</th><th>最近更新</th><th>操作</th></tr></thead><tbody>${projects.map(p => {
    const files=latestFiles(p), statuses=files.map(f=>fileConsistencyState(state,p,f)).filter(Boolean);
    const count = (kind:string) => statuses.filter(s=>s?.kind===kind).length;
    const job=state.jobs.find(j=>j.projectId===p.id&&j.consistency),href=`#consistency?project=${p.id}&job=${job?.id}`;
    const health = count('checking') ? `<a class="pd-project-health" href="${href}">正在检查…</a>` : count('stale') ? `<span class="pd-project-health amber">版本有变化 · 待重查</span>` : count('conflict') ? `<a class="pd-project-health amber" href="${href}&filter=conflict">${ico('review')}${count('conflict')} 份文件不一致</a>` : count('manual') ? `<a class="pd-project-health" href="${href}&filter=manual">${count('manual')} 份需人工确认</a>` : job ? `<a class="pd-project-health" href="${href}">已完成一致性检查</a>` : '<span class="pd-project-health muted">尚未检查一致性</span>';
    return `<tr><td><a class="pd-project-title" href="#/projects/${p.id}/files">${esc(p.name)}</a><small>${esc(p.issuer)}</small><span class="pd-chip">${esc(p.market)}</span></td><td><span class="pd-project-file-count">${ico('folder')} ${files.filter(f=>f.folder!=='sources').length} 份项目文件</span>${health}</td><td><time>${esc(date(p.updatedAt))}</time></td><td><div class="pd-project-row-actions"><a class="btn primary" href="#/projects/${p.id}/files">项目文件</a><button class="btn secondary" data-consistency-start data-project="${p.id}">检查文件一致性</button><button class="btn secondary pd-start-trigger" data-action="project-menu" data-project="${p.id}" aria-haspopup="menu" aria-expanded="false">开始工作 ${ico('chevron')}</button></div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}
export function openProjectMenu(trigger: HTMLElement, p: Project) {
  document.querySelector('#pd-project-menu')?.remove();
  const menu = document.createElement('div');menu.id='pd-project-menu';menu.className='pd-project-menu';menu.setAttribute('popover','auto');menu.setAttribute('role','menu');menu.setAttribute('aria-label',p.name+' · 开始工作');
  const items = [ ['dashboard','overview','folder','项目工作台'], ['update','details','update','更新募集书'], ['review','materials','review','复核募集书'], ['generate','source','spark','文件生成'], ['integrity','subjects','shield','诚信核查'], ['qa','workspace','chat','项目问答'] ];
  menu.innerHTML=`<div class="pd-menu-context">在当前项目开始工作</div>${items.map(([route,step,icon,label])=>`<a role="menuitem" href="#${route}?project=${p.id}&step=${step}">${ico(icon)}<span>${label}</span>${ico('chevron')}</a>`).join('')}`;
  document.body.append(menu);menu.showPopover();trigger.setAttribute('aria-expanded','true');
  const rect=trigger.getBoundingClientRect();menu.style.left=Math.max(12,Math.min(rect.right-menu.offsetWidth,window.innerWidth-menu.offsetWidth-12))+'px';menu.style.top=Math.max(12,rect.bottom+menu.offsetHeight+8>window.innerHeight?rect.top-menu.offsetHeight-8:rect.bottom+8)+'px';
  const links=[...menu.querySelectorAll<HTMLAnchorElement>('a')];links[0].focus();
  menu.addEventListener('keydown', e => { const index=links.indexOf(document.activeElement as HTMLAnchorElement); if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();links[e.key==='Home'?0:e.key==='End'?links.length-1:(index+(e.key==='ArrowDown'?1:links.length-1))%links.length].focus();} if(e.key==='Escape')trigger.focus(); });
  menu.addEventListener('toggle', () => { if(!menu.matches(':popover-open')){trigger.setAttribute('aria-expanded','false');menu.remove();} });
  links.forEach(a=>a.addEventListener('click',()=>{menu.hidePopover();}));
}
