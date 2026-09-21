import { pointCapacity } from './usage-copy.js';
export function accountUI({state,esc,icon,link,head,api,post,toast,showModal,render,refreshJobs,document=globalThis.document,location=globalThis.location}) {
  const money=n=>'¥'+(n/100).toLocaleString('zh-CN',{maximumFractionDigits:2});
  const when=v=>v?new Date(v).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
  const orderNames={subscription:'月度套餐',upgrade:'升级专业版',addon:'点数加购'};
  const orderStatus={pending:'待支付',paid:'演示已支付',cancelled:'已取消',expired:'已过期'};
  const q=()=>state.billing?.seat.quota;
  const refresh=async()=>{const previous=q()?.plan;state.billing=await api('/api/billing');if(previous!==q()?.plan)state.connectors=(await api('/api/connectors')).connectors;};
  function meter(key,label,unit,description){const quota=q(),limit=quota.limit[key];return `<div class="quota-meter"><div><span>${label}</span><strong>${quota.available[key].toLocaleString()} <small>${unit}可用 / 共 ${limit.toLocaleString()} ${unit}</small></strong></div><progress max="${Math.max(1,limit)}" value="${quota.used[key]+quota.reserved[key]}" aria-label="${label}已使用"></progress><small>已使用 ${quota.used[key]}${quota.reserved[key]?` · 处理中 ${quota.reserved[key]}`:''}</small><p>${description}</p></div>`;}
  function usage(){const pro=q().plan==='professional';return `<section class="panel account-summary"><div class="section-head"><div><div class="eyebrow">MY PLAN</div><h2>${pro?'专业版':'个人版'} · 本期用量</h2><p>有效至 ${when(q().endsAt)} · 到期手动续费，不自动扣款</p></div><span class="badge neutral">${esc(state.user?.phoneMasked||'当前账号')}</span></div><div class="balance-capacity"><strong>剩余 ${q().available.points} 点</strong><span>${pointCapacity(q().available.points)}</span><small>更新每份 4 点 · 复核每份 1 点</small></div><div class="quota-grid">${meter('points','募集书任务额度','点','更新与复核共用这个余额。')}${meter('qa','对话问答','次','发送一条问题并完成回答，计 1 次。')}${meter('documents','在对话中上传文件','份','每次新上传 1 个文件，计 1 份。')}</div><div class="account-data-access">${icon(pro?'globe':'file')}<div><strong>${pro?'专业版 · 含外部数据查询':'个人版 · 项目材料处理'}</strong><p>${pro?'可通过企查查 / 工商、企业预警通、Wind 等查询工商、股权、风险及债券兑付记录。':'依据已有项目资料与上传文件开展工作；升级专业版可增加用量，并查询工商、股权与债券兑付记录。'}</p></div>${pro?'':'<button class="text-btn" type="button" data-action="choose-plan" data-value="professional">升级专业版 →</button>'}</div></section>`;}
  function topbarBilling(){
    const active=q()?.active;
    return `<div class="top-billing">
      ${active?`<div class="top-allowance" aria-label="剩余募集书额度"><span>剩余额度</span><strong>${q().available.points} <small>点</small></strong></div>`:'<div class="top-plan-prompt"><strong>尚未开通套餐</strong><small>¥499 / 月起</small></div>'}
      <a class="top-plan-link" href="#billing">套餐与用量 ${icon('arrow')}</a>
      ${active?`<button type="button" class="top-add-points" data-action="buy-addon">${icon('plus')}<span class="top-purchase-label">加购点数</span><small>¥299 / 4 点</small></button>`:'<a class="top-add-points" href="#billing">开通套餐</a>'}
    </div>`;
  }
  function plans(){return `<section id="plan-options" class="plan-options" tabindex="-1" aria-labelledby="plan-options-title">
    <div class="section-head plan-options-heading"><h2 id="plan-options-title">${q().active?'套餐对比':'选择适合你的套餐'}</h2><p>两档均支持募集书更新、复核、材料起草与分析。</p></div>
    <div class="plan-grid">${state.billing.plans.map(p=>{
      const pro=p.id==='professional';
      return `<section class="panel plan-card ${pro?'recommended':''}">
        <div class="plan-top"><span class="eyebrow">${pro?'PROFESSIONAL':'PERSONAL'}</span>${pro?'<span class="badge">更多用量 + 外部查询</span>':''}</div>
        <h2>${p.name}</h2>
        <p class="plan-audience">${pro?'更多用量，兼顾材料处理与外部信息核验':'依据已有材料，完成日常项目工作'}</p>
        <div class="plan-price">${money(p.price)}<small>/ 月</small></div>
        <div class="plan-data-benefit ${pro?'included':''}">
          <strong>${icon(pro?'globe':'file')}${pro?'专业版专享 · 外部数据查询':'项目材料分析'}</strong>
          ${pro?'<p>包含个人版全部能力，另可查询工商、股权、风险信息，以及公司发行过的全部公司债兑付与存续情况（含已到期和未到期）。</p><div class="data-provider-tags"><span>企查查 / 工商</span><span>企业预警通</span><span>Wind</span></div>':'<p>依据已有项目资料与上传文件，解读材料、分析财务、起草文档。</p><p class="plan-query-scope">不含工商、债券等外部数据库查询。</p>'}
        </div>
        <div class="plan-capacity"><strong>${p.points} 点募集书额度 / 月</strong><span>${pointCapacity(p.points)}</span><small>更新每份 4 点 · 复核每份 1 点，可组合使用</small></div>
        <ul class="plan-features"><li>${icon('chat')}<span>对话问答</span><b>${p.qa.toLocaleString()} 次 / 月</b></li><li>${icon('clip')}<span>在对话中上传文件</span><b>${p.documents} 份 / 月</b></li></ul>
        <p class="file-allowance-help">把文件发到对话中，用于阅读、分析或起草。更新、复核时上传的材料已包含在任务点数里。</p>
        <button class="btn primary" type="button" data-action="choose-plan" data-value="${p.id}" ${q().active&&(q().plan===p.id||q().plan==='professional')?'disabled':''}>${q().active?(q().plan===p.id?'当前套餐':pro?'升级专业版 · 按剩余天数补差价':'已包含此用量'):'开通'+p.name+' · '+money(p.price)+'/月'}</button>
      </section>`;
    }).join('')}</div>
  </section>`;}
  function addon(){return `<section class="addon-banner"><div><span class="eyebrow">EXTRA POINTS</span><h2>项目多了，再加购 4 点</h2><p>可以再更新 1 份募集书，或复核 4 份。</p><small class="addon-scope">加购只补充募集书任务额度；问答次数、对话上传文件份数保持不变。</small></div><div class="addon-purchase"><strong>¥299 <small>/ 4 点</small></strong>${q().active?`<button class="btn primary" type="button" data-action="buy-addon">${icon('plus')}加购 4 点</button><small>与本期套餐一起到期<br>${when(q().endsAt)}</small>`:'<button class="btn secondary" type="button" data-action="show-plans">先选择月度套餐</button><small>订阅后，可随时加购</small>'}</div></section>`;}
  function pointGuide(){return `<section class="task-pricing" aria-label="募集书任务计费"><div class="task-pricing-heading"><h2>募集书任务，按份扣点数</h2><p>点数是套餐里的任务额度。更新、复核共用这份额度，可以组合使用。</p></div><div class="task-price-grid"><div class="task-price-item"><span class="task-price-icon">${icon('update')}</span><div><h3>更新 1 份募集书</h3><p>获得修订版 Word 和更新说明</p></div><strong>4 <small>点</small></strong></div><div class="task-price-item"><span class="task-price-icon">${icon('review')}</span><div><h3>复核 1 份募集书</h3><p>获得问题报告和原文批注版</p></div><strong>1 <small>点</small></strong></div></div><div class="point-worked-example"><span>例如</span><p>更新 1 份，再复核这份募集书：<strong>4 + 1 = 5 点</strong></p></div><p class="task-price-note">对话问答和对话中上传的文件，有各自的每月份额，不扣这里的点数。任务未成功，点数会退回。</p></section>`;}
  function billingPage(){const b=state.billing;return head('套餐与用量','查看剩余额度，对比套餐，或按需加购点数。','SUBSCRIPTION')+`<div class="billing-demo">${icon('shield')}演示支付，不会收取费用</div>${q().active?usage():''}${plans()}${pointGuide()}${addon()}<p class="billing-fineprint">有效期一个月，不自动扣款。套餐与加购额度到期后清零。</p><section class="panel billing-faq"><h2>你可能还想了解</h2><details><summary>上传募集书、财务报表，还会额外扣文件份数吗？</summary><p>在「更新募集书」或「复核募集书」中上传的材料，已经包含在每份任务的 4 点或 1 点内。只有在对话中新增上传文件，才使用套餐里的文件上传额度；引用已有项目材料不重复扣份数。</p></details><details><summary>任务失败或停止，会扣点数吗？</summary><p>不会。处理中暂时锁定本次额度，成功后才正式扣除；失败、停止或服务暂不可用时，额度会退回。</p></details><details><summary>专业版能查询哪些外部信息？</summary><p>可通过企查查 / 工商、企业预警通、Wind 等，查询工商与股权、风险信息，以及公司发行过的全部公司债的兑付与存续情况，包括已到期和未到期债券。回答会注明数据来源与查询时间。</p></details><details><summary>加购和升级专业版，有什么区别？</summary><p>加购 ¥299 增加 4 点，只用于更多募集书任务，与当前套餐一起到期。升级专业版会提高本期问答、文件上传和点数总额度，并开通外部数据查询；已使用的额度保留，只支付剩余有效期的套餐差价。</p></details></section><details class="panel billing-details"><summary>订单记录 <small>${b.orders.length} 笔</small></summary>${b.orders.length?`<div class="table-wrap"><table><thead><tr><th>订单</th><th>时间</th><th>金额</th><th>状态</th><th></th></tr></thead><tbody>${b.orders.map(o=>`<tr><td>${orderNames[o.type]}</td><td>${when(o.createdAt)}</td><td>${money(o.amount)}</td><td><span class="badge ${o.status==='pending'?'warn':''}">${o.status==='pending'&&o.expiresAt<new Date().toISOString()?'已过期':orderStatus[o.status]}</span></td><td><a class="text-btn" href="#payment/${o.id}">${o.status==='pending'?'继续支付':'查看'}</a></td></tr>`).join('')}</tbody></table></div>`:'<p>还没有订单。</p>'}</details>`;}
  function checkoutPage(){return billingPage();}
  async function paymentPage(id){const {order:o}=await api('/api/billing/orders/'+id);state.order=o;const paid=o.status==='paid',line=o.lines[0],title=o.type==='addon'?`加购 ${line.points} 点`:line.plan==='professional'?'专业版月度套餐':'个人版月度套餐',pending=o.status==='pending',plan=state.billing.plans.find(p=>p.id===line.plan);return `<div class="simple-payment-wrap"><a class="text-btn" href="#billing">← 返回套餐与用量</a><section class="panel payment-card simple-payment"><div class="payment-symbol ${paid?'success':''}">${icon(paid?'check':o.type==='addon'?'plus':'shield')}</div><span class="eyebrow">${paid?'READY FOR YOUR NEXT PROJECT':'CONFIRM YOUR CHOICE'}</span><h1>${paid?'已生效，开始工作吧':pending?'确认支付':'订单已关闭'}</h1><p>${esc(state.user?.phoneMasked||'当前账号')} · ${title}</p><div class="payment-amount">${money(o.amount)}</div><div class="payment-benefit">${o.type==='addon'?`增加 ${line.points} 点：${pointCapacity(line.points)}。<br>有效至 ${when(line.endsAt)}，与本期套餐一起到期。<br>不增加问答、附件额度，不延长有效期。`:o.type==='upgrade'?`升级后本期总额度为 12 点、2,000 次问答和 80 份对话上传文件，扣除已使用部分。<br>同时开通企查查 / 工商、企业预警通、Wind 等外部数据查询。<br>原有加购点数保留，有效至 ${when(line.endsAt)}。`:`每月 ${plan.points} 点：${pointCapacity(plan.points)}<br>另含 ${plan.qa.toLocaleString()} 次问答、${plan.documents} 份对话上传文件。<br>${line.plan==='professional'?'含企查查 / 工商、企业预警通、Wind 等外部数据查询。':'基于项目与上传材料回答。'}<br>有效期一个月，到期手动续费，不自动扣款。`}</div>${pending?`<form id="payment-form"><button class="btn primary payment-confirm" type="submit">确认演示支付 · ${money(o.amount)} ${icon('arrow')}</button></form><button class="text-btn payment-cancel" type="button" data-action="cancel-order" data-value="${o.id}">取消订单</button>`:paid?`<div class="payment-success">${icon('check')}额度已到账，没有实际扣款</div><a class="btn primary payment-confirm" href="#dashboard">返回工作台 ${icon('arrow')}</a>`:`<p>未产生扣款，可重新选择套餐。</p><a class="btn primary payment-confirm" href="#billing">重新选择</a>`}<div class="payment-demo-note">${icon('lock')}仅演示流程，不会收取费用</div><details class="payment-order-meta"><summary>订单详情</summary><p>${esc(o.id)}</p><p>${when(o.createdAt)} · ${orderStatus[o.status]}</p></details></section></div>`;}
  async function click(action,value,el){
    if(action==='show-plans'){const plans=document.querySelector('#plan-options');plans?.scrollIntoView({behavior:'smooth',block:'start'});plans?.focus({preventScroll:true});return true;}
    if(action==='choose-plan'||action==='buy-addon'){
      if(state.orderCreating)return true;
      state.orderCreating=true;el.disabled=true;
      try{await refresh();if(action==='buy-addon'&&!q().active){location.hash='billing';toast('先选择个人版或专业版，即可使用套餐点数和加购。');return true;}
        const type=action==='buy-addon'?'addon':q().active&&q().plan==='personal'&&value==='professional'?'upgrade':'subscription';
        const request={type,plan:value,quantity:1,idempotencyKey:crypto.randomUUID()};
        const {order}=await post('/api/billing/orders',request);location.hash='payment/'+order.id;
      }finally{state.orderCreating=false;el.disabled=false;}
    }else if(action==='cancel-order'){el.disabled=true;await post('/api/billing/orders/'+value+'/cancel');await refresh();await render();}
    else return false;return true;
  }
  async function submit(form){
    if(form.id!=='payment-form')return false;
    const b=form.querySelector('button[type=submit]');b.disabled=true;
    try{
      if(form.id==='payment-form'){await post('/api/billing/orders/'+state.order.id+'/sandbox-pay');await refresh();await render();toast('额度已到账，没有实际扣款。');}
    }finally{b.disabled=false;}return true;
  }
  function change(){}
  return {topbarBilling,billingPage,checkoutPage,paymentPage,click,submit,change,refresh};
}
