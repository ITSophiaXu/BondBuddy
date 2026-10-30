import {deflateRawSync} from 'node:zlib';
import {syntheticAlipayFixture} from './test-alipay-pay-fixtures.js';

/** Invented documents and generated keys. These are ZIP/transport fixtures,
 * never examples of an officially verified Alipay CSV business format. */
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
