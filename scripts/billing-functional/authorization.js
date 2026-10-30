// Served ONLY by the loopback Vite harness. Production UI keeps its original
// payment-channel links and HTTPS validation. No request is sent to this domain.
const synthetic=link=>{
  if(!(link instanceof HTMLAnchorElement))return false;
  try{const url=new URL(link.href);return url.origin==='https://billing-functional.invalid'&&/^\/mandates\/[a-f0-9]{32}$/.test(url.pathname);}
  catch{return false;}
};
function localize(){
  for(const link of document.querySelectorAll('a[href]'))if(synthetic(link)){
    link.dataset.localSyntheticMandate='true';link.href=location.origin+'/#/account';link.removeAttribute('target');
    link.title='本地合成授权：点击刷新签约结果，不访问外部支付渠道';
  }
}
document.addEventListener('click',event=>{
  const link=event.target instanceof Element?event.target.closest('a'):null;
  if(!link||!(link.dataset.localSyntheticMandate==='true'||synthetic(link)))return;
  event.preventDefault();event.stopImmediatePropagation();
  const refresh=document.querySelector('#subscription-mandate-refresh');
  if(refresh instanceof HTMLButtonElement&&!refresh.disabled)refresh.click();
  else location.hash='/account';
},true);
new MutationObserver(localize).observe(document.documentElement,{childList:true,subtree:true});localize();
