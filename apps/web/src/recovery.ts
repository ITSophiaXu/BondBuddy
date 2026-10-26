import { RECOVERY_CHANNEL_KINDS, RECOVERY_POLICY } from '@bondbuddy/contracts';
import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import type { ErrorOperation } from './user-facing-error';
import { date, esc } from './ui';
import { PASSWORD_HELP, USERNAME_PATTERN } from './register';
const labels:Record<typeof RECOVERY_CHANNEL_KINDS[number],string>={email:'邮箱',support_chat:'原客服会话（如微信号）'};
const errorText=(error:unknown,operation:ErrorOperation)=>error instanceof ApiError && error.code==='CHALLENGE_INVALID'?'确认码或链接无效、已使用或已过期，请联系原客服重新核验。':error instanceof ApiError && error.status===404?'记录不可用，或当前账号没有处理权限。':friendlyError(error,operation);
const policy='只能通过事先绑定的联系方式核验账号归属。没有可靠旧记录时不能重置，原账号资料仍保留。';

export async function mountRecoveryAccount(api:ApiClient,live:()=>boolean) {
  const container=document.querySelector<HTMLElement>('#account-recovery')!;
  let state:Dto<'RecoveryAccountResponse'>;
  try {state=await api.recoveryAccount();}catch(error){if(live())container.innerHTML=`<h2>账号找回</h2><p class="muted">${esc(errorText(error,'read'))}</p>`;return;}
  if(!live())return;
  const paint=()=>{
    container.innerHTML=`<h2>账号找回</h2><p class="muted">${policy}</p><p>${state.current?`已绑定${labels[state.current.kind]}：${esc(state.current.contact_masked)}`:'尚未绑定恢复联系方式。'}</p>
      ${state.enabled?`<form id="recovery-bind-form"><label for="recovery-kind">恢复联系方式类型</label><select id="recovery-kind">${RECOVERY_CHANNEL_KINDS.map(kind=>`<option value="${kind}">${labels[kind]}</option>`).join('')}</select>
      <label for="recovery-contact">恢复联系方式</label><input id="recovery-contact" required minlength="3" maxlength="${RECOVERY_POLICY.contactMaxLength}" autocomplete="off"/>
      <label for="recovery-password">验证当前密码</label><input id="recovery-password" type="password" autocomplete="current-password" required maxlength="512"/>
      <p class="settings-note">客服会向此联系方式发送确认码；确认成功前，原绑定仍有效。</p><div class="form-actions"><button class="button secondary">申请绑定或更换</button></div></form>
      ${state.pending?`<div class="conflict-panel"><p>待确认：${esc(state.pending.contact_masked)}</p><p>请把绑定编号交给客服：<code>${esc(state.pending.binding_id)}</code></p><p>有效至 ${esc(date(state.pending.expires_at!))}。${state.pending.code_issued?'客服已生成确认码，请从该联系方式获取。':'等待客服发送确认码。'}</p><form id="recovery-confirm-form"><label for="recovery-code">客服发送的确认码</label><input id="recovery-code" required minlength="${RECOVERY_POLICY.codeLength}" maxlength="${RECOVERY_POLICY.codeLength}" autocomplete="one-time-code"/><button class="button secondary">确认绑定</button></form></div>`:''}`:'<p class="muted">人工找回尚未开放，请妥善保管密码。</p>'}
      <p id="recovery-account-message" class="form-message" role="status"></p>${state.support_operator?'<div class="context-divider"></div><div id="recovery-support"></div>':''}`;
    const message=container.querySelector<HTMLElement>('#recovery-account-message')!;
    container.querySelector<HTMLFormElement>('#recovery-bind-form')?.addEventListener('submit',async event=>{
      event.preventDefault();const form=event.currentTarget as HTMLFormElement,button=form.querySelector('button')!;button.disabled=true;
      const password=form.querySelector<HTMLInputElement>('#recovery-password')!;
      const input={kind:form.querySelector<HTMLSelectElement>('#recovery-kind')!.value as Dto<'RecoveryBindingRequest'>['kind'],contact:form.querySelector<HTMLInputElement>('#recovery-contact')!.value.trim(),current_password:password.value};
      password.value='';
      try{await api.recoveryBind(input);if(!live())return;state=await api.recoveryAccount();if(live())paint();}
      catch(error){if(live())message.textContent=errorText(error,'save');}finally{button.disabled=false;}
    });
    container.querySelector<HTMLFormElement>('#recovery-confirm-form')?.addEventListener('submit',async event=>{
      event.preventDefault();const form=event.currentTarget as HTMLFormElement,button=form.querySelector('button')!;button.disabled=true;
      const code=form.querySelector<HTMLInputElement>('#recovery-code')!;
      try{state=await api.recoveryConfirm(state.pending!.binding_id,code.value.trim());if(live()){paint();container.querySelector('#recovery-account-message')!.textContent='恢复联系方式已确认。';}}
      catch(error){if(live())message.textContent=errorText(error,'save');}finally{code.value='';button.disabled=false;}
    });
    if(state.support_operator)mountSupport(api,container.querySelector('#recovery-support')!,live);
  };paint();
}

