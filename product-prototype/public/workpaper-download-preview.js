// Explicit synthetic scenes; production counts come from verified storage reads.
const downloadScene=new URLSearchParams(location.search).get('download');
if(downloadScene){
  document.querySelector('.wp-prepare').hidden=true;
  document.querySelector('.wp-workflow').hidden=true;
  document.querySelector('.prototype-note').textContent='2026-10-31 下载进度原型 · 合成示例，不连接存储、不生成文件。';
  document.getElementById('wp-batches').innerHTML=`<h2>底稿生成进度</h2><article class="panel wp-batch">
    <div class="wp-batch-heading"><h3>底稿文件包 <span class="wp-batch-state" data-state="complete">已完成</span></h3><span class="wp-batch-count"><strong>248</strong> / 248 份完成</span></div>
    <progress max="248" value="248" aria-label="底稿完成进度"></progress>
    <dl class="wp-batch-meta"><div><dt>生成依据</dt><dd>本批募集说明书.docx · V1</dd></div><div><dt>提交时间</dt><dd>原型示例</dd></div><div><dt>已扣积分</dt><dd>0 积分</dd></div></dl>
    <div class="wp-actions"><button class="btn primary" id="download-demo-button" disabled>正在准备下载…</button><div id="wp-download-feedback" style="flex-basis:100%;margin:4px 0;overflow-wrap:anywhere"></div></div>
    <details><summary>查看逐份状态与下载</summary><p>248 份合成底稿均已生成。</p></details></article>
    <p class="prototype-note">切换合成场景：<a href="?download=initial">开始等待</a> · <a href="?download=preparing">读取文件</a> · <a href="?download=packaging">整理文件包</a> · <a href="?download=transferring">文件传输</a> · <a href="?download=ready">下载完成</a></p>`;
  const packing=downloadScene==='packaging',transferring=downloadScene==='transferring',initial=downloadScene==='initial';
  const feedback=document.getElementById('wp-download-feedback');
  if(downloadScene==='ready'){
    feedback.setAttribute('role','status');feedback.innerHTML='文件已准备好。如未自动下载，请点击： <a href="#" onclick="return false">保存文件</a>';
    const button=document.getElementById('download-demo-button');button.disabled=false;button.textContent='下载已完成文件（ZIP）';
  }else{
    if(transferring)document.getElementById('download-demo-button').textContent='正在下载…';
    feedback.innerHTML=`<div class="wp-download-progress">
      <div role="status" aria-atomic="true"><strong>${initial?'正在准备下载':transferring?'正在下载文件包':packing?'正在准备下载 · 整理文件包':'正在准备下载 · 读取文件'}</strong><p>${initial?'正在读取已生成的文件并打包；文件较多时可能需要几分钟。':transferring?'正在下载… 50%（1.00 MB / 2.00 MB）':packing?'248 / 248 份文件已准备，正在完成打包…':'已准备 124 / 248 份文件，随后将打包下载。'}</p></div>
      <progress ${initial||packing?'':'max="248" value="124"'} aria-label="${transferring?'文件传输进度':packing?'正在整理文件包':'下载准备：已读取文件数'}"></progress>
      <span class="wp-download-elapsed" aria-live="off">已等待 ${initial?'0:00':'2:01'}</span>
      <p class="wp-download-slow" role="status" ${initial?'hidden':''}>等待时间较长，请继续等待，无需重复点击下载。</p>
      <small>请保持此页打开；切换页面会停止本次下载，已生成文件会保留。</small>
    </div>`;
  }
}
