// Static synthetic design scenes. No API, model, upload or billing calls.
const scenes=await (await fetch('/workspace-ux-scenes.json')).json();
const app=document.querySelector('#app'),selector=document.querySelector('#design-scene');
function show(name){name=scenes[name]?name:'materials';app.innerHTML=scenes[name];selector.value=name;history.replaceState(null,'','?scene='+name);window.scrollTo(0,0);for(const field of app.querySelectorAll('textarea')){field.value=sessionStorage.getItem('workspace-demo:'+field.id)??field.value;}}
selector.addEventListener('change',()=>show(selector.value));
document.querySelector('#demo-complete').addEventListener('click',()=>show('results'));
app.addEventListener('submit',event=>{event.preventDefault();show('materials');});
app.addEventListener('input',event=>{if(event.target instanceof HTMLTextAreaElement)sessionStorage.setItem('workspace-demo:'+event.target.id,event.target.value);});
app.addEventListener('click',event=>{
 const target=event.target.closest('button,a');if(!target)return;
 if(target.id==='toggle-menu'){document.querySelector('#sidebar')?.classList.add('mobile-open');return;}
 if(target.id==='close-menu'){document.querySelector('#sidebar')?.classList.remove('mobile-open');return;}
 if(target.dataset.reviewTab){show(target.dataset.reviewTab);return;}
 if(target.dataset.reviewAction==='review'){show('progress');return;}
 if(target.dataset.reviewAction==='update-from-review'){show('updating');return;}
 if(target.dataset.reviewAction==='cancel'){show('materials');return;}
 if(target.id==='add-purpose'){const row=document.createElement('p');row.textContent='示例资金用途（选填）';document.querySelector('#funding-rows').append(row);return;}
 if(target.matches('a')){event.preventDefault();show(target.getAttribute('href').includes('details')||target.getAttribute('href')==='#review'?'create':'results');return;}
 if(target.dataset.readableSection){for(const b of app.querySelectorAll('[data-readable-section]'))b.setAttribute('aria-pressed',String(b===target));const body=app.querySelector('.readable-body');if(body){body.innerHTML='<h3>'+target.textContent.trim()+'</h3><p>合成示例：分别展示本维度的结论、原文位置、核对依据与修改建议；未执行的检查如实标明。</p>';}return;}
});
app.addEventListener('change',event=>{const input=event.target;if(input instanceof HTMLInputElement&&input.type==='file'){const list=input.closest('.material-role')?.querySelector('.material-file-list');for(const file of input.files??[]){const row=document.createElement('li');row.className='material-file-row';row.textContent=file.name+' · 原型演示，未上传';list?.append(row);}}});
show(new URLSearchParams(location.search).get('scene'));
