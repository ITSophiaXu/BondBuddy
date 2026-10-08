import { ApiClient, type Dto } from './api';

/** One wallet per signed-in session; route rendering never owns or clears the balance. */
export class CreditWallet {
  private controller = new AbortController();
  private balance?: Dto<'CreditBalanceResponse'>;
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
    // Reserved credits still belong to the user until delivery settles the task.
    const amount = this.unavailable ? '—' : this.balance ? (this.balance.available + this.balance.frozen).toLocaleString('zh-CN') : '…';
    for (const host of document.querySelectorAll<HTMLElement>('[data-credit-wallet]')) {
      const compact = host.dataset.creditWallet === 'compact';
      host.innerHTML = compact
        ? `<a href="#/account" aria-label="积分余额 ${amount}，查看我的账号"><span>积分</span> <strong aria-live="polite">${amount}</strong></a>`
        : `<div class="wallet-heading"><span>积分余额</span><button type="button" class="wallet-refresh" aria-label="刷新积分余额" ${this.loading ? 'disabled' : ''}>刷新</button></div>
          <div class="wallet-value" aria-live="polite"><strong>${amount}</strong><a href="#/account" aria-label="查看积分与充值">充值 <span aria-hidden="true">↗</span></a></div>
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
      const balance = await this.api.creditBalance(this.controller.signal);
      if (this.controller.signal.aborted) return;
      this.balance = balance; this.unavailable = false;
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
