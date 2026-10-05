// Synthetic design fixture only. No API, model call, report download or project mutation.
const sections=[
  {
    "id": "section-1",
    "title": "复核结论",
    "items": 0,
    "html": "<section class=\"readable-section\"><header><p class=\"review-kicker\">复核报告 · 正文</p><h3>复核结论</h3></header><div class=\"readable-prose\"><p>发现两项需要处理的事项。<strong>财务差异需要优先核对。</strong></p></div></section>"
  },
  {
    "id": "section-2",
    "title": "复核范围与依据",
    "items": 0,
    "html": "<section class=\"readable-section\"><header><p class=\"review-kicker\">复核报告 · 正文</p><h3>复核范围与依据</h3></header><div class=\"readable-prose\"><p>已对照合成募集书与合成审计报告。</p></div></section>"
  },
  {
    "id": "section-3",
    "title": "复核发现",
    "items": 2,
    "html": "<section class=\"readable-section\"><header><p class=\"review-kicker\">复核报告 · 正文</p><h3>复核发现</h3><p class=\"readable-meta\">2 条编号事项 · 点击查看位置、依据及建议</p></header><div class=\"readable-prose\"></div><details class=\"readable-item\"><summary><span class=\"readable-item-icon\">＋</span><strong>1. 现金流金额与审计报告不一致</strong><span class=\"readable-item-hint\">查看详情</span></summary><div class=\"readable-prose\"><p><strong>原文位置：</strong> 第八章，经营现金流表。</p><p><strong>核对依据：</strong> 合成审计报告。</p><div class=\"readable-table\" tabindex=\"0\" role=\"region\" aria-label=\"报告表格，可横向滚动\"><table><thead><tr><th scope=\"col\">原文值</th><th scope=\"col\">对照值</th><th scope=\"col\">差异</th></tr></thead><tbody><tr><td data-label=\"原文值\">100</td><td data-label=\"对照值\">120</td><td data-label=\"差异\">20</td></tr></tbody></table></div><p><strong>修改建议：</strong> 确认口径后统一金额。</p></div></details><details class=\"readable-item\"><summary><span class=\"readable-item-icon\">＋</span><strong>2. 历史名称待补充证据</strong><span class=\"readable-item-hint\">查看详情</span></summary><div class=\"readable-prose\"><p><strong>待确认事项：</strong> 缺少名称变更日期依据。</p></div></details></section>"
  },
  {
    "id": "section-4",
    "title": "待补充与未覆盖事项",
    "items": 0,
    "html": "<section class=\"readable-section\"><header><p class=\"review-kicker\">复核报告 · 正文</p><h3>待补充与未覆盖事项</h3></header><div class=\"readable-prose\"><p>公开信息核验未执行，不能据此判断无风险。</p></div></section>"
  },
  {
    "id": "section-5",
    "title": "建议处理顺序",
    "items": 0,
    "html": "<section class=\"readable-section\"><header><p class=\"review-kicker\">复核报告 · 正文</p><h3>建议处理顺序</h3></header><div class=\"readable-prose\"><ol><li>核对财务口径</li><li>补充名称变更证据</li></ol></div></section>"
  }
];
export function mountReadablePreview(host){
 if(!host)return;
 host.innerHTML='<div class="readable-toolbar"><label>搜索报告<input type="search" placeholder="搜索问题、章节、金额或建议"></label><div><button class="text-btn" data-expand="all">展开全部事项</button><button class="text-btn" data-expand="none">收起事项</button></div></div><div class="readable-layout"><nav class="readable-nav" aria-label="报告目录"><p>报告目录</p>'+sections.map((s,i)=>'<button data-section="'+s.id+'"><span>'+String(i+1).padStart(2,'0')+'</span><strong>'+s.title+'</strong>'+(s.items?'<small>'+s.items+'</small>':'')+'</button>').join('')+'<button data-section="all"><span>↳</span><strong>阅读完整报告</strong></button></nav><div class="readable-body"></div></div>';
 const draw=id=>{host.querySelector('.readable-body').innerHTML=sections.filter(s=>id==='all'||s.id===id).map(s=>s.html).join('');host.querySelectorAll('[data-section]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.section===id)));};
 host.onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.section){host.querySelector('input').value='';draw(b.dataset.section);}if(b.dataset.expand)host.querySelectorAll('details').forEach(d=>d.open=b.dataset.expand==='all');};
 host.querySelector('input').oninput=e=>{const term=e.target.value.toLowerCase();host.querySelector('.readable-body').innerHTML=sections.filter(s=>s.html.toLowerCase().includes(term)).map(s=>s.html).join('')||'<div class="readable-notice">没有找到匹配内容，请尝试其他关键词。</div>';};
 draw(sections[0].id);
}
