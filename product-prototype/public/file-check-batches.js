// Interaction reference on the existing consistency page. Synthetic only: no API or billing calls.
(()=>{
  const params=new URLSearchParams(location.search);
  if(params.get('purpose')!=='consistency'||!params.has('check-batches'))return;
  const host=document.querySelector('#consistency-preview');if(!host)return;
  let state=params.get('check-batches')==='partial'?'partial':'ready';
  function draw(){
    const partial=state==='partial',running=state==='running';
    host.innerHTML=`<a class="back-link" href="#">← 返回全部项目</a><div class="page-head"><div><div class="eyebrow">FILE CONSISTENCY</div><h1>文件一致性检查</h1><p>合成复核项目 · 核对关联文件与募集书，查看差异后选择是否生成修订版与清洁版。</p></div><a class="btn secondary" href="#">返回项目文件</a></div>
      <div class="pf-source-strip fc-original-source"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9M14 2v7h7"/></svg><div><strong>合成募集说明书.docx</strong><small>本项目正在使用 · V1 · 合成复核项目</small></div><span class="pf-chip">当前募集书</span></div><p id="fc-status" role="status"></p>
      ${state==='ready'?'':`<section class="panel file-check-batch"><header><h2>${partial?'本批部分文件已完成':'正在逐份检查'}</h2><button class="text-button" data-refresh>刷新本批状态</button></header><p>已完成 1 / 2 份 · 已扣 6,095 积分。每份独立交付与结算，失败文件不扣费。</p><ul><li><div><strong>合成发行人立项申请文件.docx</strong><span>已完成 · 已扣 6,095 积分</span></div><a class="text-button" href="#">查看本份检查与修订</a></li><li><div><strong>合成发行人发行申请文件.docx</strong><span>${running?'排队中':'处理失败'} · 已扣 0 积分</span></div><a class="text-button" href="#">查看本份任务</a></li></ul>${partial?'<button class="btn secondary" data-retry>仅重试失败或已取消文件</button><p class="muted">沿用原文件与原价格，已成功文件不会再次执行或扣费。</p>':''}</section>`}
      <section class="panel fc-empty"><h2>准备检查项目文件</h2><p>扫描项目每份关联文件的当前版本；历史版本保留。</p><p>本次范围：2 份文件</p><button class="btn primary" data-start>开始逐份检查</button></section>`;
    host.querySelector('[data-start]').onclick=()=>{state='partial';draw();};
    const retry=host.querySelector('[data-retry]');if(retry)retry.onclick=()=>{state='running';draw();};
    const refresh=host.querySelector('[data-refresh]');if(refresh)refresh.onclick=()=>draw();
  }
  draw();
})();
