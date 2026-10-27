// Local design preview only. No API, persistence or generation request is sent.
const host = document.querySelector('#preview');
const message = text => { document.querySelector('#preview-message').textContent = text; };
function show(scene) {
  host.replaceChildren(document.querySelector('#'+scene).content.cloneNode(true));
  if(matchMedia('(max-width:760px)').matches)host.querySelectorAll('.pf-optional').forEach(panel=>panel.open=false);
  message('');
  document.querySelectorAll('[data-scene]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.scene === scene)));
  host.querySelector('#pf-source-next')?.addEventListener('click',()=>show('documents'));
  const file=host.querySelector('#prospectus-version-file');
  const choose=host.querySelector('#choose-prospectus-version');
  choose?.addEventListener('click',()=>file.click());
  const previewFile=f=>{
    if(!f)return;
    if(!/\.(docx|pdf)$/i.test(f.name)||!f.size||f.size>100*1024*1024){message('请选择不超过 100 MB 的 DOCX 或 PDF 文件。');return;}
    const editor=host.querySelector('.prospectus-upload-editor');editor.hidden=false;
    const summary=document.createElement('p');summary.textContent='待保存：'+f.name;editor.prepend(summary);
    const save=host.querySelector('#save-prospectus-version');save.disabled=false;
    save.onclick=()=>{show('source-current');message('预览：文件已保存。实际使用时还需明确采用为项目当前稿。');};
    if(choose.classList.contains('pf-prospectus-dropzone'))choose.hidden=true;
  };
  file?.addEventListener('change',()=>previewFile(file.files[0]));
  choose?.addEventListener('dragover',e=>e.preventDefault());
  choose?.addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer.files.length!==1){message('每次请选择一份募集说明书。');return;}previewFile(e.dataTransfer.files[0]);});
  host.querySelectorAll('a').forEach(link=>link.addEventListener('click',e=>{e.preventDefault();if(link.textContent.includes('管理募集说明书'))show('source-current');else message('这是界面预览。项目导航与生成记录将在实际工作区打开。');}));
  host.querySelectorAll('[data-download-version],[data-pf-template]').forEach(button=>button.addEventListener('click',()=>message(button.hasAttribute('data-pf-template')?'实际工作区将在此打开模板选择与上传窗口。':'示例文件不可下载；实际工作区可在此下载对应版本。')));
  host.querySelector('#pf-generate')?.addEventListener('click',()=>message('实际工作区将在此核对所选文件、募集书版本和费用，明确确认后开始生成。'));
  host.querySelector('#pf-change-documents')?.addEventListener('click',()=>{const directory=host.querySelector('#pf-document-directory');directory.open=true;directory.scrollIntoView({block:'start'});});
  const checks=[...host.querySelectorAll('[data-pf-type]')];
  const sync=()=>{
    const selected=checks.filter(c=>c.checked),count=selected.length;
    host.querySelector('#pf-count').innerHTML=count+'<small> 份文件</small>';
    host.querySelector('#pf-directory-summary').textContent='已选 '+count+' / 12 类';
    host.querySelector('#pf-price').textContent=count?count+' 份全部完成共 '+(count*4500).toLocaleString()+' 积分':'请选择需要生成的文件';
    host.querySelector('#pf-generate').disabled=!count;
    host.querySelector('#pf-prepared').textContent=count+' / '+count+' 已准备';
    host.querySelector('#pf-package-readiness').textContent=count?'预览中所选文件均采用示例模板。':'从文件目录中勾选需要生成的文件。';
    host.querySelector('.pf-template-preparation').hidden=!count;
    host.querySelector('#pf-template-list').replaceChildren(...selected.map(c=>{
      const row=document.createElement('article');row.className='pf-prepared-file';
      const layout=document.createElement('div');layout.className='pf-template-row';
      const info=document.createElement('div');
      const title=document.createElement('strong');title.textContent=c.closest('label').querySelector('strong').textContent;
      const detail=document.createElement('small');detail.textContent='已复用示例模板 · V1';info.append(title,detail);
      const chip=document.createElement('span');chip.className='pf-chip';chip.textContent='可复用';
      const button=document.createElement('button');button.className='btn secondary';button.textContent='更换模板';button.onclick=()=>message('实际工作区将在此打开模板选择与上传窗口。');layout.append(info,chip,button);row.append(layout);return row;
    }));
  };
  checks.forEach(c=>c.addEventListener('change',sync));
  for(const [id,value] of [['pf-select-all',true],['pf-select-none',false]])host.querySelector('#'+id)?.addEventListener('click',()=>{checks.forEach(c=>c.checked=value);sync();});
}
document.querySelectorAll('[data-scene]').forEach(button=>button.addEventListener('click',()=>show(button.dataset.scene)));
const scene=new URLSearchParams(location.search).get('scene');
show(['source-empty','source-current','documents'].includes(scene)?scene:'source-empty');
