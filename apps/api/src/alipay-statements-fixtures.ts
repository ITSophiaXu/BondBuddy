import {deflateRawSync} from 'node:zlib';
import {syntheticAlipayFixture} from './test-alipay-pay-fixtures.js';

/** Invented documents and generated keys. These are synthetic test fixtures,
 * never merchant samples or proof of provider integration. */
type ZipFile={name?:string;bytes?:Uint8Array;method?:number;flags?:number;descriptor?:boolean;attributes?:number;madeBy?:number};
function crc(bytes:Uint8Array){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;}return (value^0xffffffff)>>>0;}
export const syntheticCsv=()=>Buffer.from('\ufeff合成字段,未验证业务含义\r\nsynthetic_value,not_a_payment\r\n');
export function syntheticStatementZip(files:ZipFile[]=[{}]){
  const locals:Buffer[]=[],centrals:Buffer[]=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name??'synthetic-unverified.csv'),bytes=Buffer.from(file.bytes??syntheticCsv()),method=file.method??0;
    const flags=file.flags??(0x800|(file.descriptor?8:0)),compressed=method===8?deflateRawSync(bytes):bytes,sum=crc(bytes);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);
    if(!(flags&8)){local.writeUInt32LE(sum,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(bytes.length,22);}local.writeUInt16LE(name.length,26);
    const descriptor=flags&8?Buffer.alloc(16):Buffer.alloc(0);if(descriptor.length){descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(sum,4);descriptor.writeUInt32LE(compressed.length,8);descriptor.writeUInt32LE(bytes.length,12);}
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(file.madeBy??20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(flags,8);central.writeUInt16LE(method,10);
    central.writeUInt32LE(sum,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(file.attributes??0,38);central.writeUInt32LE(offset,42);
    locals.push(local,name,compressed,descriptor);centrals.push(central,name);offset+=local.length+name.length+compressed.length+descriptor.length;
  }
  const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
export function statementFixture(){
  const base=syntheticAlipayFixture(),method='alipay.data.dataservice.bill.downloadurl.query',billDate='2026-10-28',archive=syntheticStatementZip();
  const url=`https://dwbillcenter.alipay.com/downloadBillFile.resource?bizType=trade&pid=${base.options.merchantId}&bizDates=20261028&fileId=synthetic_download_token`;
  const data={code:'10000',msg:'Success',bill_download_url:url};
  const bytesResponse=(bytes:Uint8Array=archive,headers:Record<string,string>={})=>new Response(Buffer.from(bytes),{headers:{'content-type':'application/zip','content-length':String(bytes.byteLength),...headers}});
  return {...base,method,billDate,archive,url,data,bytesResponse};
}

/** Header/footer semantics follow the cited official text/images; values and
 * RFC4180 serialization are synthetic, not a captured provider CSV. */
export const syntheticTradeHeaders=['支付宝交易号','商家订单号','业务类型','商品名称','完成时间','订单金额（元）','商家实收（元）','商家优惠','服务费','退款批次号/请求号'];
export const syntheticTradeRows=()=>[
  ['2026102800000001','order_1','交易','synthetic product','2026-10-28 09:10:11','100.00','97.00','3.00','-0.60',''],
  ['2026102800000001','order_1','退款','synthetic product','2026-10-28 10:20:30','-20.00','-19.00','-1.00','0.12','refund_1'],
];
const csvCell=(value:string)=>/[",\r\n]/.test(value)?'"'+value.replaceAll('"','""')+'"':value;
export function syntheticTradeCsv(options:{headers?:string[];rows?:string[][];paymentFooter?:string;refundFooter?:string;preamble?:boolean}={}){
  const lines:string[]=[];
  if(options.preamble)lines.push('#支付宝业务明细查询','#账号: synthetic-account',
    '#起始日期: [2026年10月28日 00:00:00] 终止日期: [2026年10月29日 00:00:00]','#-----------业务明细列表-----------');
  lines.push((options.headers??syntheticTradeHeaders).map(csvCell).join(','),...(options.rows??syntheticTradeRows()).map(row=>row.map(csvCell).join(',')));
  if(options.preamble)lines.push('#-----------业务明细列表结束-----------');
  lines.push(options.paymentFooter??'#交易合计: 1笔, 商家实收共97.00元, 商家优惠共3.00元',
    options.refundFooter??'#退款合计: 1笔, 商家实收退款共19.00元, 商家优惠退款共1.00元');
  if(options.preamble)lines.push('#导出时间: [2026年10月29日 10:23:01]');
  return '\ufeff'+lines.join('\r\n')+'\r\n';
}
export function syntheticTradeSummaryCsv(){return '\ufeff'+[
  '#支付宝业务汇总查询','#账号: synthetic-account',
  '#起始日期: [2026年10月28日 00:00:00] 终止日期: [2026年10月29日 00:00:00]','#-----------业务汇总列表-----------',
  '门店编号,门店名称,交易订单总数,退款订单总数,订单金额,商家实收,支付宝优惠,商家优惠,卡消费金额,服务费（元）,分润（元）,实收净额（元）',
  'store_1,Synthetic store,1,0,100.00,97.00,0.00,3.00,0.00,-0.60,0.00,96.40',
  '合计,,1,0,100.00,97.00,0.00,3.00,0.00,-0.60,0.00,96.40',
  '#-----------业务汇总列表结束-----------','#导出时间: [2026年10月29日 10:23:01]',
].join('\r\n')+'\r\n';}
