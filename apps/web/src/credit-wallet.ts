import { ApiClient, type Dto } from './api';
import { rechargeHref } from './project-navigation';
import { esc } from './ui';
import {readCommerce,cny} from './commerce';
import type {CommerceAccount} from '@bondbuddy/contracts';
import type {SubscriptionAccount} from '@bondbuddy/contracts';
import {readSubscriptionCatalog} from './subscription-billing-page';

/** One wallet per signed-in session; route rendering never owns or clears the balance. */
export class CreditWallet {
  private controller = new AbortController();
  private balance?: Dto<'CreditBalanceResponse'>;
  private commerce=false;private account?:CommerceAccount;
  private subscription=false;private subscriptionAccount?:SubscriptionAccount;
  private loading = false;
  private unavailable = false;
  private refreshPending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private onReturn = () => { if (!document.hidden) void this.refresh(); };
  constructor(private api: ApiClient) {
    document.addEventListener('visibilitychange', this.onReturn);
    window.addEventListener('focus', this.onReturn);
    window.addEventListener('online', this.onReturn);
    window.addEventListener('bondbuddy:credits-changed', this.onReturn);
  }
  mount() {
    this.draw();
    void this.refresh();
  }
  private draw() {
    if(this.subscription){
      const account=this.subscriptionAccount,amount=this.unavailable?'—':account?(account.available_points+account.held_points).toLocaleString('zh-CN'):'…',href=esc(rechargeHref());
      document.querySelectorAll<HTMLElement>('.top-plan-link').forEach(e=>{e.textContent='订阅与充值';});
      for(const host of document.querySelectorAll<HTMLElement>('[data-credit-wallet]')){host.setAttribute('aria-label','积分余额');host.innerHTML=host.dataset.creditWallet==='compact'?`<a href="${href}" aria-label="积分余额 ${amount}，查看我的账号"><span>积分</span> <strong aria-live="polite">${amount}</strong></a>`:`<div class="wallet-heading"><span>积分余额</span><button type="button" class="wallet-refresh" aria-label="刷新积分余额" ${this.loading?'disabled':''}>刷新</button></div><div class="wallet-value" aria-live="polite"><strong>${amount}</strong><a href="${href}" aria-label="查看订阅与充值">充值 ↗</a></div><p class="wallet-note">${this.unavailable?'积分暂未同步，请刷新':account?`可用 ${account.available_points.toLocaleString('zh-CN')} · 已预留 ${account.held_points.toLocaleString('zh-CN')} 积分`:'正在读取积分'}</p>`;host.querySelector('button')?.addEventListener('click',()=>void this.refresh());}
      return;
    }
    if(this.commerce){
      const amount=this.unavailable?'—':this.account?cny(this.account.available_fen+this.account.held_fen):'…',href=esc(rechargeHref());
      document.querySelectorAll<HTMLElement>('.top-plan-link').forEach(e=>{e.textContent='按成果付费 · 无月费';});
      for(const host of document.querySelectorAll<HTMLElement>('[data-credit-wallet]')){host.setAttribute('aria-label','人民币服务余额');host.innerHTML=host.dataset.creditWallet==='compact'?`<a href="${href}" aria-label="服务余额 ${amount}，查看我的账号"><span>余额</span> <strong aria-live="polite">${amount}</strong></a>`:`<div class="wallet-heading"><span>服务余额</span><button type="button" class="wallet-refresh" aria-label="刷新服务余额" ${this.loading?'disabled':''}>刷新</button></div><div class="wallet-value" aria-live="polite"><strong>${amount}</strong><a href="${href}" aria-label="查看余额与按需充值">充值 ↗</a></div><p class="wallet-note">${this.unavailable?'余额暂未同步，请刷新':this.account?`可用 ${cny(this.account.available_fen)} · 已预留 ${cny(this.account.held_fen)}`:'正在读取余额'}</p>`;host.querySelector('button')?.addEventListener('click',()=>void this.refresh());}
      return;
    }
    // Reserved credits still belong to the user until delivery settles the task.
    const amount = this.unavailable ? '—' : this.balance ? (this.balance.available + this.balance.frozen).toLocaleString('zh-CN') : '…';
    const accountHref=esc(rechargeHref());
    for (const host of document.querySelectorAll<HTMLElement>('[data-credit-wallet]')) {
      const compact = host.dataset.creditWallet === 'compact';
      host.innerHTML = compact
        ? `<a href="${accountHref}" aria-label="积分余额 ${amount}，查看我的账号"><span>积分</span> <strong aria-live="polite">${amount}</strong></a>`
        : `<div class="wallet-heading"><span>积分余额</span><button type="button" class="wallet-refresh" aria-label="刷新积分余额" ${this.loading ? 'disabled' : ''}>刷新</button></div>
          <div class="wallet-value" aria-live="polite"><strong>${amount}</strong><a href="${accountHref}" aria-label="查看积分与充值">充值 <span aria-hidden="true">↗</span></a></div>
          <p class="wallet-note">${this.unavailable ? '余额暂未同步，请刷新重试' : this.balance ? this.balance.frozen ? `可用 ${this.balance.available.toLocaleString('zh-CN')} · 任务已预留 ${this.balance.frozen.toLocaleString('zh-CN')} 积分` : '暂无预留积分' : '正在读取余额'}</p>`;
      host.querySelector('button')?.addEventListener('click', () => { void this.refresh(); });
    }
  }
  async refresh() {
    if (this.controller.signal.aborted) return;
    if (this.loading) { this.refreshPending = true; return; }
    clearTimeout(this.timer);
    this.loading = true;
    try {
      const subscriptions=await readSubscriptionCatalog(this.api,this.controller.signal);this.subscription=subscriptions?.enabled===true;
      if(this.subscription){this.subscriptionAccount=await this.api.subscriptionAccount(this.controller.signal);this.unavailable=false;return;}
      const catalog=await readCommerce(this.api,this.controller.signal);this.commerce=catalog?.enabled===true;
      const account=this.commerce?await this.api.commerceAccount(this.controller.signal):undefined;
      const balance = this.commerce?undefined:await this.api.creditBalance(this.controller.signal);
      if (this.controller.signal.aborted) return;
      this.balance = balance;this.account=account; this.unavailable = false;
    } catch {
      if (!this.controller.signal.aborted) this.unavailable = true;
    } finally {
      this.loading = false;
      if (!this.controller.signal.aborted) {
        this.draw();
        if (this.refreshPending) { this.refreshPending = false; void this.refresh(); }
        else this.timer = setTimeout(() => { if (!document.hidden) void this.refresh(); }, 30000);
      }
    }
  }
  dispose() {
    this.controller.abort(); clearTimeout(this.timer); this.balance = undefined;
    document.removeEventListener('visibilitychange', this.onReturn);
    window.removeEventListener('focus', this.onReturn);
    window.removeEventListener('online', this.onReturn);
    window.removeEventListener('bondbuddy:credits-changed', this.onReturn);
  }
}
