import {alipayReturnRoute} from './payment-return-route';
import '../../../product-prototype/public/payment-experience.css';

const target=alipayReturnRoute(location.search);
// Strip provider query strings before loading the account or leaving this page.
history.replaceState(null,'',location.pathname);
if(target){
  const link=document.querySelector<HTMLAnchorElement>('#payment-return-link');
  if(link)link.href='/'+target;
  location.replace('/'+target);
}else{
  document.querySelector('#payment-return-title')!.textContent='需要核对本次订单';
  document.querySelector('#payment-return-message')!.textContent='未取得完整的订单信息。请返回账户，在充值记录中查看本次付款；已完成的付款无须再次支付。';
}
