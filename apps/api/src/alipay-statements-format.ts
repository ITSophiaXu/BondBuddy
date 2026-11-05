/** Supported, deliberately bounded subset of Alipay's configurable Chinese
 * trade CSV. Sources and unsupported configurations are recorded in
 * evidence/subscription-billing-20261029/ALIPAY-TRADE-FIELDS-20261030.md.
 * These are merchant receipts, never proof of buyer cash or a row APPID. */
export type AlipayStatementSourceAmounts={amountFen:string;merchantReceivedFen:string|null;merchantDiscountFen:string|null;feeFen:string|null};
export type AlipayStatementEntry={
  kind:'payment'|'refund';line:number;orderId:string;transactionId:string;refundId:string|null;
  /** Document-local completion time. No timezone is supplied by this parser. */
  completedLocalTime:string;
  /** Nonnegative magnitudes; kind supplies payment/refund direction. */
  amountFen:string;merchantReceivedFen:string|null;merchantDiscountFen:string|null;feeFen:string|null;
  /** Signed numeric values as present in the source, before magnitude normalization. */
  sourceAmounts:AlipayStatementSourceAmounts;
};
export type AlipayStatementFinancialTotals={count:number;amountFen:string;merchantReceivedFen:string|null;merchantDiscountFen:string|null;feeFen:string|null};
/** count/merchantReceived/merchantDiscount are checked against detail footers
 * when the corresponding columns are present. amount/fee are derived row sums,
 * not claimed as independently supplied footer totals. */
export type AlipayStatementTotals={payment:AlipayStatementFinancialTotals;refund:AlipayStatementFinancialTotals};
export type NormalizedAlipayStatement={normalization:{status:'normalized';format:'alipay-trade-cn-v1'};entries:AlipayStatementEntry[];totals:AlipayStatementTotals};
export type AlipayStatementNormalization=NormalizedAlipayStatement|{
  normalization:{status:'unresolved';reasons:['ALIPAY_CSV_FORMAT_UNVERIFIED']};entries:[];totals:null;
};
const maximum=9223372036854775807n,maxRows=20000,maxRecordLength=32768,maxColumns=64;
const fields=['amountFen','merchantReceivedFen','merchantDiscountFen','feeFen'] as const;
type MoneyField=typeof fields[number];
const optionalFields=['merchantReceivedFen','merchantDiscountFen','feeFen'] as const;
class UnsupportedFormat extends Error{}
const invalid=():never=>{throw new UnsupportedFormat();};
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const canonical=(value:unknown,signed=false):value is string=>typeof value==='string'&&(signed?/^(?:0|-?[1-9]\d{0,18})$/:/^(?:0|[1-9]\d{0,18})$/).test(value)&&BigInt(value)>=-maximum&&BigInt(value)<=maximum;
const magnitude=(value:string)=>{const n=BigInt(value);return (n<0n?-n:n).toString();};
const checkedSum=(values:readonly string[])=>{const value=values.reduce((sum,item)=>sum+BigInt(item),0n);if(value>maximum||value< -maximum)return invalid();return value.toString();};
function money(value:string):string{
  if(!/^[+-]?\d{1,17}(?:\.\d{1,2})?$/.test(value))return invalid();
  const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^[+-]/,'').split('.');
  const amount=(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')))*(negative?-1n:1n);
  if(amount>maximum||amount< -maximum)return invalid();return amount.toString();
}
function validDay(value:string){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const timestamp=Date.parse(value+'T00:00:00Z');return Number.isFinite(timestamp)&&new Date(timestamp).toISOString().slice(0,10)===value;
}
const localTime=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)&&validDay(value.slice(0,10));
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
function consistentAmounts(entry:AlipayStatementEntry){
  const source=entry.sourceAmounts,principal=BigInt(source.amountFen);
  if(principal===0n||entry.kind==='payment'&&principal<0n)return false;
  for(const field of ['merchantReceivedFen','merchantDiscountFen'] as const){
    const amount=source[field];if(amount===null)continue;const n=BigInt(amount);
    if(n!==0n&&(n<0n)!==(principal<0n)||BigInt(magnitude(amount))>BigInt(entry.amountFen))return false;
  }
  return source.merchantReceivedFen===null||source.merchantDiscountFen===null
    ||principal===BigInt(source.merchantReceivedFen)+BigInt(source.merchantDiscountFen);
}
function aggregate(entries:AlipayStatementEntry[],available?:Set<MoneyField>):AlipayStatementTotals{
  const part=(kind:'payment'|'refund'):AlipayStatementFinancialTotals=>{
    const rows=entries.filter(entry=>entry.kind===kind),sum=(field:MoneyField)=>checkedSum(rows.map(row=>row[field]!));
    const result:AlipayStatementFinancialTotals={count:rows.length,amountFen:sum('amountFen'),merchantReceivedFen:null,merchantDiscountFen:null,feeFen:null};
    for(const field of optionalFields){
      // On an empty group, column availability must come from the parsed
      // header (or the caller's already supplied null/zero total).
      if(rows.every(row=>row[field]!==null)&&(rows.length>0||available?.has(field)))result[field]=sum(field);
    }
    return result;
  };
  return {payment:part('payment'),refund:part('refund')};
}

