import {send,esc,points,money,yuanToFen,accountReturn} from './billing-client.js';

const $=selector=>document.querySelector(selector),query=new URLSearchParams(location.search),orderId=query.get('order')??'';
const returnTo=accountReturn(orderId,query.get('return_to'),location.origin);
$('#return-account').href=returnTo;
let busy=false,lastState,refundAmount='',delivery='query',refundIntent,storageBlocked=false;
const paymentLabels={pending:'等待模拟支付',paid:'积分已到账',failed:'支付未完成',expired:'订单已关闭或过期'};
const channelLabels={pending:'待支付',paid:'模拟渠道已支付',failed:'模拟渠道支付失败',closed:'模拟渠道已关闭',expired:'模拟渠道已过期'};
const refundLabels={requested:'退款申请已受理',processing:'退款处理中',succeeded:'模拟原路退款成功',failed:'模拟原路退款失败'};
const refundChannelLabels={pending:'等待模拟渠道结果',processing:'模拟渠道处理中',succeeded:'模拟渠道已退款',failed:'模拟渠道退款失败'};
const key=()=>lastState?'bb-local-cashier-refund-v1:'+JSON.stringify([lastState.username,orderId]):null;
const deliverySelect=()=>`<label>模拟结果确认方式<select id="delivery" ${busy?'disabled':''}><option value="query" ${delivery==='query'?'selected':''}>查单确认：先保存渠道结果，再刷新入账</option><option value="callback" ${delivery==='callback'?'selected':''}>认证回调：立即通知产品</option></select></label>`;
function restoreIntent(){
  try{
    const saved=JSON.parse(localStorage.getItem(key())??'null');
    if(saved&&(saved.id!==orderId||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(saved.request_id)||!/^\d+$/.test(saved.amount_fen)||BigInt(saved.amount_fen)<=0n))throw Error('原退款申请记录无效');
    refundIntent=saved;if(saved)refundAmount=(BigInt(saved.amount_fen)/100n)+'.'+String(BigInt(saved.amount_fen)%100n).padStart(2,'0');
  }catch{storageBlocked=true;}
}
function retainIntent(intent){const text=JSON.stringify(intent);localStorage.setItem(key(),text);if(localStorage.getItem(key())!==text)throw Error('未能可靠保存原退款申请');refundIntent=intent;}
function reconcileIntent(){
  if(!refundIntent)return;
  const accepted=lastState.refunds.find(refund=>refund.order_id===orderId&&refund.request_id===refundIntent.request_id&&String(refund.amount_fen)===refundIntent.amount_fen);
  if(!accepted)return;
  try{localStorage.removeItem(key());if(localStorage.getItem(key())!==null)throw Error();refundIntent=undefined;refundAmount='';}catch{storageBlocked=true;}
}
function accept(state){
  if(!state?.synthetic||!Array.isArray(state.payments)||!Array.isArray(state.refunds)||typeof state.username!=='string')throw Error('无法核实本地测试账本');
  const changed=lastState?.username!==state.username;lastState=state;
  if(changed){refundIntent=undefined;storageBlocked=false;restoreIntent();}
  reconcileIntent();draw();
}
function draw(){
  $('#reload-state').disabled=busy;
  if(!lastState)return;
  $('#identity').textContent='当前登录：'+lastState.username+' · 本地隔离测试账号';
  const payment=lastState.payments.find(row=>row.id===orderId);
  if(!payment){$('#checkout').innerHTML='<h2 id="checkout-title">订单不可用</h2><p>未找到本账号的原订单。请从产品账户或本人的测试订单重新进入。</p>';$('#refunds').hidden=true;return;}
  const pending=payment.state==='pending'&&payment.channel_state==='pending'&&!payment.automatic;
  const pendingTitle={paid:'渠道已支付，产品待核实入账',failed:'渠道支付失败，产品待核实',expired:'渠道已关闭，产品待核实'};
  const title=payment.state==='pending'?(pendingTitle[payment.channel_state]??paymentLabels.pending):(paymentLabels[payment.state]??'订单状态待核实');
  $('#checkout').innerHTML=`<h2 id="checkout-title">${esc(title)}</h2><p>原${payment.order_kind==='subscription'?'订阅':'充值'}订单 · 不创建第二笔付款</p><p class="amount">${money(payment.amount_fen)}</p><dl><dt>订单号</dt><dd>${esc(payment.id)}</dd><dt>产品订单状态</dt><dd>${esc(paymentLabels[payment.state]??payment.state)}</dd><dt>模拟渠道状态</dt><dd>${esc(channelLabels[payment.channel_state]??payment.channel_state??'未生成')}</dd><dt>订单积分</dt><dd>${points(payment.points)}${payment.order_kind==='subscription'?'（按订阅合同发放）':''}</dd><dt>账户可用积分</dt><dd>${points(lastState.account.available_points)}</dd></dl>${payment.automatic?'<p class="muted">此为已授权自动续费订单，请在测试台控制续费事件；本页不会再次发起扣款。</p>':''}${deliverySelect()}<div class="actions"><button type="button" class="primary" id="simulate-paid" ${busy||!pending?'disabled':''}>模拟支付成功</button><button type="button" class="danger" id="simulate-failed" ${busy||!pending?'disabled':''}>模拟支付失败</button><button type="button" id="close-payment" ${busy||!pending?'disabled':''}>关闭未支付订单</button><button type="button" id="refresh-payment" ${busy?'disabled':''}>查单并确认到账</button></div><p class="muted">保持待支付：无需操作，或刷新本订单核实；不会到账。选择查单确认后，需点击“查单并确认到账”；选择认证回调后，产品收到有效回执才入账。</p><div class="actions"><button type="button" class="primary" id="return-paid" ${busy||!(payment.state==='paid'||payment.channel_state==='paid')?'disabled':''}>确认到账并返回原付款</button></div><p class="muted">返回保留原付款及待执行任务信息。任务只有在产品确认到账后，才按原请求恢复。</p>`;
  drawRefunds(payment);
}
function drawRefunds(payment){
  const host=$('#refunds'),eligibility=payment.refundable,refunds=lastState.refunds.filter(row=>row.order_id===orderId);
  host.hidden=payment.state!=='paid'&&!refunds.length;if(host.hidden)return;
  const eligible=eligibility?.enabled&&eligibility.request_unit==='amount_fen'&&BigInt(eligibility.refundable_fen??'0')>0n;
  const subscription=payment.order_kind==='subscription';
  if(eligible&&subscription&&!refundIntent){const fen=BigInt(eligibility.refundable_fen);refundAmount=(fen/100n)+'.'+String(fen%100n).padStart(2,'0');}
  const details=eligibility?`<dl><dt>当前可退模拟金额</dt><dd>${money(eligibility.refundable_fen)}</dd><dt>退款冻结</dt><dd>${money(eligibility.held_refund_fen)}</dd><dt>已模拟退回</dt><dd>${money(eligibility.refunded_fen)}</dd></dl>${eligibility.reason?`<p class="muted">${esc(eligibility.reason)}</p>`:''}`:'<p>退款资格暂未核实，请刷新测试账本。</p>';
  let form='';
  if(storageBlocked)form='<p class="error" role="alert">无法可靠保存或核对本机原退款申请。请保留当前记录，恢复存储后刷新，暂不新建申请。</p>';
  else if(eligible||refundIntent){
    const readonly=busy||refundIntent||subscription;
    const original=refundIntent?`<p class="muted">沿用原申请 ${money(refundIntent.amount_fen)}，请求键 ${esc(refundIntent.request_id)}。结果未确认时不另建退款。</p>`:'';
    const subscriptionNote=subscription?'<p class="muted">本期订阅仅可按服务端核实金额整期申请；已消费或冻结等不符资格时不可退款。</p>':'';
    form=`<form id="refund-form" class="refund-form"><label>模拟退款金额（元）<input id="refund-amount" inputmode="decimal" autocomplete="off" value="${esc(refundAmount)}" placeholder="例如 1.00" ${readonly?'readonly':''} required></label>${original}${subscriptionNote}<button type="submit" ${busy?'disabled':''}>${refundIntent?'重试同一退款申请':'提交模拟原路退款申请'}</button></form>`;
  }else if(eligibility?.request_unit==='points')form='<p>此历史订单按原积分对价退款，请返回产品原付款页申请，沿用准确现金换算。</p>';
  const rows=refunds.map(refund=>{
    const canSet=!busy&&['requested','processing'].includes(refund.state)&&!['succeeded','failed'].includes(refund.channel_state);
    return `<article class="refund" data-refund="${esc(refund.id)}"><h3>${esc(refundLabels[refund.state]??refund.state)} · ${money(refund.amount_fen)}</h3><dl><dt>退款单号</dt><dd>${esc(refund.id)}</dd><dt>对应积分</dt><dd>${points(refund.credit_points)}</dd><dt>模拟渠道状态</dt><dd>${esc(refundChannelLabels[refund.channel_state]??refund.channel_state??'未确认')}</dd></dl><div class="actions"><button type="button" data-refund-action="succeeded" data-refund-id="${esc(refund.id)}" ${canSet?'':'disabled'}>模拟退款成功</button><button type="button" data-refund-action="failed" data-refund-id="${esc(refund.id)}" ${canSet?'':'disabled'}>模拟退款失败</button><button type="button" data-refund-action="refresh" data-refund-id="${esc(refund.id)}" ${busy?'disabled':''}>刷新并核实本退款</button></div><p class="muted">查单模式仅保存渠道结果，刷新后才处理产品退款；未确认成功前不显示已原路退款。</p></article>`;
  }).join('');
  host.innerHTML=`<h2 id="refund-title">模拟原路退款</h2><p>申请受理后冻结对应积分，渠道退款成功后才销账；失败会释放退款冻结。任务失败退回积分与原路退款分别记录。</p>${details}${form}${rows}`;
}
async function work(operation,message){
  if(busy)return;busy=true;$('#error').hidden=true;$('#message').hidden=true;draw();
  try{const state=await operation();accept(state);if(message){$('#message').textContent=message;$('#message').hidden=false;}return state;}
  catch(error){
    $('#error').textContent=error.message+(error.status===409&&error.code==='QUOTE_CHANGED'?' 本次退款未受理、未冻结。请刷新账本核对最新可退金额后重新申请。':' 原订单与原退款申请保留。未知结果请先刷新核对，勿另建付款。');$('#error').hidden=false;
    if(error.status===401){lastState=undefined;$('#identity').innerHTML='登录已过期，请<a href="/#/login">返回产品登录</a>后重新打开本单。';$('#checkout').innerHTML='<h2 id="checkout-title">请先登录</h2>';$('#refunds').hidden=true;}
  }finally{busy=false;draw();$('#reload-state').disabled=false;}
}
$('#checkout').addEventListener('change',event=>{if(event.target.id==='delivery')delivery=event.target.value;});
$('#checkout').addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||button.disabled||busy)return;
  if(button.id==='simulate-paid'||button.id==='simulate-failed')void work(()=>send('payment/outcome',{id:orderId,outcome:button.id==='simulate-paid'?'paid':'failed',delivery}),'已保存明确的模拟渠道结果，请核对产品订单状态。');
  else if(button.id==='close-payment')void work(()=>send('payment/close',{id:orderId}),'已核对原未支付订单关闭结果。');
  else if(button.id==='refresh-payment')void work(()=>send('payment/refresh',{id:orderId}),'已查询原订单；只有渠道确认支付成功才会入账。');
  else if(button.id==='return-paid')void work(async()=>{const state=await send('payment/refresh',{id:orderId});if(state.payments?.find(row=>row.id===orderId)?.state!=='paid')throw Error('原付款仍未确认到账，请保留本单继续核对');location.assign(returnTo);return state;});
});
$('#refunds').addEventListener('input',event=>{if(event.target.id==='refund-amount')refundAmount=event.target.value;});
$('#refunds').addEventListener('submit',event=>{
  if(event.target.id!=='refund-form')return;event.preventDefault();if(busy||storageBlocked)return;
  let intent=refundIntent;
  if(!intent){
    const amount=yuanToFen(refundAmount),payment=lastState.payments.find(row=>row.id===orderId);
    if(amount===null||!payment?.refundable?.enabled||BigInt(amount)>BigInt(payment.refundable.refundable_fen)){ $('#error').textContent='请输入不超过当前可退金额、最多两位小数的退款金额。';$('#error').hidden=false;return; }
    intent={id:orderId,amount_fen:amount,request_id:crypto.randomUUID()};
    try{retainIntent(intent);}catch{storageBlocked=true;$('#error').textContent='未能可靠保存原退款申请，未提交。请恢复本机存储后刷新。';$('#error').hidden=false;draw();return;}
  }
  void work(async()=>{
    try{return await send('refund/request',intent);}
    catch(error){
      // Product QUOTE_CHANGED is emitted only before admission/hold after its
      // transaction rolls back. Every uncertain error keeps the exact intent.
      if(error.status===409&&error.code==='QUOTE_CHANGED'){
        try{localStorage.removeItem(key());if(localStorage.getItem(key())!==null)throw Error();refundIntent=undefined;}
        catch{storageBlocked=true;}
      }
      throw error;
    }
  },'退款申请已提交，请核对本单状态；受理与冻结不表示已原路退回。');
});
$('#refunds').addEventListener('click',event=>{
  const button=event.target.closest('button[data-refund-action]');if(!button||button.disabled||busy)return;
  const id=button.dataset.refundId,action=button.dataset.refundAction;
  void work(()=>action==='refresh'?send('refund/refresh',{id}):send('refund/outcome',{id,outcome:action,delivery}),'已核对本退款的模拟渠道及产品状态。');
});
$('#reload-state').addEventListener('click',()=>void work(()=>send('state')));
if(!orderId){$('#checkout').innerHTML='<h2 id="checkout-title">缺少原订单</h2><p>请从产品付款页或计费测试台选择本人的订单。</p>';$('#reload-state').disabled=true;}
else void work(()=>send('state'));
