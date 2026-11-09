// Loaded only by the dedicated local nginx overlay; production assets stay intact.
const banner=document.createElement('div');banner.id='prelaunch-banner';
banner.textContent='本地上线验收环境 · 文件和任务真实执行 · 支付为模拟渠道，不扣真钱';
document.body.prepend(banner);
const sheet=document.createElement('link');sheet.rel='stylesheet';sheet.href='/__prelaunch/local.css';document.head.append(sheet);
function update(){
  const hash=location.hash.replace(/^#\/?/,''),query=hash.startsWith('account?')?new URLSearchParams(hash.slice(8)):null;
  const order=query?.get('order');if(!order)return;
  for(const card of document.querySelectorAll('.payment-card')){
    for(const qr of card.querySelectorAll('.commerce-native-payment'))qr.hidden=true;
    for(const link of card.querySelectorAll('a[href^="weixin://"]'))link.hidden=true;
    const refresh=card.querySelector('#refresh-subscription-payment,#refresh-payment');if(!refresh)continue;
    let entry=card.querySelector('[data-local-payment-checkout]');
    if(!entry){entry=document.createElement('a');entry.className='btn primary';entry.dataset.localPaymentCheckout='true';entry.textContent='打开模拟收银台';refresh.before(entry);}
    entry.href='/__prelaunch/checkout?'+new URLSearchParams({order,return_to:location.pathname+location.search+location.hash});
  }
}
new MutationObserver(update).observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('hashchange',update);update();