/** Revalidate persisted/internal normalized evidence without reparsing CSV.
 * This is structural validation, not a substitute for authenticated download. */
export function validateNormalizedAlipayStatement(value:unknown):value is NormalizedAlipayStatement{
  try{
    if(!record(value)||!record(value.normalization)||value.normalization.status!=='normalized'||value.normalization.format!=='alipay-trade-cn-v1'
      ||!Array.isArray(value.entries)||value.entries.length>maxRows||!record(value.totals))return false;
    if(value.billDate!==undefined&&(typeof value.billDate!=='string'||!validDay(value.billDate)))return false;
    const rows:AlipayStatementEntry[]=[],lines=new Set<number>(),events=new Set<string>(),orders=new Map<string,string>(),transactions=new Map<string,string>();
    for(const raw of value.entries){
      if(!record(raw)||!['payment','refund'].includes(String(raw.kind))||!Number.isInteger(raw.line)||Number(raw.line)<1||Number(raw.line)>maxRows
        ||!id(raw.orderId)||!id(raw.transactionId)||!localTime(raw.completedLocalTime)
        ||value.billDate!==undefined&&raw.completedLocalTime.slice(0,10)!==value.billDate
        ||(raw.kind==='refund'?!id(raw.refundId):raw.refundId!==null)||!record(raw.sourceAmounts))return false;
      for(const field of fields){
        if(field!=='amountFen'&&raw[field]===null&&raw.sourceAmounts[field]===null)continue;
        if(!canonical(raw[field])||!canonical(raw.sourceAmounts[field],true)||raw[field]!==magnitude(raw.sourceAmounts[field]))return false;
      }
      const entry=raw as unknown as AlipayStatementEntry,key=JSON.stringify([entry.kind,entry.transactionId,entry.refundId]);
      if(!consistentAmounts(entry)||lines.has(entry.line)||events.has(key)||orders.has(entry.transactionId)&&orders.get(entry.transactionId)!==entry.orderId
        ||transactions.has(entry.orderId)&&transactions.get(entry.orderId)!==entry.transactionId)return false;
      lines.add(entry.line);events.add(key);orders.set(entry.transactionId,entry.orderId);transactions.set(entry.orderId,entry.transactionId);rows.push(entry);
    }
    for(const kind of ['payment','refund'] as const){
      const expected=value.totals[kind];if(!record(expected)||!Number.isInteger(expected.count)||Number(expected.count)<0||Number(expected.count)>maxRows)return false;
      const available=new Set<MoneyField>();
      for(const field of fields){if(field!=='amountFen'&&expected[field]===null)continue;if(!canonical(expected[field]))return false;available.add(field);}
      const actual=aggregate(rows,available)[kind];if(expected.count!==actual.count||fields.some(field=>expected[field]!==actual[field]))return false;
    }
    return true;
  }catch{return false;}
}

type CsvRow={line:number;cells:string[]};
/** RFC4180 quoting, parsed in one pass with per-record and per-column limits;
 * no unbounded split() on untrusted newlines. The ZIP layer also bounds bytes,
 * physical lines and expansion before this transient parser is reached. */
