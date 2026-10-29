// Synthetic, local interaction prototype; no file is uploaded or interpreted here.
if(new URLSearchParams(location.search).get('upload')==='review'){
  const hidden=[...document.querySelectorAll('.wp-catalogue-selection,.wp-controls,.wp-table-wrap,.wp-requirements-block,#wp-confirm')];hidden.forEach(el=>el.hidden=true);
  const review=document.createElement('section');review.className='wp-import-review';review.id='wp-import-review';
  const labels=['A · 1 / 1-1 / 1-1-1','B · 合成核查 0 / 合成核查 1','C · 核查要求'];
  const options=(selected,optional=false)=>(optional?'<option value="">无</option>':'')+labels.map((label,i)=>`<option value="${i}" ${i===selected?'selected':''}>${label}</option>`).join('');
  review.innerHTML=`<h3>核对目录识别</h3><p><strong>合成无表头目录.xlsx</strong> 已保存。请核对名称、编号和条目范围；可以直接在这里调整。</p>
  <label class="wp-inline"><input type="checkbox">查看全部工作表（默认优先“1 尽职调查文件”）</label><details class="wp-review-sheet" open><summary>目录</summary><details><summary>原表样例（前 4 个非空行）</summary><div class="wp-table-wrap"><table class="wp-table"><tr><th>行</th><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td><td>合成公司目录</td><td></td><td></td></tr>${['1','1-1','1-1-1'].map((code,i)=>`<tr><td>${i+2}</td><td>${code}</td><td>合成核查 ${i}</td><td>核查要求</td></tr>`).join('')}</table></div></details>
  <fieldset><legend>目录区域 1</legend><div class="wp-mapping-fields"><label>名称所在列<select>${options(1)}</select></label><label>编号所在列<select>${options(0,true)}</select></label><label>从第几行开始<input type="number" value="2" min="1"></label><label>到第几行结束<input type="number" value="4" min="1"></label></div><details><summary>分类、编制要求与编号设置</summary><label class="wp-inline"><input type="checkbox">编号与名称合在一格时拆分</label><label>条目类型所在列<select>${options(-1,true)}</select></label><p class="muted">仅“类型”明确写为目录或文件夹时作为分组；其他有名称的行保留为文件。</p>${['分类列（按列顺序组成路径）','编制要求列（保留各列文字）'].map(title=>`<fieldset><legend>${title}</legend>${labels.map(label=>`<label class="wp-inline"><input type="checkbox">${label}</label>`).join('')}</fieldset>`).join('')}</details><button class="text-button" data-demo>不纳入这个区域</button></fieldset><button class="text-button" data-demo>添加这个工作表的目录区域</button></details>
  <p id="wp-review-dirty" role="status">已识别 3 份文件。</p><details open><summary>请核对（1）</summary><p>部分有内容的列尚未使用，请核对。</p></details><details><summary>查看识别结果（3 项）</summary><ul>${['1','1-1','1-1-1'].map((code,i)=>`<li>${code} 合成核查 ${i}<small>目录 · 第 ${i+2} 行</small></li>`).join('')}</ul></details><div class="wp-actions"><button class="btn secondary" id="wp-preview-again">更新识别预览</button><button class="btn primary" id="wp-accept-mapping">确认目录，选择生成文件</button></div><small>这里只保存目录；下一步确认生成时才会创建任务。</small>`;
  document.getElementById('wp-status').before(review);
  const accept=review.querySelector('#wp-accept-mapping'),feedback=review.querySelector('#wp-review-dirty');
  review.querySelectorAll('input,select').forEach(el=>el.onchange=()=>{accept.disabled=true;feedback.textContent='识别范围已调整，请先更新预览。';});
  review.querySelectorAll('[data-demo]').forEach(el=>el.onclick=()=>{feedback.textContent='原型仅演示当前合成区域；真实入口可添加或移除区域。';});
  review.querySelector('#wp-preview-again').onclick=()=>{accept.disabled=false;feedback.textContent='已识别 3 份文件。（合成预览）';};
  accept.onclick=()=>{review.remove();hidden.forEach(el=>el.hidden=false);document.getElementById('wp-status').textContent='目录已保存，请选择生成范围。（合成演示）';};
}
