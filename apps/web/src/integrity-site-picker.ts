import {INTEGRITY_SITES, integritySelectableSitesForSubjects, removeUnavailableIntegritySites, type IntegrityAvailabilitySubject, type IntegritySite} from '@bondbuddy/contracts';
import {esc} from './ui';

const external = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 2h5v5M7 9l7-7"/></svg>';

function groupMarkup(name: string, sites: IntegritySite[], selected: string[]) {
  if (!sites.length) return '';
  const key = sites[0].id;
  return `<div class="integrity-site-group" role="group" aria-labelledby="integrity-group-${esc(key)}">
    <label class="integrity-group-label"><input type="checkbox" data-site-group="${esc(name)}" aria-label="全选${esc(name)}"><span id="integrity-group-${esc(key)}">${esc(name)}</span></label>
    <div class="integrity-sites">${sites.map(s => `<div class="integrity-site">
      <label title="${esc(s.name+' · '+s.topic)}"><input type="checkbox" name="integrity-site" value="${esc(s.id)}" ${selected.includes(s.id)?'checked':''}><span>${esc(s.name)}</span></label>
      ${s.id.startsWith('local-')?'<span class="integrity-site-local" title="对应企业链接见下方注册地匹配">按注册地</span>':s.links.map(l=>`<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.name+' · '+l.label)}" aria-label="打开${esc(s.name)} · ${esc(l.label)}">${external}</a>`).join('')}
    </div>`).join('')}</div>
  </div>`;
}

export function integritySitePicker(selected: string[], subjects: readonly IntegrityAvailabilitySubject[] = [], preserveScope = false) {
  if (!preserveScope) selected = removeUnavailableIntegritySites(selected, subjects);
  const eligible = integritySelectableSitesForSubjects(subjects);
  const available = preserveScope ? INTEGRITY_SITES.filter(site => !site.legacy && (selected.includes(site.id) || eligible.some(item => item.id === site.id))) : eligible;
  const main = available.filter(s=>s.group!=='属地监管');
  const legacy = INTEGRITY_SITES.filter(s=>s.legacy&&selected.includes(s.id));
  return `<div class="integrity-site-picker">
    <header class="integrity-sites-header"><h2>核查网站 <small id="integrity-site-count" aria-live="polite">（已选 ${selected.length} 个）</small></h2><div><button class="text-button" id="integrity-all">全选</button><button class="text-button" id="integrity-none">清空</button></div></header>
    <div class="integrity-site-groups">${[...new Set(main.map(s=>s.group))].map(name=>groupMarkup(name,main.filter(s=>s.group===name),selected)).join('')}</div>
    <div class="integrity-regional-choice">${groupMarkup('属地监管',available.filter(s=>s.group==='属地监管'),selected)}</div>
    ${legacy.length?`<details class="integrity-legacy-sites"><summary>历史网站范围 · ${legacy.length} 项</summary><p>这些网站来自已保存的范围，可保留或取消；历史核查记录不受影响。</p>${groupMarkup('历史网站范围',legacy,selected)}</details>`:''}
    <details class="integrity-sites-help"><summary>核查范围说明</summary><p>仅列出已实测完成查询的网站；属地网站须匹配本轮所有企业的可用入口。勾选分类可选择该类全部网站；悬停名称可查看全称和核查事项，右侧图标打开网站。部分入口为主管机构门户，按对应事项查询。通过公开搜索获取线索，需登录或验证码的查询可补充证据。</p></details>
  </div>`;
}

export function syncIntegritySitePicker(selected: string[], root: ParentNode = document) {
  root.querySelectorAll<HTMLInputElement>('[name=integrity-site]').forEach(c=>c.checked=selected.includes(c.value));
  root.querySelectorAll<HTMLInputElement>('[data-site-group]').forEach(c=>{
    const items=[...c.closest('.integrity-site-group')!.querySelectorAll<HTMLInputElement>('[name=integrity-site]')];
    const count=items.filter(item=>item.checked).length;
    c.checked=count===items.length;
    c.indeterminate=count>0&&count<items.length;
  });
}

export function bindIntegritySitePicker(getSelected:()=>string[], onChange:(ids:string[])=>void, root:ParentNode=document, getSubjects:()=>readonly IntegrityAvailabilitySubject[]=()=>[]) {
  const update=(ids:string[])=>{ids=removeUnavailableIntegritySites(ids,getSubjects());onChange(ids);syncIntegritySitePicker(ids,root);};
  root.querySelectorAll<HTMLInputElement>('[name=integrity-site]').forEach(c=>c.addEventListener('change',()=>{
    update(c.checked?[...new Set([...getSelected(),c.value])]:getSelected().filter(id=>id!==c.value));
  }));
  root.querySelectorAll<HTMLInputElement>('[data-site-group]').forEach(c=>c.addEventListener('change',()=>{
    const ids=[...c.closest('.integrity-site-group')!.querySelectorAll<HTMLInputElement>('[name=integrity-site]')].map(item=>item.value);
    update(c.checked?[...new Set([...getSelected(),...ids])]:getSelected().filter(id=>!ids.includes(id)));
  }));
  root.querySelector('#integrity-all')!.addEventListener('click',()=>update([...new Set([...getSelected(),...integritySelectableSitesForSubjects(getSubjects()).map(s=>s.id)])]));
  root.querySelector('#integrity-none')!.addEventListener('click',()=>update([]));
  syncIntegritySitePicker(getSelected(),root);
}