function mountSupport(api:ApiClient,root:HTMLElement,live:()=>boolean) {
  root.innerHTML=`<h3>客服找回工具</h3><p class="settings-note">仅处理用户提供的编号。请在记录中的联系方式核验，不向申请人新提供的渠道发送。</p>
    <form id="support-lookup"><label for="support-record-kind">记录类型</label><select id="support-record-kind"><option value="binding">绑定申请</option><option value="ticket">找回工单</option></select>
    <label for="support-ref">绑定编号或工单号</label><input id="support-ref" required pattern="[A-Za-z0-9_-]+" maxlength="128" autocomplete="off"/><div class="form-actions"><button class="button secondary">读取记录</button></div></form>
    <div id="support-record"></div><p id="support-message" class="form-message" role="status"></p>`;
  let revision=0;
  const current=(r:number)=>live() && root.isConnected && revision===r;
  const output=root.querySelector<HTMLElement>('#support-record')!,message=root.querySelector<HTMLElement>('#support-message')!;
  root.querySelector<HTMLFormElement>('form')!.addEventListener('submit',async event=>{
    event.preventDefault();const r=++revision;output.innerHTML='';message.textContent='';
    const id=root.querySelector<HTMLInputElement>('#support-ref')!.value.trim(),kind=root.querySelector<HTMLSelectElement>('#support-record-kind')!.value;
    try {
      if(kind==='binding'){
        const binding=await api.supportBinding(id);if(!current(r))return;
        output.innerHTML=`<p>账号：${esc(binding.username)}</p><p>待绑定${labels[binding.kind]}：${esc(binding.contact)}</p><p class="settings-note">将确认码发到上面的联系方式，再让用户在其已登录页面填写。</p><button class="button secondary" id="support-send-code">生成绑定确认码</button>`;
        output.querySelector<HTMLButtonElement>('button')!.addEventListener('click',async event=>{
          const button=event.currentTarget as HTMLButtonElement;button.disabled=true;
          try{const result=await api.supportCode(id);if(current(r))output.innerHTML=`<p>只发送到：${esc(result.contact)}</p><label for="support-secret">一次性确认码</label><input id="support-secret" readonly value="${esc(result.code)}"/><p>有效至 ${esc(date(result.expires_at))}。刷新页面后不再显示；重新生成会作废旧码。</p>`;}
          catch(error){if(current(r))message.textContent=errorText(error,'submit');}finally{button.disabled=false;}
        });
      }else{
        const ticket=await api.supportTicket(id);if(!current(r))return;
        output.innerHTML=`<p>账号：${esc(ticket.username)}</p><p>原绑定${labels[ticket.kind]}：${esc(ticket.contact)}</p><p>绑定确认于 ${esc(date(ticket.verified_at))}；申请于 ${esc(date(ticket.requested_at))}。</p>${ticket.status==='completed'?'<p>密码已重置，请通过原渠道通知用户重新登录。</p>':`<label class="check-row"><input type="checkbox" id="support-verified"/><span>我已通过上面的原渠道联系本人，并确认本次工单。</span></label><button class="button secondary" id="support-issue" disabled>签发或重新签发重置链接</button>`}`;
        const button=output.querySelector<HTMLButtonElement>('#support-issue');
        output.querySelector('#support-verified')?.addEventListener('change',event=>{button!.disabled=!(event.target as HTMLInputElement).checked;});
        button?.addEventListener('click',async()=>{
          button.disabled=true;
          try{const result=await api.supportIssue(id,ticket.binding_id);if(current(r))output.innerHTML=`<p>只发送到：${esc(ticket.contact)}</p><label for="support-secret">一次性重置链接</label><input id="support-secret" readonly value="${esc(new URL(result.reset_path,location.origin).href)}"/><p>有效至 ${esc(date(result.expires_at))}。用户自行设置密码；用后请回到工单查看结果并通知原渠道。刷新页面后不再显示此链接。</p>`;}
          catch(error){if(current(r))message.textContent=errorText(error,'submit');}finally{button.disabled=false;}
        });
      }
    }catch(error){if(current(r))message.textContent=errorText(error,'read');}
  });
}

