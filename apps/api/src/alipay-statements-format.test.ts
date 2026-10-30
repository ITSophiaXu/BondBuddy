import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAlipayStatementDocuments,validateNormalizedAlipayStatement,type NormalizedAlipayStatement} from './alipay-statements-format.js';
import {syntheticTradeCsv,syntheticTradeHeaders,syntheticTradeRows,syntheticTradeSummaryCsv} from './alipay-statements-fixtures.js';
const billDate='2026-10-28';
const normalize=(...texts:string[])=>normalizeAlipayStatementDocuments(texts.map(text=>({text})),billDate);
const normalized=(...texts:string[])=>{const result=normalize(...texts);assert.equal(result.normalization.status,'normalized');assert.equal(validateNormalizedAlipayStatement(result),true);return result as NormalizedAlipayStatement;};
const unresolved=(...texts:string[])=>assert.deepEqual(normalize(...texts),{normalization:{status:'unresolved',reasons:['ALIPAY_CSV_FORMAT_UNVERIFIED']},entries:[],totals:null});
const paymentOnly=()=>syntheticTradeCsv({rows:[syntheticTradeRows()[0]],refundFooter:'#退款合计: 0笔, 商家实收退款共0.00元, 商家优惠退款共0.00元'});

test('documented named fields and detail footers normalize payment/refund separately while preserving signed values',()=>{
  const result=normalized(syntheticTradeCsv({preamble:true}));
  assert.deepEqual(result.normalization,{status:'normalized',format:'alipay-trade-cn-v1'});
  assert.deepEqual(result.totals,{payment:{count:1,amountFen:'10000',merchantReceivedFen:'9700',merchantDiscountFen:'300',feeFen:'60'},
    refund:{count:1,amountFen:'2000',merchantReceivedFen:'1900',merchantDiscountFen:'100',feeFen:'12'}});
  assert.equal(result.entries[0].line,6);assert.equal(result.entries[0].completedLocalTime,'2026-10-28 09:10:11');
  assert.deepEqual(result.entries[1].sourceAmounts,{amountFen:'-2000',merchantReceivedFen:'-1900',merchantDiscountFen:'-100',feeFen:'12'});
  assert.equal(result.entries[1].refundId,'refund_1');assert.equal(result.entries[0].sourceAmounts.feeFen,'-60');
  for(const entry of result.entries)for(const field of ['appId','buyerCash','payerCash','eventAt','currency','providerRefundId'])assert.equal(field in entry,false);
  assert.equal(JSON.stringify(result).includes('synthetic product'),false);
});

test('configured column order, documented order-ID alias, quoting, multiline ignored text, and trailing delimiters are supported',()=>{
  const rows=syntheticTradeRows();rows[0][3]='synthetic, "quoted"\nsecond line';
  const order=[9,3,1,5,0,7,2,8,4,6],headers=order.map(index=>syntheticTradeHeaders[index]).map(key=>key==='商家订单号'?'商户订单号':key);
  const result=normalized(syntheticTradeCsv({headers,rows:rows.map(row=>order.map(index=>row[index]))}));
  assert.equal(result.entries[0].orderId,'order_1');assert.equal(result.entries[1].line,4);
  const text=syntheticTradeCsv().split('\r\n').map((line,index)=>index<3?line+',':line).join('\r\n');normalized(text);
});

test('money parsing is exact beyond Number precision and enforces signed int64 sums',()=>{
  const rows=syntheticTradeRows();rows[0][5]='90071992547409.93';rows[0][6]='90071992547409.93';rows[0][7]='0.00';
  const result=normalized(syntheticTradeCsv({rows,paymentFooter:'#交易合计: 1笔, 商家实收共90071992547409.93元, 商家优惠共0.00元'}));
  assert.equal(result.entries[0].amountFen,'9007199254740993');
  for(const value of ['1.001','1e2','1,000.00','92233720368547758.08','--20.00','NaN'])unresolved(syntheticTradeCsv().replace(',100.00,',','+value+','));
  const huge=syntheticTradeRows()[0];huge[5]='92233720368547758.07';huge[6]=huge[5];huge[7]='0.00';
  normalized(syntheticTradeCsv({rows:[huge],paymentFooter:'#交易合计: 1笔, 商家实收共92233720368547758.07元, 商家优惠共0.00元',refundFooter:'#退款合计: 0笔, 商家实收退款共0.00元, 商家优惠退款共0.00元'}));
  const extra=[...huge];extra[0]='2026102800000002';extra[1]='order_2';
  unresolved(syntheticTradeCsv({rows:[huge,extra]}));
});

