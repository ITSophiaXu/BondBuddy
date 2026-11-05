import {send,storedAction,watchSessionChanges} from './billing-client.js';
const $=selector=>document.querySelector(selector),esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const points=value=>BigInt(value??'0').toLocaleString('zh-CN');
const money=value=>{const fen=BigInt(value??'0');return '¥'+(fen/100n).toLocaleString('zh-CN')+'.'+String(fen%100n).padStart(2,'0');};
let busy=false,lastState,sessionEpoch=0,recheckSession=false;const messages=[];
function log(message){messages.unshift(new Date().toLocaleTimeString()+' '+message);$('#log').textContent=messages.slice(0,30).join('\n');}
async function durableAction(action,path,mode){
  const username=lastState?.username;if(!username)throw Error('请先核实真实登录状态。');
  const advancing=path==='subscription/advance',next=lastState.subscription_test?.next_event;
  return storedAction({
    key:'bb-local-billing-action-v1:'+JSON.stringify([username,action]),
    create:()=>{if(advancing&&!next)throw Error('当前没有待模拟的下期事件，请刷新核实订阅状态。');return {id:crypto.randomUUID(),...(advancing?{expected_event:{at:next.at,event_kind:next.event_kind}}:mode?{mode}:{})};},
    // Pre-event-pin versions persisted only {id}. Recover that exact operation
    // without authorizing a new event under today's next-event snapshot.
    perform:intent=>send(path,advancing&&!intent.expected_event?{...intent,replay_only:true}:intent),
    validate:intent=>!!intent&&Object.keys(intent).every(name=>(advancing?['id','expected_event']:['id','mode']).includes(name))&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(intent.id)&&intent.mode===mode&&(!advancing||
      !Object.hasOwn(intent,'expected_event')||!!intent.expected_event&&Object.keys(intent.expected_event).length===2&&typeof intent.expected_event.at==='string'&&Number.isFinite(Date.parse(intent.expected_event.at))&&['release','renewal'].includes(intent.expected_event.event_kind)),
    accepted:(state,intent)=>state.synthetic===true&&state.username===username&&(path!=='review/prepare'||state.tasks?.some(task=>task.id===intent.id))&&(!advancing||
      state.subscription_action?.request_id===intent.id&&(state.subscription_action.advanced===true||state.subscription_action.replayed===true||state.subscription_action.event_changed===true)),
  });
}
function draw(state){
  if(state?.synthetic!==true||typeof state.owner_user_id!=='string')throw Error('无法核实本地测试账号。');
  lastState=state;$('#identity').innerHTML=`<strong>当前登录：${esc(state.username)}</strong><p class="muted">真实产品会话；当前账号的测试数据与其他账号隔离。<a href="/#/account">管理账户与支付</a></p>`;
  const account=state.account;$('#balances').innerHTML=[['可用积分',account.available_points],['任务预留',account.task_held_points],['退款冻结',account.refund_held_points],['订阅额度',account.subscription_available_points],['充值额度',account.topup_available_points]].map(([label,value])=>`<div>${label}<strong>${points(value)}</strong></div>`).join('');
  const paymentLabels={pending:'等待支付确认',paid:'已确认到账',failed:'支付未完成',expired:'订单已关闭或过期'},channelLabels={pending:'待支付',paid:'模拟已支付',failed:'模拟失败',expired:'模拟已关闭'};
  $('#payments').innerHTML=(state.payments??[]).map(payment=>`<article class="payment-order" data-payment="${esc(payment.id)}"><h3>${payment.order_kind==='subscription'?'订阅':'充值'} · ${money(payment.amount_fen)} · ${esc(paymentLabels[payment.state]??payment.state)}</h3><p>模拟渠道：${esc(channelLabels[payment.channel_state]??payment.channel_state??'待创建')} · 订单积分 ${points(payment.points)}</p><p class="muted">原订单 ${esc(payment.id)}</p><a class="link" href="/__billing-test/checkout?${esc(new URLSearchParams({order:payment.id}).toString())}">打开本单模拟收银台与退款</a></article>`).join('')||'<p class="muted">还没有支付订单。<a href="/#/account">到产品账户页充值或开通订阅</a>。</p>';
  $('#prepare').disabled=busy;$('#prepare-dynamic').disabled=busy;
  const sub=state.subscription_test;
  if(sub){
    const next=sub.next_event;
    $('#subscription-test').innerHTML=`<p>模拟渠道已付 ${esc(sub.charges.paid_orders)} 笔，其中自动续扣 ${esc(sub.charges.recurring_paid_orders)} 笔；模拟实付 ¥${(Number(sub.charges.simulated_paid_fen)/100).toFixed(2)}。</p><p>${next?'下一事件：'+(next.event_kind==='release'?'已付合同月度发额':'合同到期续费检查')+' · '+esc(new Date(next.at).toLocaleString()):'当前没有待模拟的下期事件。'}</p>${state.action_notice?`<p class="notice" role="status">${esc(state.action_notice)}</p>`:''}`;
    let pendingAdvance=false;try{pendingAdvance=!!localStorage.getItem('bb-local-billing-action-v1:'+JSON.stringify([state.username,'subscription-advance']));}catch{}
    $('#advance-subscription').disabled=busy||!next&&!pendingAdvance;
    $('#advance-subscription').textContent=!next&&pendingAdvance?'核对原续费/额度操作':'模拟下期续费/额度发放';
  }
  $('#tasks').innerHTML=state.tasks.map(task=>{
    const active=task.run_id&&!['succeeded','failed','cancelled','rejected','test_completed'].includes(task.state),terminal=task.run_id&&!active;
    const progressive=task.billing_policy==='authoring_balance_v2',dynamic=task.test_mode==='dynamic',paused=task.state==='paused',steps=task.checkpoint_stages??[],progressComplete=steps.includes('input_lock')&&steps.includes('model_generation');
    return `<article class="task" data-task="${esc(task.id)}"><h3>${dynamic?"按进度扣费测试":"合成全面复核"} · ${esc(task.state??'已报价，尚未开始')}</h3><dl><dt>锁定价格</dt><dd>${points(task.quote.points)} 积分</dd><dt>计费策略</dt><dd>${esc(task.billing_policy??'开始时由服务端锁定')} · ${progressive?'按实际进度扣费，不预留整价':'沿用原锁价及预留规则'}</dd><dt>任务状态</dt><dd>${esc(task.state??'未受理')} / 账务 ${esc(task.charge_state??'尚未开始')}</dd><dt>累计实际扣分</dt><dd>${points(task.gross_charged_points??task.charged_points)} 积分</dd><dt>退款后净扣分</dt><dd>${points(task.charged_points)} 积分</dd><dt>持久检查点</dt><dd>${esc(steps.join('、')||'尚未处理')}</dd><dt>执行键</dt><dd><code>${esc(task.request.execution_request_id)}</code></dd><dt>任务 ID</dt><dd><code>${esc(task.run_id??'尚未创建')}</code></dd></dl>${paused?`<p class="notice" role="status">${['insufficient_balance','credits_exhausted'].includes(task.pause_reason)?'积分已耗尽':'任务已暂停（'+esc(task.pause_reason??'请核对任务状态')+'）'}。<a href="/#/account">充值到账</a>后刷新测试账本，恢复同一任务与检查点。</p>`:''}<div class="actions"><button class="primary" data-action="start" data-id="${esc(task.id)}" ${busy||task.run_id?'disabled':''}>开始任务</button>${progressive&&dynamic?`<button data-action="progress" data-id="${esc(task.id)}" ${busy||!active||paused||progressComplete?'disabled':''}>模拟处理一步</button>`:''}<button data-action="succeeded" data-id="${esc(task.id)}" ${busy||!active||paused?'disabled':''}>模拟成功交付并结算</button><button class="danger" data-action="failed" data-id="${esc(task.id)}" ${busy||!active?'disabled':''}>${progressive?'模拟失败并退回已扣积分':'模拟失败并释放'}</button><button data-action="replay" data-id="${esc(task.id)}" ${busy||!task.run_id?'disabled':''}>重放同一执行键</button><a href="/#/projects/${encodeURIComponent(task.project_id)}">产品项目页</a></div>${terminal?'<p class="muted">重放沿用原请求与任务；若要测试新一次收费，请准备新任务。</p>':''}</article>`;
  }).join('')||'<p class="muted">还没有合成测试任务。</p>';
}
async function work(label,operation){
  if(busy)return;const epoch=sessionEpoch;busy=true;$('#error').hidden=true;$('#prepare').disabled=true;$('#prepare-dynamic').disabled=true;if(lastState)draw(lastState);
  try{const state=await operation();if(epoch!==sessionEpoch)return;draw(state);log(state.action_notice??label+'完成。可用 '+points(state.account.available_points)+'，预留 '+points(state.account.task_held_points)+'。');}
  catch(error){if(epoch!==sessionEpoch)return;$('#error').textContent=error.message;$('#error').hidden=false;log(label+'失败：'+error.message);
    if(error.status===401){
      lastState=undefined;$('#advance-subscription').disabled=true;
      $('#identity').innerHTML='<strong>请先登录真实产品账户</strong><p>测试账号 <code>billing_tester</code>，密码 <code>Local-Test-2026!</code>。初始 0 积分。</p><a class="link" href="/#/login">前往登录</a>';
      $('#tasks').innerHTML='';$('#payments').innerHTML='';$('#balances').innerHTML='';
      $('#subscription-test').textContent='登录已过期，请重新登录后读取本人的订阅。';
      messages.length=0;$('#log').textContent='登录已过期，已清除上一账号的页面记录。';
    }
    else if(!lastState)$('#identity').textContent='暂无法读取测试账本，请查看错误后刷新。';
  }finally{busy=false;if(lastState)draw(lastState);$('#refresh').disabled=false;if(recheckSession){recheckSession=false;void work('核实当前账号',()=>send('state'));}}
}
watchSessionChanges(()=>{
  sessionEpoch++;lastState=undefined;messages.length=0;recheckSession=true;
  $('#identity').textContent='账号会话已变化，正在重新核实…';
  for(const id of ['tasks','payments','balances','log'])$('#'+id).innerHTML='';
  $('#subscription-test').textContent='正在核实当前账号的订阅。';$('#error').hidden=true;
  for(const id of ['prepare','prepare-dynamic','advance-subscription'])$('#'+id).disabled=true;
  if(!busy){recheckSession=false;void work('核实当前账号',()=>send('state'));}
});
$('#refresh').addEventListener('click',()=>work('刷新',()=>send('state')));
$('#prepare').addEventListener('click',()=>work('准备合成任务',()=>durableAction('prepare-commercial','review/prepare')));
$('#prepare-dynamic').addEventListener('click',()=>work('准备按进度扣费测试',()=>durableAction('prepare-dynamic','review/prepare','dynamic')));
$('#advance-subscription').addEventListener('click',()=>work('模拟下期续费/额度发放',()=>durableAction('subscription-advance','subscription/advance')));
$('#tasks').addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(!button||button.disabled)return;const {action,id}=button.dataset;
  if(action==='start'||action==='replay')void work(action==='replay'?'重放同一任务':'开始任务',()=>send('review/start',{id}));
  else if(action==='progress'){
    const task=lastState?.tasks.find(row=>row.id===id);if(!task)return;
    const stage=task.checkpoint_stages?.includes('input_lock')?'model_generation':'input_lock';
    void work('模拟处理一步',()=>send('review/progress',{id,stage}));
  }
  else void work(action==='succeeded'?'核对交付与结算':'核对失败与退款',()=>send('review/finish',{id,outcome:action}));
});
void work('读取真实会话',()=>send('state'));