export async function renderRecoveryPage(api:ApiClient,root:HTMLElement,mode:'request'|'reset',token:string|undefined,live:()=>boolean,done:()=>void) {
  root.innerHTML=`<main id="main" class="closed-layout" tabindex="-1"><section class="panel form-panel"><a class="brand" href="#/">BondBuddy</a><h1>${mode==='reset'?'设置新密码':'人工找回账号'}</h1><p class="muted">${mode==='reset'?'新密码设置成功后，所有旧会话将退出。':policy}</p><div id="recovery-public-body"><p role="status">正在读取找回信息…</p></div><p id="recovery-public-message" class="form-message" role="status"></p><a class="back-link" href="#/">返回登录</a></section></main>`;
  const body=root.querySelector<HTMLElement>('#recovery-public-body')!,message=root.querySelector<HTMLElement>('#recovery-public-message')!;
  let info:Dto<'RecoveryInfoResponse'>;
  try{info=await api.recoveryInfo();}catch(error){if(live())body.textContent=errorText(error,'read');return;}
  if(!live())return;
  if(!info.enabled){body.textContent='人工找回尚未开放，请妥善保管密码。';return;}
  if(mode==='request'){
    body.innerHTML=`<p>客服：${esc(info.support_contact!)}</p><form id="recovery-request-form"><label for="recover-username">账号用户名</label><input id="recover-username" required pattern="${USERNAME_PATTERN}" maxlength="32" autocomplete="username"/><div class="form-actions"><button class="button primary">获取找回工单号</button></div></form>`;
    body.querySelector('form')!.addEventListener('submit',async event=>{
      event.preventDefault();const button=body.querySelector('button')!;button.disabled=true;
      try{const result=await api.recoveryRequest(body.querySelector<HTMLInputElement>('input')!.value.trim());if(live())body.innerHTML=`<p>已收到申请，需要核验原账号归属。</p><p>请把工单号 <code>${esc(result.ticket_id)}</code> 交给客服 ${esc(info.support_contact!)}，说明遇到的问题。请勿发送密码、验证码、身份证或客户材料。</p><p>${policy}</p>`;}
      catch(error){if(live())message.textContent=errorText(error,'submit');}finally{button.disabled=false;}
    });
  }else{
    if(!token){body.textContent='请重新打开客服发送的完整重置链接。';return;}
    body.innerHTML=`<form id="recovery-reset-form"><label for="reset-password">新密码</label><input id="reset-password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"/><p class="settings-note">${esc(PASSWORD_HELP)}</p><label for="reset-confirm">再次输入新密码</label><input id="reset-confirm" type="password" required minlength="12" maxlength="128" autocomplete="new-password"/><div class="form-actions"><button class="button primary">设置新密码并退出旧会话</button></div></form>`;
    body.querySelector('form')!.addEventListener('submit',async event=>{
      event.preventDefault();const button=body.querySelector('button')!,password=body.querySelector<HTMLInputElement>('#reset-password')!,confirm=body.querySelector<HTMLInputElement>('#reset-confirm')!;
      if(password.value!==confirm.value){message.textContent='两次输入的新密码不一致。';return;}
      button.disabled=true;
      try{await api.recoveryReset(token!,password.value);token=undefined;if(live())done();}
      catch(error){if(live())message.textContent=errorText(error,'save');}finally{password.value='';confirm.value='';button.disabled=false;}
    });
  }
}
