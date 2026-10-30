/** Official modern columns, synthetic amounts and identifiers only. No customer bill data. */
export const statementFixtureDate='2026-10-27';
export const tradeHeaders='交易时间,公众账号ID,商户号,特约商户号,设备号,微信订单号,商户订单号,用户标识,交易类型,交易状态,付款银行,货币种类,应结订单金额,代金券金额,微信退款单号,商户退款单号,退款金额,充值券退款金额,退款类型,退款状态,商品名称,商户数据包,手续费,费率,订单金额,申请退款金额,费率备注';
const cells=(header:string,values:Record<string,string>)=>header.split(',').map(name=>'`'+(values[name]??'')).join(',');
export function syntheticTradeStatement(options:{merchant?:string;appId?:string;orderId?:string;transactionId?:string;refundId?:string;providerRefundId?:string;refund?:boolean;refundStatus?:string;date?:string;cashDiscount?:boolean}={}){
  const date=options.date??statementFixtureDate;
  const base={'交易时间':date+' 12:00:00','公众账号ID':options.appId??'wx1234567890abcdef','商户号':options.merchant??'1900000001','特约商户号':'0','微信订单号':options.transactionId??'synthetic_transaction_1','商户订单号':options.orderId??'synthetic_order_1','交易类型':'NATIVE','货币种类':'CNY','付款银行':'SYNTHETIC','商品名称':'synthetic\\ item'};
  const payment={...base,'交易状态':'SUCCESS','应结订单金额':'100.00','代金券金额':options.cashDiscount?'10.00':'0.00','微信退款单号':'0','商户退款单号':'0','退款金额':'0.00','充值券退款金额':'0.00','手续费':'0.60','订单金额':'100.00','申请退款金额':'0.00'};
  const refund={...base,'交易时间':date+' 13:00:00','交易状态':'REFUND','应结订单金额':'0.00','代金券金额':'0.00','微信退款单号':options.providerRefundId??'synthetic_channel_refund_1','商户退款单号':options.refundId??'synthetic_refund_1','退款金额':'25.00','充值券退款金额':'0.00','退款类型':'ORIGINAL','退款状态':options.refundStatus??'PROCESSING','手续费':'-0.15','订单金额':'0.00','申请退款金额':'25.00'};
  const footer='总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额';
  const totals=options.refund?'`2,`100.00,`25.00,`0.00,`0.45,`100.00,`25.00':'`1,`100.00,`0.00,`0.00,`0.60,`100.00,`0.00';
  return [tradeHeaders,cells(tradeHeaders,payment),...(options.refund?[cells(tradeHeaders,refund)]:[]),footer,totals].join('\r\n')+'\r\n';
}
export const fundHeaders='记账时间,微信支付业务单号,资金流水单号,业务名称,业务类型,收支类型,收支金额(元),账户结余(元),资金变更提交申请人,备注,业务凭证号';
export function syntheticFundStatement(options:{date?:string;transactionId?:string;orderId?:string;type?:string;direction?:'收入'|'支出';amount?:string}={}){
  const direction=options.direction??'收入',amount=options.amount??'100.00';
  const entry={'记账时间':(options.date??statementFixtureDate)+' 12:01:00','微信支付业务单号':options.transactionId??'synthetic_transaction_1','资金流水单号':'synthetic_flow_1','业务名称':'交易','业务类型':options.type??'交易','收支类型':direction,'收支金额(元)':amount,'账户结余(元)':'100.00','业务凭证号':options.orderId??'synthetic_order_1'};
  return [fundHeaders,cells(fundHeaders,entry),'资金流水总笔数,收入笔数,收入金额,支出笔数,支出金额',direction==='收入'?`\`1,\`1,\`${amount},\`0,\`0.00`:`\`1,\`0,\`0.00,\`1,\`${amount}`].join('\n')+'\n';
}
