import {createHash} from 'node:crypto';

export type StatementAccount='BASIC'|'OPERATION'|'FEES';
export type PaymentStatementRequest={billDate:string;kind:'trade'|'funds';accountType?:StatementAccount};
export type TradeStatementEntry={kind:'payment'|'refund';line:number;eventAt:string;appId:string;merchantId:string;
  transactionId:string;orderId:string;tradeType:string;currency:'CNY';nominalFen:number;settlementFen:number;couponFen:number;feeFen:number;
  refundId:string|null;providerRefundId:string|null;refundRequestedFen:number;refundSettlementFen:number;refundCouponFen:number;refundStatus:string};
export type FundStatementEntry={kind:'funds';line:number;eventAt:string;businessId:string;flowId:string;businessName:string;businessType:string;
  direction:'income'|'expense';amountFen:number;balanceFen:number;voucherId:string};
export type StatementEntry=TradeStatementEntry|FundStatementEntry;
export type StatementTotals={count:number;nominalFen:number;settlementFen:number;refundRequestedFen:number;refundSettlementFen:number;refundCouponFen:number;feeFen:number;incomeCount:number;incomeFen:number;expenseCount:number;expenseFen:number};
/** Only a signed application response plus matching downloaded SHA1 can create an available statement. */
export type VerifiedPaymentStatement={provider:'wechat';merchantId:string;appId:string;billDate:string;kind:'trade'|'funds';accountType:StatementAccount|null;
  availability:'available'|'absent';sha1:string|null;sha256:string|null;byteLength:number;verifiedAt:string;entries:StatementEntry[];totals:StatementTotals};
