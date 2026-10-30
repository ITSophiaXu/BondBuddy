// Synthetic visual prototype. No API, task execution, downloads or billing.
const dialog=document.createElement('dialog');dialog.className='collection-file-dialog';
dialog.innerHTML='<h2>合成设计预览</h2><p>正式页面会打开所选任务对应的进度或结果。此预览不连接项目数据。</p><button class="btn primary">返回预览</button>';
document.body.append(dialog);dialog.querySelector('button').onclick=()=>dialog.close();
document.querySelectorAll('[data-tasks]').forEach(button=>button.onclick=()=>{
  const panel=document.getElementById(button.getAttribute('aria-controls'));panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));
});
document.querySelectorAll('[data-task-view]').forEach(button=>button.onclick=()=>{
  const panel=button.closest('[data-task-panel]');
  panel.querySelectorAll('[data-task-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
  panel.querySelectorAll('[data-run-id]').forEach(row=>row.style.display=button.dataset.taskView==='results'&&!row.querySelector('a.primary')?'none':'');
});
document.querySelectorAll('[data-work]').forEach(button=>button.onclick=()=>{
  document.querySelector('.collection-menu')?.remove();
  const menu=document.createElement('div');menu.className='collection-menu';menu.setAttribute('popover','auto');menu.setAttribute('role','menu');
  menu.innerHTML=['项目文件','检查文件一致性','更新募集书','复核募集书','文件生成','诚信核查','项目问答','归档项目'].map(label=>'<button role="menuitem">'+label+'</button>').join('');
  document.body.append(menu);menu.showPopover();const rect=button.getBoundingClientRect();
  menu.style.left=Math.max(12,Math.min(rect.right-menu.offsetWidth,innerWidth-menu.offsetWidth-12))+'px';
  menu.style.top=Math.max(12,Math.min(rect.bottom+8,innerHeight-menu.offsetHeight-12))+'px';
  menu.querySelectorAll('button').forEach(b=>b.onclick=()=>{menu.hidePopover();dialog.showModal();});
});
document.querySelector('#toggle-menu')?.addEventListener('click',()=>document.querySelector('#sidebar').classList.add('open'));
document.querySelector('#close-menu')?.addEventListener('click',()=>document.querySelector('#sidebar').classList.remove('open'));
document.querySelectorAll('a').forEach(a=>a.addEventListener('click',event=>{event.preventDefault();dialog.showModal();}));