test('positive and negative refund source conventions are explicit, while mixed signs and inconsistent principal are rejected',()=>{
  normalized(syntheticTradeCsv().replace('-20.00,-19.00,-1.00','+20.00,+19.00,+1.00'));
  normalized(syntheticTradeCsv().replace('商家实收退款共19.00元, 商家优惠退款共1.00元','商家实收退款共-19.00元, 商家优惠退款共-1.00元'));
  for(const fragment of ['-20.00,19.00,-1.00','-20.00,-19.00,1.00','-20.00,-18.00,-1.00','-20.00,-21.00,-1.00'])
    unresolved(syntheticTradeCsv().replace('-20.00,-19.00,-1.00',fragment));
  unresolved(syntheticTradeCsv().replace('100.00,97.00,3.00','-100.00,-97.00,-3.00'));
  unresolved(syntheticTradeCsv().replace('商家实收退款共19.00元, 商家优惠退款共1.00元','商家实收退款共-19.00元, 商家优惠退款共1.00元'));
});

test('missing optional financial columns and blank evidence remain null, never a manufactured zero',()=>{
  const keep=[0,1,2,3,4,5,9],rows=syntheticTradeRows();
  const result=normalized(syntheticTradeCsv({headers:keep.map(i=>syntheticTradeHeaders[i]),rows:rows.map(row=>keep.map(i=>row[i]))}));
  for(const entry of result.entries){assert.equal(entry.merchantReceivedFen,null);assert.equal(entry.merchantDiscountFen,null);assert.equal(entry.feeFen,null);}
  assert.equal(result.totals.payment.merchantReceivedFen,null);assert.equal(result.totals.refund.feeFen,null);
  rows[0][6]='';rows[0][8]='';const blank=normalized(syntheticTradeCsv({rows}));assert.equal(blank.totals.payment.merchantReceivedFen,null);assert.equal(blank.totals.payment.feeFen,null);
});

test('missing/duplicate core headers, ambiguous aliases, unknown businesses and invalid refund identities reject all rows',()=>{
  unresolved(syntheticTradeCsv().replace('完成时间','completion_time'));
  unresolved(syntheticTradeCsv().replace('商品名称','完成时间'));
  unresolved(syntheticTradeCsv().replace('商品名称','商户订单号'));
  unresolved(syntheticTradeCsv().replace(',交易,',',等待付款,'));
  unresolved(syntheticTradeCsv().replace(',refund_1\r\n',',\r\n'));
  unresolved(syntheticTradeCsv().replace('-0.60,\r\n','-0.60,unexpected_refund\r\n'));
  unresolved(syntheticTradeCsv().replace(',order_1,',',invalid order,'));
  unresolved(syntheticTradeCsv().replace('支付宝交易号','trade_no'));
});