export const emptyStatementTotals=():StatementTotals=>({count:0,nominalFen:0,settlementFen:0,refundRequestedFen:0,refundSettlementFen:0,refundCouponFen:0,feeFen:0,incomeCount:0,incomeFen:0,expenseCount:0,expenseFen:0});
export class StatementFormatError extends Error {constructor(){super('Payment statement format or totals invalid');this.name='StatementFormatError';}}
const invalid=():never=>{throw new StatementFormatError();};
export function statementDate(value:string):string{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)return invalid();
  return value;
}
const safe=(n:number)=>{if(!Number.isSafeInteger(n))return invalid();return n;};
export function statementMoney(value:string,signed=false):number{
  if(!(signed?/^-?\d{1,13}\.\d{2}$/:/^\d{1,13}\.\d{2}$/).test(value))return invalid();
  const negative=value.startsWith('-'),digits=negative?value.slice(1):value,[whole,fraction]=digits.split('.');
  return safe(Number((BigInt(whole)*100n+BigInt(fraction))*(negative?-1n:1n)));
}
const integer=(value:string)=>/^\d{1,8}$/.test(value)?safe(Number(value)):invalid();
const identifier=(value:string,allowZero=false)=>{
  if(allowZero&&(value===''||value==='0'))return '';
  if(!/^[A-Za-z0-9_|*@-]{1,128}$/.test(value))return invalid();return value;
};
const text=(value:string,max=128)=>{if(value.length>max||/[\x00-\x1f\x7f]/.test(value))return invalid();return value;};
const time=(value:string,billDate:string)=>{
  if(!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)||value.slice(0,10)!==billDate)return invalid();
  const iso=value.replace(' ','T')+'+08:00';if(!Number.isFinite(Date.parse(iso)))return invalid();
  return new Date(iso).toISOString();
};
const fields=(line:string)=>line.split(',').map(value=>value.trim().replace(/^`/,''));
const row=(headers:string[],line:string)=>{
  const cells=fields(line);if(cells.length===headers.length+1&&cells.at(-1)==='')cells.pop();if(cells.length!==headers.length)return invalid();return Object.fromEntries(headers.map((header,index)=>[header,cells[index]]));
};
const uniqueHeaders=(line:string)=>{const header=fields(line);if(header.at(-1)==='')header.pop();if(!header.length||header.length>64||new Set(header).size!==header.length||header.some(h=>!h))return invalid();return header;};

/** Modern API-v3 ALL / fundflow CSV only. Unknown historical formats stay unresolved. */
export function parsePaymentStatement(bytes:Uint8Array,input:PaymentStatementRequest&{merchantId:string;appId:string;sha1:string;verifiedAt:string}):VerifiedPaymentStatement{
  statementDate(input.billDate);
  if(bytes.byteLength>10*1024*1024||bytes.byteLength===0)return invalid();
  let content:string;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{return invalid();}
  if(content.includes('\0'))return invalid();
  const lines=content.trimEnd().split(/\r?\n/);if(lines.length<3||lines.length>20003||lines.some(line=>line.length>16384))return invalid();
  const header=uniqueHeaders(lines[0]),summaryHeader=uniqueHeaders(lines.at(-2)!),summary=row(summaryHeader,lines.at(-1)!);
  const entries:StatementEntry[]=[],totals=emptyStatementTotals(),seen=new Set<string>();
  const required=input.kind==='trade'
    ?['交易时间','公众账号ID','商户号','特约商户号','微信订单号','商户订单号','交易类型','交易状态','货币种类','应结订单金额','代金券金额','微信退款单号','商户退款单号','退款金额','充值券退款金额','退款状态','手续费','订单金额','申请退款金额']
    :['记账时间','微信支付业务单号','资金流水单号','业务名称','业务类型','收支类型','收支金额(元)','账户结余(元)','业务凭证号'];
  if(!required.every(name=>header.includes(name)))return invalid();
  for(let i=1;i<lines.length-2;i++){
    const r=row(header,lines[i]);let entry:StatementEntry,key:string;
    if(input.kind==='trade'){
      if(r['商户号']!==input.merchantId||!['0',''].includes(r['特约商户号'])||r['货币种类']!=='CNY'||!['SUCCESS','REFUND'].includes(r['交易状态']))return invalid();
      const refund=r['交易状态']==='REFUND';
      entry={kind:refund?'refund':'payment',line:i+1,eventAt:time(r['交易时间'],input.billDate),appId:identifier(r['公众账号ID']),merchantId:r['商户号'],
        transactionId:identifier(r['微信订单号']),orderId:identifier(r['商户订单号']),tradeType:text(r['交易类型']),currency:'CNY',
        nominalFen:statementMoney(r['订单金额']),settlementFen:statementMoney(r['应结订单金额']),couponFen:statementMoney(r['代金券金额']),feeFen:statementMoney(r['手续费'],true),
        refundId:identifier(r['商户退款单号'],!refund)||null,providerRefundId:identifier(r['微信退款单号'],!refund)||null,
        refundRequestedFen:statementMoney(r['申请退款金额']),refundSettlementFen:statementMoney(r['退款金额']),refundCouponFen:statementMoney(r['充值券退款金额']),refundStatus:text(r['退款状态'])};
      if(refund?(entry.refundRequestedFen<=0||entry.nominalFen!==0||entry.settlementFen!==0||!['SUCCESS','PROCESSING','FAIL','CHANGE'].includes(entry.refundStatus))
        :(entry.nominalFen<=0||entry.refundRequestedFen!==0||entry.refundSettlementFen!==0||entry.refundId!==null||entry.providerRefundId!==null))return invalid();
      key=entry.kind+':'+(entry.refundId??entry.orderId);
      for(const name of ['nominalFen','settlementFen','refundRequestedFen','refundSettlementFen','refundCouponFen','feeFen'] as const)totals[name]=safe(totals[name]+entry[name]);
    }else{
      if(!['收入','支出'].includes(r['收支类型']))return invalid();
      entry={kind:'funds',line:i+1,eventAt:time(r['记账时间'],input.billDate),businessId:identifier(r['微信支付业务单号'],true),flowId:identifier(r['资金流水单号']),
        businessName:text(r['业务名称']),businessType:text(r['业务类型']),direction:r['收支类型']==='收入'?'income':'expense',amountFen:statementMoney(r['收支金额(元)']),
        balanceFen:statementMoney(r['账户结余(元)'],true),voucherId:text(r['业务凭证号'])};
      key=entry.flowId;
      if(entry.direction==='income'){totals.incomeCount++;totals.incomeFen=safe(totals.incomeFen+entry.amountFen);}
      else{totals.expenseCount++;totals.expenseFen=safe(totals.expenseFen+entry.amountFen);}
    }
    if(seen.has(key))return invalid();seen.add(key);entries.push(entry);totals.count++;
  }
  if(input.kind==='trade'){
    if(integer(summary['总交易单数'])!==totals.count)return invalid();
    for(const [field,name] of [['应结订单总金额','settlementFen'],['退款总金额','refundSettlementFen'],['充值券退款总金额','refundCouponFen'],['手续费总金额','feeFen'],['订单总金额','nominalFen'],['申请退款总金额','refundRequestedFen']] as const)
      if(statementMoney(summary[field],name==='feeFen')!==totals[name])return invalid();
  }else if(integer(summary['资金流水总笔数'])!==totals.count||integer(summary['收入笔数'])!==totals.incomeCount||integer(summary['支出笔数'])!==totals.expenseCount
    ||statementMoney(summary['收入金额'])!==totals.incomeFen||statementMoney(summary['支出金额'])!==totals.expenseFen)return invalid();
  return {provider:'wechat',merchantId:input.merchantId,appId:input.appId,billDate:input.billDate,kind:input.kind,accountType:input.kind==='funds'?(input.accountType??'BASIC'):null,
    availability:'available',sha1:input.sha1,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.byteLength,verifiedAt:input.verifiedAt,entries,totals};
}
