/** Return parameters identify a candidate order only. The authenticated API is
 * the sole authority for ownership, payment and credited points. */
export function alipayReturnRoute(search:string):string|undefined{
  const params=new URLSearchParams(search),ids=params.getAll('out_trade_no');
  if(ids.length!==1||!validPaymentOrderId(ids[0]))return undefined;
  return '#/account?'+new URLSearchParams({order:ids[0],payment_return:'alipay'});
}
export function validPaymentOrderId(value:string){return /^[A-Za-z0-9_-]{1,128}$/.test(value);}
export function paymentLoginReturn(hash:string):string|undefined{
  if(hash.split('?')[0]!=='#/account')return undefined;
  const params=new URLSearchParams(hash.split('?')[1]);
  if(params.getAll('payment_return').length!==1||params.get('payment_return')!=='alipay'||params.getAll('order').length!==1)return undefined;
  const order=params.get('order')!;
  return validPaymentOrderId(order)?'#/account?'+new URLSearchParams({order,payment_return:'alipay'}):undefined;
}