function* csv(content:string):Generator<CsvRow>{
  if(content.length===0||content.length>10*1024*1024||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]/.test(content))return invalid();
  let cell='',cells:string[]=[],state:'plain'|'quoted'|'closed'='plain',line=1,start=1,length=0,records=0;
  const push=()=>{cells.push(cell.trim());cell='';state='plain';if(cells.length>maxColumns)return invalid();};
  for(let at=content.charCodeAt(0)===0xfeff?1:0;at<content.length;at++){
    const ch=content[at];if(++length>maxRecordLength)return invalid();
    if(ch==='\r'&&content[at+1]!=='\n')return invalid();
    if(ch==='\r'||ch==='\n'){
      if(ch==='\r')at++;
      line++;if(line>100002)return invalid();
      if(state==='quoted'){cell+='\n';continue;}
      push();if(++records>maxRows+64)return invalid();yield {line:start,cells};cells=[];length=0;start=line;continue;
    }
    if(state==='quoted'){
      if(ch==='"'){if(content[at+1]==='"'){cell+='"';at++;length++;}else state='closed';}else cell+=ch;
      continue;
    }
    if(ch===','){push();continue;}
    if(state==='closed')return invalid();
    if(ch==='"'){if(cell!=='')return invalid();state='quoted';}else cell+=ch;
  }
  if(state==='quoted')return invalid();
  if(cell!==''||cells.length||state==='closed'){push();if(++records>maxRows+64)return invalid();yield {line:start,cells};}
}
const unpadded=(cells:string[])=>{const result=[...cells];while(result.length>1&&result.at(-1)==='')result.pop();return result;};
const label=(value:string)=>value.replace(/(?:（元）|\(元\))$/,'');
const aliases:Record<string,string>={'商户订单号':'商家订单号','退款批次号/请求号':'退款批次号'};
function headers(cells:string[]):string[]{
  const result=unpadded(cells).map(value=>aliases[label(value)]??label(value));
  if(result.some(value=>!value||/[\r\n]/.test(value))||new Set(result).size!==result.length)return invalid();return result;
}
function values(header:string[],cells:string[]){
  if(cells.length===header.length+1&&cells.at(-1)==='')cells=cells.slice(0,-1);
  if(cells.length!==header.length)return invalid();return Object.fromEntries(header.map((key,index)=>[key,cells[index]]));
}
const blank=(row:CsvRow)=>row.cells.every(cell=>cell==='');
const joined=(row:CsvRow)=>unpadded(row.cells).join(',');
function metadata(value:string,billDate:string):boolean{
  if(/^#账号[:：][^\r\n]{1,128}$/.exec(value)!==null)return true;
  const dates=/^#起始日期[:：]\s*\[(\d{4})年(\d{2})月(\d{2})日 00:00:00\]\s*终止日期[:：]\s*\[(\d{4})年(\d{2})月(\d{2})日 00:00:00\]$/.exec(value);
  if(dates){const begin=dates.slice(1,4).join('-'),end=dates.slice(4,7).join('-');
    return begin===billDate&&validDay(end)&&Date.parse(end+'T00:00:00Z')-Date.parse(begin+'T00:00:00Z')===86400000;}
  return false;
}
function exported(value:string):boolean{
  const match=/^#导出时间[:：]\s*\[(\d{4})年(\d{2})月(\d{2})日 ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)\]$/.exec(value);
  return match!==null&&localTime(match.slice(1,4).join('-')+' '+match[4]);
}
type Footer={count:number;merchantReceivedFen:string;merchantDiscountFen:string};
function footer(value:string,kind:'payment'|'refund'):Footer{
  const regex=kind==='payment'
    ?/^#交易合计[:：]\s*(\d{1,5})笔[,，]\s*商家实收共([+-]?\d{1,17}(?:\.\d{1,2})?)元[,，]\s*商家优惠共([+-]?\d{1,17}(?:\.\d{1,2})?)元$/
    :/^#退款合计[:：]\s*(\d{1,5})笔[,，]\s*商家实收退款共([+-]?\d{1,17}(?:\.\d{1,2})?)元[,，]\s*商家优惠退款共([+-]?\d{1,17}(?:\.\d{1,2})?)元$/;
  const match=regex.exec(value);if(!match||Number(match[1])>maxRows)return invalid();
  const received=money(match[2]),discount=money(match[3]);
  if(kind==='payment'&&(BigInt(received)<0n||BigInt(discount)<0n)
    ||BigInt(received)!==0n&&BigInt(discount)!==0n&&(BigInt(received)<0n)!==(BigInt(discount)<0n))return invalid();
  return {count:Number(match[1]),merchantReceivedFen:magnitude(received),merchantDiscountFen:magnitude(discount)};
}
function parseDetail(content:string,billDate:string):NormalizedAlipayStatement{
  let header:string[]|undefined,ended=false,exportSeen=false,payment:Footer|undefined,refund:Footer|undefined;
  const entries:AlipayStatementEntry[]=[],available=new Set<MoneyField>(),preamble=new Set<string>();
  for(const row of csv(content)){
    if(blank(row))continue;const text=joined(row);
    if(!header){
      if(text==='#支付宝业务明细查询'||/^#-+业务明细列表-*$/.test(text)||metadata(text,billDate)){
        const key=text.split(/[:：]/,1)[0];if(preamble.has(key)||preamble.size>=4)return invalid();preamble.add(key);continue;
      }
      header=headers(row.cells);
      if(!['支付宝交易号','商家订单号','业务类型','完成时间','订单金额'].every(key=>header!.includes(key)))return invalid();
      for(const [key,field] of [['商家实收','merchantReceivedFen'],['商家优惠','merchantDiscountFen'],['服务费','feeFen']] as const)if(header.includes(key))available.add(field);
      continue;
    }
    if(/^#-+业务明细列表结束-*$/.test(text)){if(ended||payment||refund)return invalid();ended=true;continue;}
    if(text.startsWith('#交易合计')){if(payment||refund||exportSeen)return invalid();payment=footer(text,'payment');ended=true;continue;}
    if(text.startsWith('#退款合计')){if(!payment||refund||exportSeen)return invalid();refund=footer(text,'refund');continue;}
    if(exported(text)){if(!refund||exportSeen)return invalid();exportSeen=true;continue;}
    if(ended||payment||refund||exportSeen||text.startsWith('#')||entries.length>=maxRows||row.line>maxRows)return invalid();
    const data=values(header,row.cells),kind=data['业务类型']==='交易'?'payment':data['业务类型']==='退款'?'refund':invalid();
    const optional=(key:string)=>header!.includes(key)&&data[key]!==''?money(data[key]):null;
    const sourceAmounts:AlipayStatementSourceAmounts={amountFen:money(data['订单金额']),merchantReceivedFen:optional('商家实收'),merchantDiscountFen:optional('商家优惠'),feeFen:optional('服务费')};
    const normalized=(field:MoneyField)=>sourceAmounts[field]===null?null:magnitude(sourceAmounts[field]!);
    entries.push({kind,line:row.line,orderId:data['商家订单号'],transactionId:data['支付宝交易号'],refundId:data['退款批次号']||null,
      completedLocalTime:data['完成时间'],amountFen:normalized('amountFen')!,merchantReceivedFen:normalized('merchantReceivedFen'),
      merchantDiscountFen:normalized('merchantDiscountFen'),feeFen:normalized('feeFen'),sourceAmounts});
  }
  if(!header||!payment||!refund)return invalid();
  const result:NormalizedAlipayStatement={normalization:{status:'normalized',format:'alipay-trade-cn-v1'},entries,totals:aggregate(entries,available)};
  if(!validateNormalizedAlipayStatement({...result,billDate}))return invalid();
  for(const [kind,expected] of [['payment',payment],['refund',refund]] as const){
    const actual=result.totals[kind];if(actual.count!==expected.count)return invalid();
    for(const field of ['merchantReceivedFen','merchantDiscountFen'] as const)if(actual[field]!==null&&actual[field]!==expected[field])return invalid();
    if(actual.count===0&&(expected.merchantReceivedFen!=='0'||expected.merchantDiscountFen!=='0'))return invalid();
  }
  return result;
}

/** Optional business summary subset: exact named columns, internally summed
 * store rows and a total row, then checked against a payment-only detail bill.
 * Refund/netting configurations remain unresolved until their layout and net
 * conventions are evidenced; no speculative sign conversion is performed. */
function checkSummary(content:string,billDate:string,detail:NormalizedAlipayStatement){
  if(detail.totals.refund.count!==0)return invalid();
  const countNames=['交易订单总数','退款订单总数'],moneyNames=['订单金额','商家实收','支付宝优惠','商家优惠','卡消费金额','服务费','分润','实收净额'];
  let header:string[]|undefined,total:Record<string,string>|undefined,ended=false,exportSeen=false;
  const stores=new Set<string>(),sums=new Map<string,bigint>(),preamble=new Set<string>();
  for(const row of csv(content)){
    if(blank(row))continue;const text=joined(row);
    if(!header){
      if(text==='#支付宝业务汇总查询'||/^#-+业务汇总列表-*$/.test(text)||metadata(text,billDate)){
        const key=text.split(/[:：]/,1)[0];if(preamble.has(key)||preamble.size>=4)return invalid();preamble.add(key);continue;
      }
      header=headers(row.cells);
      if(!['门店编号','门店名称',...countNames,'订单金额','商家实收','商家优惠'].every(key=>header!.includes(key))
        ||header.some(key=>!['门店编号','门店名称',...countNames,...moneyNames].includes(key)))return invalid();
      for(const key of header)if(countNames.includes(key)||moneyNames.includes(key))sums.set(key,0n);continue;
    }
    if(/^#-+业务汇总列表结束-*$/.test(text)){if(!total||ended)return invalid();ended=true;continue;}
    if(exported(text)){if(!total||exportSeen)return invalid();exportSeen=true;ended=true;continue;}
    if(ended||total||text.startsWith('#'))return invalid();
    const data=values(header,row.cells),isTotal=data['门店编号']==='合计';
    if(!isTotal){if(!data['门店编号']||data['门店编号'].length>128||stores.has(data['门店编号']))return invalid();stores.add(data['门店编号']);}
    else if(data['门店名称']!=='')return invalid();
    for(const key of sums.keys()){
      const amount=countNames.includes(key)?(/^\d{1,5}$/.test(data[key])&&Number(data[key])<=maxRows?String(Number(data[key])):invalid()):money(data[key]);
      data[key]=amount;if(isTotal){if(BigInt(amount)!==sums.get(key))return invalid();}
      else{const sum=sums.get(key)!+BigInt(amount);if(sum>maximum||sum< -maximum)return invalid();sums.set(key,sum);}
    }
    if(isTotal)total=data;
  }
  if(!header||!total||Number(total['交易订单总数'])!==detail.totals.payment.count||total['退款订单总数']!=='0')return invalid();
  for(const [key,field] of [['订单金额','amountFen'],['商家实收','merchantReceivedFen'],['商家优惠','merchantDiscountFen'],['服务费','feeFen']] as const){
    if(!header.includes(key)||detail.totals.payment[field]===null)continue;
    const signed=checkedSum(detail.entries.map(entry=>entry.sourceAmounts[field]!));if(total[key]!==signed)return invalid();
  }
}

/** All-or-nothing normalization: unknown members, incomplete totals, ambiguity
 * or a single bad row preserve the original unresolved state and zero entries. */
export function normalizeAlipayStatementDocuments(documents:readonly {text:string}[],billDate:string):AlipayStatementNormalization{
  try{
    if(!validDay(billDate)||documents.length<1||documents.length>2)return invalid();
    const detailCandidates=documents.filter(document=>{
      for(const row of csv(document.text)){if(row.cells.some(cell=>label(cell)==='支付宝交易号'))return true;}return false;
    });
    if(detailCandidates.length!==1)return invalid();
    const result=parseDetail(detailCandidates[0].text,billDate);
    for(const document of documents)if(document!==detailCandidates[0])checkSummary(document.text,billDate,result);
    return result;
  }catch{
    return {normalization:{status:'unresolved',reasons:['ALIPAY_CSV_FORMAT_UNVERIFIED']},entries:[],totals:null};
  }
}
