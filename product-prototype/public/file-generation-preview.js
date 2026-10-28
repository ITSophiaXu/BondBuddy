// Local design preview only. No API, persistence or generation request is sent.
const host = document.querySelector('#preview');
const message = text => { document.querySelector('#preview-message').textContent = text; };
let mode=new URLSearchParams(location.search).get('mode')==='workpapers'?'workpapers':'documents';
let previewFilename='募集说明书_V3.docx',previewSequence=3;
const next=()=>{if(mode==='workpapers')location.href='workpaper-batch.html';else show('documents');};
function show(scene) {
  const home=scene!=='documents';
  host.replaceChildren(document.querySelector('#'+(home?'choose':scene)).content.cloneNode(true));
  if(home){
    const source=document.querySelector('#'+(scene==='source-empty'?'source-empty':'source-current')).content.querySelector('.pf-source-workspace').cloneNode(true);
    source.classList.remove('pf-source-workspace');host.querySelector('.pf-home-source').append(source);
    const confirm=source.querySelector('#pf-source-next');confirm.id='pf-confirm-source';confirm.textContent='确认使用此募集说明书';
    source.querySelector('.pf-source-actions p').textContent='两种生成方式均使用这里确认的募集说明书。';
    const name=source.querySelector('.prospectus-file-info h3');if(name)name.textContent=previewFilename;
    const badge=source.querySelector('.prospectus-file-info .prospectus-current');if(badge)badge.textContent='当前版本 · V'+previewSequence;
  }
  const confirmSource=()=>{
    const confirm=host.querySelector('#pf-confirm-source');confirm.textContent='已确认使用此募集说明书';confirm.disabled=true;
    host.querySelector('#pf-home-hint').textContent='已确认募集说明书，选择一种生成方式继续。';
    host.querySelectorAll('[data-generation-mode]').forEach(button=>button.disabled=false);
  };
  if(matchMedia('(max-width:760px)').matches)host.querySelectorAll('.pf-optional').forEach(panel=>panel.open=false);
  message('');
  document.querySelectorAll('[data-scene]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.scene === scene)));
  host.querySelector('#pf-confirm-source')?.addEventListener('click',confirmSource);
  host.querySelectorAll('[data-generation-mode]').forEach(button=>button.addEventListener('click',()=>{mode=button.dataset.generationMode;next();}));
  const file=host.querySelector('#prospectus-version-file');
  const choose=host.querySelector('#choose-prospectus-version');
  choose?.addEventListener('click',()=>file.click());
  const previewFile=f=>{
    if(!f)return;
    if(!/\.(docx|pdf)$/i.test(f.name)||!f.size||f.size>100*1024*1024){message('请选择不超过 100 MB 的 DOCX 或 PDF 文件。');return;}
    host.querySelector('.pf-upload-ready')?.remove();
    const saved=document.createElement('aside');saved.className='pf-upload-ready';saved.setAttribute('aria-label','已上传的募集说明书');
    saved.innerHTML='<div><strong></strong><p>继续后将采用此版为项目当前稿，原版本保留。已提交任务保留原依据。</p></div><button class="btn primary">使用此版继续 →</button><button class="text-button">重新选择</button>';
    saved.querySelector('strong').textContent='已上传 · '+f.name;
    saved.querySelector('.btn').onclick=()=>{
      previewFilename=f.name;previewSequence++;
      let current=host.querySelector('.prospectus-current-file');
      if(!current){current=document.querySelector('#source-current').content.querySelector('.prospectus-current-file').cloneNode(true);choose.before(current);}
      current.querySelector('h3').textContent=previewFilename;current.querySelector('.prospectus-current').textContent='当前版本 · V'+previewSequence;
      choose.className='btn secondary';choose.textContent='上传新版本';choose.setAttribute('aria-label','上传新版本');choose.hidden=false;host.querySelector('.prospectus-panel-heading').append(choose);
      saved.remove();host.querySelector('.pf-source-actions').hidden=false;confirmSource();
    };saved.querySelector('.text-button').onclick=()=>file.click();
    host.querySelectorAll('[data-generation-mode]').forEach(button=>button.disabled=true);
    host.querySelector('#pf-home-hint').textContent='先在本页确认使用的募集说明书，再选择生成方式。';
    host.querySelector('.prospectus-upload-hint').after(saved);host.querySelector('.pf-source-actions').hidden=true;
    if(choose.classList.contains('pf-prospectus-dropzone'))choose.hidden=true;
    message('预览展示上传成功状态；实际文件未上传。');saved.querySelector('.btn').focus();
  };
  file?.addEventListener('change',()=>previewFile(file.files[0]));
  choose?.addEventListener('dragover',e=>e.preventDefault());
  choose?.addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer.files.length!==1){message('每次请选择一份募集说明书。');return;}previewFile(e.dataTransfer.files[0]);});
  host.querySelectorAll('a').forEach(link=>link.addEventListener('click',e=>{
    e.preventDefault();
    if(link.classList.contains('pf-back-link'))show('choose');
    else if(link.textContent.includes('管理募集说明书'))show('source-current');
    else message('这是界面预览。项目导航与生成记录将在实际工作区打开。');
  }));
  host.querySelectorAll('[data-download-version],[data-pf-template]').forEach(button=>button.addEventListener('click',()=>message(button.hasAttribute('data-pf-template')?'实际工作区将在此打开模板选择与上传窗口。':'示例文件不可下载；实际工作区可在此下载对应版本。')));
  host.querySelector('#pf-generate')?.addEventListener('click',()=>message('实际工作区将在此核对所选文件、募集书版本和费用，明确确认后开始生成。'));
  if(scene==='documents'){
    host.querySelector('#pf-source-summary strong').textContent=previewFilename;
    host.querySelector('#pf-source-summary small').textContent='项目当前稿 · V'+previewSequence+' · 合成关联文件项目';
    const supportInput=host.querySelector('#pf-support'),supportUpload=host.querySelector('#pf-support-upload');
    const previewSupport=files=>{if(!files.length||supportInput.disabled)return;const feedback=host.querySelector('#pf-support-feedback');feedback.classList.remove('is-error');if(files.some(f=>!f.size||f.size>100*1024*1024||! /\.(docx|pdf|xlsx)$/i.test(f.name))){feedback.classList.add('is-error');feedback.textContent='请上传不超过 100 MB 的 DOCX、PDF 或 XLSX 文件。';return;}feedback.textContent='预览已选择 '+files.length+' 份：'+files.map(f=>f.name).join('、')+'。仅展示文件，不上传或保存。';};
    supportUpload.addEventListener('click',()=>supportInput.click());
    supportInput.addEventListener('change',()=>{previewSupport([...supportInput.files]);supportInput.value='';});
    supportUpload.addEventListener('dragover',e=>{e.preventDefault();if(!supportInput.disabled)supportUpload.classList.add('is-dragging');});
    supportUpload.addEventListener('dragleave',e=>{if(!(e.relatedTarget instanceof Node)||!supportUpload.contains(e.relatedTarget))supportUpload.classList.remove('is-dragging');});
    supportUpload.addEventListener('drop',e=>{e.preventDefault();supportUpload.classList.remove('is-dragging');previewSupport([...e.dataTransfer.files]);});
    const catalog=[{"id":"init","name":"立项报告"},{"id":"underwriter","name":"主承销商核查意见"},{"id":"legal","name":"法律意见书"},{"id":"application","name":"挂牌 / 发行申请书"},{"id":"recommendation","name":"推荐函"},{"id":"private_summary","name":"募集说明书摘要"},{"id":"annual","name":"年度报告"},{"id":"semiannual","name":"半年度报告"},{"id":"issuer","name":"发行人基本情况说明"},{"id":"financial","name":"主要财务情况说明"},{"id":"credit","name":"授信情况说明"},{"id":"proceeds","name":"募集资金使用情况说明"}],rows=['init','underwriter'];let blank=false;
    const sync=()=>{
      const count=rows.length;
      host.querySelector('#pf-count').textContent=count+' 份';
      host.querySelector('#pf-price').textContent=count?count+' 份全部完成共 '+(count*4500).toLocaleString()+' 积分':'请选择需要生成的文件';
      host.querySelector('#pf-generate').disabled=!count;
      supportInput.disabled=supportUpload.disabled=!count;
      host.querySelector('#pf-support-upload-hint').textContent=count?'点击选择，或将文件拖到此处':'先在上方添加要生成的文件';
      host.querySelector('#pf-prepared').textContent=count+' / '+count+' 已准备';
      host.querySelector('#pf-package-readiness').textContent=count?'已复用 '+count+' 份模板，可以核对文件包。':'选择文件类型，开始准备本次清单。';
      host.querySelector('#pf-add-row').disabled=count===catalog.length;
      host.querySelector('#pf-template-list').innerHTML=[...rows,...(blank||!count?['']:[])].map((type,index)=>{
        const name=catalog.find(d=>d.id===type)?.name;
        return `<tr data-pf-row="${type}"><td class="pf-row-number">${String(index+1).padStart(2,'0')}</td><td class="pf-row-type"><select data-pf-document="${type}" aria-label="第 ${index+1} 行文件类型"><option value="" disabled ${type?'':'selected'}>选择要生成的文件</option>${catalog.map(d=>`<option value="${d.id}" ${d.id===type?'selected':rows.includes(d.id)?'disabled':''}>${d.name}${d.id!==type&&rows.includes(d.id)?'（已添加）':''}</option>`).join('')}</select></td><td class="pf-row-template">${name?`<div class="pf-row-template-name"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H5v20h14V7ZM14 2v5h5"/></svg><span>合成${name}模板 <small>V1</small></span></div><details class="pf-reused-inputs"><summary>已保存的要求与依据 · 0 份资料 · 有要求</summary><p>合成要求：保留待核实事项。</p><ul><li>直接使用募集书和模板，可按需补充依据。</li></ul></details>`:'<span class="pf-row-placeholder">选择文件类型后添加模板</span>'}</td><td class="pf-row-actions">${name?'<button class="btn secondary" data-template>更换模板</button>':''}<button class="text-button" data-remove="${index}" aria-label="移除第 ${index+1} 行" ${!type&&!count?'disabled':''}>移除</button></td></tr>`;
      }).join('');
      host.querySelectorAll('[data-pf-document]').forEach((el,index)=>el.onchange=()=>{if(index<rows.length)rows[index]=el.value;else{rows.push(el.value);blank=false;}sync();host.querySelectorAll('[data-pf-document]')[index]?.focus();});
      host.querySelectorAll('[data-remove]').forEach(el=>el.onclick=()=>{const i=Number(el.dataset.remove);if(i<rows.length)rows.splice(i,1);else blank=false;sync();host.querySelector('#pf-add-row').focus();});
      host.querySelectorAll('[data-template]').forEach(el=>el.onclick=()=>message('实际工作区将在此打开模板选择与上传窗口。'));
    };
    host.querySelector('#pf-add-row').onclick=()=>{blank=true;sync();host.querySelector('[data-pf-document=""]').focus();};sync();
  }
}
document.querySelectorAll('[data-scene]').forEach(button=>button.addEventListener('click',()=>show(button.dataset.scene)));
const scene=new URLSearchParams(location.search).get('scene');
show(['choose','source-empty','source-current','documents'].includes(scene)?scene:'choose');
