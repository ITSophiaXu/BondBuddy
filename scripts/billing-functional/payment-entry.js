// Injected by the loopback Vite harness only; never included in the product build.
function localizePayment(){
  const hash=location.hash.replace(/^#\/?/,''),query=hash.startsWith('account?')?new URLSearchParams(hash.slice(8)):null;
  const order=query?.get('order');if(!order)return;
  const target='/__billing-test/checkout?'+new URLSearchParams({order,return_to:location.pathname+location.search+location.hash});
  for(const card of document.querySelectorAll('.payment-card')){
    // Hide the synthetic native QR before exposing the local cashier. Payment
    // amount, original order ID, refund controls and real refresh stay intact.
    for(const node of card.querySelectorAll('.commerce-native-payment')){node.hidden=true;node.style.display='none';}
    for(const link of card.querySelectorAll('a[href^="weixin://"]'))link.hidden=true;
    const refresh=card.querySelector('#refresh-subscription-payment,#refresh-payment');
    if(!refresh)continue;
    let entry=card.querySelector('[data-local-payment-entry]');
    if(!entry){
      entry=document.createElement('div');entry.dataset.localPaymentEntry='true';
      const notice=document.createElement('p');notice.textContent='本地模拟支付，不扣真钱。请进入模拟收银台选择支付结果；刷新只核对原订单，不会自动付款。';
      const link=document.createElement('a');link.className='btn primary';link.dataset.localPaymentCheckout='true';link.textContent='打开模拟收银台';entry.append(notice,link);refresh.before(entry);
    }
    const link=entry.querySelector('a');if(link.getAttribute('href')!==target)link.setAttribute('href',target);
  }
}
new MutationObserver(localizePayment).observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('hashchange',localizePayment);localizePayment();
