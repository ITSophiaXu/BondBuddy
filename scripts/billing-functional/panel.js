const $=selector=>document.querySelector(selector),esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const points=value=>BigInt(value??'0').toLocaleString('zh-CN');
let busy=false,lastState;const messages=[];
function log(message){messages.unshift(new Date().toLocaleTimeString()+' '+message);$('#log').textContent=messages.slice(0,30).join('\n');}
const csrf=()=>document.cookie.split(';').map(part=>part.trim()).find(part=>part.startsWith('bb_csrf='))?.slice(8)??'';
async function send(path,body={}){
  const response=await fetch('/__billing-test/api/'+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-bb-csrf':csrf()},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok){const error=new Error(`${data.code??response.status}：${data.message??'请求失败'}`);error.status=response.status;throw error;}return data;
}
function draw(state){
  lastState=state;$('#identity').innerHTML=`<strong>当前登录：${esc(state.username)}</strong><p class="muted">真实产品会话；当前账号的测试数据与其他账号隔离。<a href="/#/account">管理账户与支付</a></p>`;
  const account=state.account;$('#balances').innerHTML=[['可用积分',account.available_points],['任务预留',account.task_held_points],['订阅额度',account.subscription_available_points],['充值额度',account.topup_available_points]].map(([label,value])=>`<div>${label}<strong>${points(value)}</strong></div>`).join('');
  $('#prepare').disabled=busy;
  $('#tasks').innerHTML=state.tasks.map(task=>{
    const active=task.run_id&&!['succeeded','failed','cancelled','rejected','test_completed'].includes(task.state),terminal=task.run_id&&!active;
    return `<article class="task"><h3>合成全面复核 · ${esc(task.state??'已报价，尚未开始')}</h3><dl><dt>锁定价格</dt><dd>${points(task.quote.points)} 积分</dd><dt>任务状态</dt><dd>${esc(task.state??'未受理')} / 账务 ${esc(task.charge_state??'无预留')}</dd><dt>本任务实扣</dt><dd>${points(task.charged_points)} 积分</dd><dt>执行键</dt><dd><code>${esc(task.request.execution_request_id)}</code></dd><dt>任务 ID</dt><dd><code>${esc(task.run_id??'尚未创建')}</code></dd></dl><div class="actions"><button class="primary" data-action="start" data-id="${esc(task.id)}" ${busy||task.run_id?'disabled':''}>开始任务（自动预留）</button><button data-action="succeeded" data-id="${esc(task.id)}" ${busy||!active?'disabled':''}>模拟成功交付并结算</button><button class="danger" data-action="failed" data-id="${esc(task.id)}" ${busy||!active?'disabled':''}>模拟失败并释放</button><button data-action="replay" data-id="${esc(task.id)}" ${busy||!task.run_id?'disabled':''}>重放同一执行键</button><a href="/#/projects/${encodeURIComponent(task.project_id)}">产品项目页</a></div>${terminal?'<p class="muted">重放沿用原请求与任务；若要测试新一次收费，请准备新任务。</p>':''}</article>`;
  }).join('')||'<p class="muted">还没有合成测试任务。</p>';
}
async function work(label,operation){
  if(busy)return;busy=true;$('#error').hidden=true;$('#prepare').disabled=true;if(lastState)draw(lastState);
  try{const state=await operation();draw(state);log(label+'完成。可用 '+points(state.account.available_points)+'，预留 '+points(state.account.task_held_points)+'。');}
  catch(error){$('#error').textContent=error.message;$('#error').hidden=false;log(label+'失败：'+error.message);
    if(error.status===401){lastState=undefined;$('#identity').innerHTML='<strong>请先登录真实产品账户</strong><p>测试账号 <code>billing_tester</code>，密码 <code>Local-Test-2026!</code>。初始 0 积分。</p><a class="link" href="/#/login">前往登录</a>';$('#tasks').innerHTML='';}
    else if(!lastState)$('#identity').textContent='暂无法读取测试账本，请查看错误后刷新。';
  }finally{busy=false;if(lastState)draw(lastState);$('#refresh').disabled=false;}
}
$('#refresh').addEventListener('click',()=>work('刷新',()=>send('state')));
$('#prepare').addEventListener('click',()=>work('准备合成任务',()=>send('review/prepare',{id:crypto.randomUUID()})));
$('#tasks').addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(!button||button.disabled)return;const {action,id}=button.dataset;
  if(action==='start'||action==='replay')void work(action==='replay'?'重放同一任务':'开始任务',()=>send('review/start',{id}));
  else void work(action==='succeeded'?'模拟成功结算':'模拟失败释放',()=>send('review/finish',{id,outcome:action}));
});
void work('读取真实会话',()=>send('state'));