test('both count/receipt/merchant-discount footers are mandatory and must agree with known detail amounts',()=>{
  const text=syntheticTradeCsv();
  unresolved(text.replace(/#退款合计[^\r]+\r\n/,''));
  unresolved(text.replace('#交易合计: 1笔','#交易合计: 2笔'));
  unresolved(text.replace('商家实收共97.00元','商家实收共97.01元'));
  unresolved(text.replace('商家优惠退款共1.00元','商家优惠退款共0.99元'));
  unresolved(text+'#退款合计: 1笔, 商家实收退款共19.00元, 商家优惠退款共1.00元\r\n');
  unresolved(text+'unexpected,record\r\n');
  unresolved(text+'#unknown comment\r\n');
  unresolved(text.replace('#交易合计: 1笔','#合计: 2笔'));
});

test('recognized empty detail is zero only after both explicit zero footers; missing files stay unresolved',()=>{
  const text=syntheticTradeCsv({rows:[],paymentFooter:'#交易合计: 0笔, 商家实收共0.00元, 商家优惠共0.00元',refundFooter:'#退款合计: 0笔, 商家实收退款共0.00元, 商家优惠退款共0.00元'});
  const result=normalized(text);assert.deepEqual(result.entries,[]);assert.equal(result.totals.payment.amountFen,'0');assert.equal(result.totals.refund.merchantReceivedFen,'0');
  unresolved(text.replace('商家实收共0.00元','商家实收共1.00元'));unresolved();unresolved('');
});

test('duplicate or conflicting event/order identities and a bad later row never retain an earlier valid payment',()=>{
  const rows=syntheticTradeRows();unresolved(syntheticTradeCsv({rows:[...rows,rows[1]]}));
  const duplicate=[...rows[0]];duplicate[0]='2026102800000002';unresolved(syntheticTradeCsv({rows:[rows[0],duplicate]}));
  const conflict=[...rows[1]];conflict[1]='order_2';unresolved(syntheticTradeCsv({rows:[rows[0],conflict]}));
  const anotherTransaction=[...rows[1]];anotherTransaction[0]='2026102800000002';anotherTransaction[9]='refund_2';
  unresolved(syntheticTradeCsv({rows:[rows[1],anotherTransaction]}));
  const bad=[...rows[1]];bad[5]='bad';unresolved(syntheticTradeCsv({rows:[rows[0],bad]}));
});

test('calendar dates, completed local day, and daily metadata range are validated without inventing timezone',()=>{
  for(const value of ['2026-10-27 10:20:30','2026-02-30 10:20:30','2026-10-28 24:00:00','2026-10-28 10:20:30Z','2026-10-28T10:20:30+08:00'])
    unresolved(syntheticTradeCsv().replace('2026-10-28 10:20:30',value));
  unresolved(syntheticTradeCsv({preamble:true}).replace('终止日期: [2026年10月29日','终止日期: [2026年10月30日'));
  assert.equal(normalizeAlipayStatementDocuments([{text:syntheticTradeCsv()}],'2026-02-30').normalization.status,'unresolved');
});

test('bounded RFC4180 rejects malformed quoting, control text, too many columns and oversized logical records',()=>{
  unresolved(syntheticTradeCsv().replace('synthetic product','bad"quote'));
  unresolved(syntheticTradeCsv().replace('synthetic product','"unterminated'));
  unresolved(syntheticTradeCsv().replace('synthetic product','"closed"tail'));
  unresolved(syntheticTradeCsv().replace('synthetic product','bad\0text'));
  unresolved(syntheticTradeCsv().replace('synthetic product','"'+('x'.repeat(17000)+'\n').repeat(2)+'"'));
  unresolved(syntheticTradeCsv().replace('synthetic product','x'.repeat(32769)));
  unresolved(syntheticTradeCsv({headers:Array.from({length:65},(_,i)=>'column'+i),rows:[]}));
  unresolved('\n'.repeat(20065)+syntheticTradeCsv());
});

test('entry physical line limit is enforced at its accepted boundary without Number-based money summation',()=>{
  const base=syntheticTradeRows()[0];base[5]='0.01';base[6]='0.01';base[7]='0.00';base[8]='0.00';
  const rows=Array.from({length:19999},(_,i)=>{const row=[...base];row[0]='tx_'+i;row[1]='order_'+i;return row;});
  const text=syntheticTradeCsv({rows,paymentFooter:'#交易合计: 19999笔, 商家实收共199.99元, 商家优惠共0.00元',refundFooter:'#退款合计: 0笔, 商家实收退款共0.00元, 商家优惠退款共0.00元'});
  const result=normalized(text);assert.equal(result.entries.at(-1)?.line,20000);assert.equal(result.totals.payment.amountFen,'19999');
  unresolved('\n'+text);
});

test('recognized payment-only summary can be matched in either member order and checks signed fee, counts and totals',()=>{
  const detail=paymentOnly(),summary=syntheticTradeSummaryCsv();normalized(detail,summary);normalized(summary,detail);
  unresolved(detail,summary.replace('合计,,1,0','合计,,2,0'));
  unresolved(detail,summary.replaceAll('100.00,97.00','101.00,97.00'));
  unresolved(detail,summary.replaceAll('-0.60','0.60'));
  unresolved(detail,summary.replace('合计,,1,0,100.00,97.00','合计,,1,0,100.00,96.99'));
  unresolved(detail,summary.replace(/合计[^\r]+\r\n/,''));
  unresolved(detail,summary+'unrecognized,row\r\n');
});

test('unknown summary layouts, refund/netting summaries, duplicate details and extra members remain wholly unresolved',()=>{
  unresolved(paymentOnly(),'unknown,summary\n');
  unresolved(paymentOnly(),syntheticTradeSummaryCsv().replace('交易订单总数','unknown_count'));
  unresolved(syntheticTradeCsv(),syntheticTradeSummaryCsv());
  unresolved(syntheticTradeCsv(),syntheticTradeCsv());
  unresolved(paymentOnly(),syntheticTradeSummaryCsv(),'unknown');
});

test('normalized persistence validator rejects tampered structure, signed provenance, identities and sums',()=>{
  const base=normalized(syntheticTradeCsv());
  const mutations:((value:Record<string,any>)=>void)[]=[
    value=>delete value.entries[0].sourceAmounts,
    value=>value.entries[0].amountFen='010000',value=>value.entries[0].amountFen='-10000',
    value=>value.entries[0].sourceAmounts.amountFen='10001',value=>value.entries[0].sourceAmounts.feeFen='not-money',
    value=>value.entries[0].merchantReceivedFen='9223372036854775808',value=>value.entries[0].line=20001,
    value=>value.entries[1].line=value.entries[0].line,value=>value.entries[1].refundId=null,
    value=>value.entries[0].completedLocalTime='2026-02-30 00:00:00',value=>value.totals.payment.amountFen='1',
    value=>value.totals.refund.count=2,value=>value.totals.payment.feeFen=null,
    value=>value.normalization.format='invented',value=>value.entries.push(value.entries[0]),
  ];
  for(const mutate of mutations){const value=structuredClone(base);mutate(value);assert.equal(validateNormalizedAlipayStatement(value),false);}
  assert.equal(validateNormalizedAlipayStatement({...base,billDate:'2026-10-27'}),false);
  for(const value of [null,{},[],{normalization:{status:'unresolved'},entries:[],totals:null}])assert.equal(validateNormalizedAlipayStatement(value),false);
});
