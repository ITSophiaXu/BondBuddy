const $=selector=>document.querySelector(selector),esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const points=value=>BigInt(value??'0').toLocaleString('zh-CN');
let busy=false,lastState;const messages=[];
function log(message){messages.unshift(new Date().toLocaleTimeString()+' '+message);$('#log').textContent=messages.slice(0,30).join('\n');}
const csrf=()=>document.cookie.split(';').map(part=>part.trim()).find(part=>part.startsWith('bb_csrf='))?.slice(8)??'';
let refreshingSession;
async function responseData(response){
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(`${data.code??response.status}：${data.message??'请求失败'}`);error.status=response.status;throw error;}
  return data;
}
async function refreshSession(){
  // Match the product ApiClient: only an explicit 401 may refresh an existing
  // session. A failed/unknown refresh never authorizes a business-request retry.
  if(!refreshingSession){
    const pending=fetch('/api/v1/auth/refresh',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'x-bb-csrf':csrf()}}).then(responseData);
    refreshingSession=pending;void pending.finally(()=>{if(refreshingSession===pending)refreshingSession=undefined;}).catch(()=>{});
  }
  await refreshingSession;
}
async function send(path,body={}){
  // Freeze the exact original task ID/body before any network request. Refresh
  // rotates CSRF cookies, so only that header is reread for the single retry.
  const serialized=JSON.stringify(body),request=()=>fetch('/__billing-test/api/'+path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json','x-bb-csrf':csrf()},body:serialized});
  let response=await request();
  if(response.status===401&&csrf()){await refreshSession();response=await request();}
  return responseData(response);
}
function draw(state){
  lastState=state;$('#identity').innerHTML=`<strong>当前登录：${esc(state.username)}</strong><p class="muted">真实产品会话；当前账号的测试数据与其他账号隔离。<a href="/#/account">管理账户与支付</a></p>`;
  const account=state.account;$('#balances').innerHTML=[['可用积分',account.available_points],['任务预留',account.task_held_points],['订阅额度',account.subscription_available_points],['充值额度',account.topup_available_points]].map(([label,value])=>`<div>${label}<strong>${points(value)}</strong></div>`).join('');
  $('#prepare').disabled=busy;
  const sub=state.subscription_test;
  if(sub){
    const next=sub.next_event;
    $('#subscription-test').innerHTML=`<p>模拟渠道已付 ${esc(sub.charges.paid_orders)} 笔，其中自动续扣 ${esc(sub.charges.recurring_paid_orders)} 笔；模拟实付 ¥${(Number(sub.charges.simulated_paid_fen)/100).toFixed(2)}。</p><p>${next?'下一事件：'+(next.event_kind==='release'?'已付合同月度发额':'合同到期续费检查')+' · '+esc(new Date(next.at).toLocaleString()):'当前没有待模拟的下期事件。'}</p>`;
    $('#advance-subscription').disabled=busy||!next;
  }
  $('#tasks').innerHTML=state.tasks.map(task=>{
    const active=task.run_id&&!['succeeded','failed','cancelled','rejected','test_completed'].includes(task.state),terminal=task.run_id&&!active;
    return `<article class="task"><h3>合成全面复核 · ${esc(task.state??'已报价，尚未开始')}</h3><dl><dt>锁定价格</dt><dd>${points(task.quote.points)} 积分</dd><dt>任务状态</dt><dd>${esc(task.state??'未受理')} / 账务 ${esc(task.charge_state??'无预留')}</dd><dt>本任务实扣</dt><dd>${points(task.charged_points)} 积分</dd><dt>执行键</dt><dd><code>${esc(task.request.execution_request_id)}</code></dd><dt>任务 ID</dt><dd><code>${esc(task.run_id??'尚未创建')}</code></dd></dl><div class="actions"><button class="primary" data-action="start" data-id="${esc(task.id)}" ${busy||task.run_id?'disabled':''}>开始任务（自动预留）</button><button data-action="succeeded" data-id="${esc(task.id)}" ${busy||!active?'disabled':''}>模拟成功交付并结算</button><button class="danger" data-action="failed" data-id="${esc(task.id)}" ${busy||!active?'disabled':''}>模拟失败并释放</button><button data-action="replay" data-id="${esc(task.id)}" ${busy||!task.run_id?'disabled':''}>重放同一执行键</button><a href="/#/projects/${encodeURIComponent(task.project_id)}">产品项目页</a></div>${terminal?'<p class="muted">重放沿用原请求与任务；若要测试新一次收费，请准备新任务。</p>':''}</article>`;
  }).join('')||'<p class="muted">还没有合成测试任务。</p>';
}
async function work(label,operation){
  if(busy)return;busy=true;$('#error').hidden=true;$('#prepare').disabled=true;if(lastState)draw(lastState);
  try{const state=await operation();draw(state);log(label+'完成。可用 '+points(state.account.available_points)+'，预留 '+points(state.account.task_held_points)+'。');}
  catch(error){$('#error').textContent=error.message;$('#error').hidden=false;log(label+'失败：'+error.message);
    if(error.status===401){lastState=undefined;$('#advance-subscription').disabled=true;$('#identity').innerHTML='<strong>请先登录真实产品账户</strong><p>测试账号 <code>billing_tester</code>，密码 <code>Local-Test-2026!</code>。初始 0 积分。</p><a class="link" href="/#/login">前往登录</a>';$('#tasks').innerHTML='';}
    else if(!lastState)$('#identity').textContent='暂无法读取测试账本，请查看错误后刷新。';
  }finally{busy=false;if(lastState)draw(lastState);$('#refresh').disabled=false;}
}
$('#refresh').addEventListener('click',()=>work('刷新',()=>send('state')));
$('#prepare').addEventListener('click',()=>work('准备合成任务',()=>send('review/prepare',{id:crypto.randomUUID()})));
$('#advance-subscription').addEventListener('click',()=>work('模拟下期续费/额度发放',()=>send('subscription/advance',{id:crypto.randomUUID()})));
$('#tasks').addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(!button||button.disabled)return;const {action,id}=button.dataset;
  if(action==='start'||action==='replay')void work(action==='replay'?'重放同一任务':'开始任务',()=>send('review/start',{id}));
  else void work(action==='succeeded'?'模拟成功结算':'模拟失败释放',()=>send('review/finish',{id,outcome:action}));
});
void work('读取真实会话',()=>send('state'));
