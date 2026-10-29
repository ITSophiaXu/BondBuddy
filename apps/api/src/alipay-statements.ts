import {createHash} from 'node:crypto';
import {inspectAlipayStatementArchive,ALIPAY_STATEMENT_ARCHIVE_LIMIT} from './alipay-statements-archive.js';

/** No CSV row is normalized until an authoritative format is verified. */
export type AlipayStatementEntry=never;
export type AlipayStatementDocument={nameSha256:string;sha256:string;byteLength:number;encoding:'utf-8'|'gbk';lineCount:number};
export type VerifiedAlipayStatement={
  provider:'alipay';merchantId:string;requestAppId:string;billDate:string;kind:'trade';accountType:null;
  availability:'available';sha1:null;sha256:string;byteLength:number;verifiedAt:string;
  evidence:{kind:'alipay_rsa2_download_url';signedResponseSha256:string;downloadSha256:string;
    signedUrlMerchantId:string;requestedBillDate:string;requestBillType:'trade'};
  normalization:{status:'unresolved';reasons:['ALIPAY_CSV_FORMAT_UNVERIFIED']};
  documents:AlipayStatementDocument[];entries:AlipayStatementEntry[];totals:null;
};

export type AlipayStatementRequest={billDate:string;kind:'trade'|'funds';accountType?:string};
export type AlipayStatementMetadata={data:Record<string,unknown>;signedResponseSha256:string;verifiedAt:string};
export class AlipayStatementError extends Error{
  constructor(readonly code:string){super('Alipay statement '+code);this.name='AlipayStatementError';}
}
const fail=(code:string):never=>{throw new AlipayStatementError(code);};
const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');

export const ALIPAY_STATEMENT_DOWNLOAD_ORIGIN='https://dwbillcenter.alipay.com';
export const ALIPAY_STATEMENT_DOWNLOAD_PATH='/downloadBillFile.resource';
type DownloaderOptions={merchantId:string;appId:string;timeoutMs:number;now:()=>number;fetch:typeof fetch;
  query:(billDate:string)=>Promise<AlipayStatementMetadata>};

function requestedDay(value:string,now:number){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return fail('REQUEST_INVALID');
  const parsed=Date.parse(value+'T00:00:00Z');
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==value
    ||value>=new Date(now+8*3600000).toISOString().slice(0,10))return fail('REQUEST_INVALID');
}

/** The URL itself is covered by the already verified RSA2 response. Its PID
 * must independently agree with the configured direct merchant. The URL and
 * download token are never persisted or included in errors. */
function checkedDownloadUrl(raw:unknown,merchantId:string):URL{
  if(typeof raw!=='string'||raw.length>4096||/[\x00-\x20\x7f\\]/.test(raw))return fail('DOWNLOAD_URL_INVALID');
  let url:URL;try{url=new URL(raw);}catch{return fail('DOWNLOAD_URL_INVALID');}
  if(url.origin!==ALIPAY_STATEMENT_DOWNLOAD_ORIGIN||url.pathname!==ALIPAY_STATEMENT_DOWNLOAD_PATH||url.username||url.password||url.hash
    ||!raw.startsWith(ALIPAY_STATEMENT_DOWNLOAD_ORIGIN+ALIPAY_STATEMENT_DOWNLOAD_PATH+'?'))return fail('DOWNLOAD_URL_INVALID');
  const seen=new Set<string>();
  for(const [key,value] of url.searchParams){if(!key||seen.has(key)||value.length>2048||/[\x00-\x1f\x7f]/.test(key+value))return fail('DOWNLOAD_URL_INVALID');seen.add(key);}
  if(url.searchParams.get('pid')!==merchantId)return fail('MERCHANT_IDENTITY_UNVERIFIED');
  return url;
}

async function downloadArchive(url:URL,options:DownloaderOptions):Promise<Uint8Array>{
  const controller=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;
  const resources:{body:ReadableStream<Uint8Array>|null}={body:null};
  try{return await Promise.race([(async()=>{
    const response=await options.fetch(url.href,{method:'GET',headers:{accept:'application/zip,application/octet-stream'},redirect:'error',signal:controller.signal});
    resources.body=response.body;
    if(controller.signal.aborted){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>{});return fail('DOWNLOAD_TIMEOUT');}
    if(response.status!==200||response.redirected||response.url&&response.url!==url.href)return fail('DOWNLOAD_HTTP_INVALID');
    const contentEncoding=response.headers.get('content-encoding');
    if(contentEncoding&&contentEncoding.toLowerCase()!=='identity')return fail('DOWNLOAD_ENCODING_INVALID');
    const contentType=(response.headers.get('content-type')??'').split(';',1)[0].trim().toLowerCase();
    if(!['application/zip','application/x-zip-compressed','application/octet-stream'].includes(contentType))return fail('DOWNLOAD_HTTP_INVALID');
    const length=response.headers.get('content-length');
    if(length!==null&&(!/^\d{1,9}$/.test(length)||Number(length)>ALIPAY_STATEMENT_ARCHIVE_LIMIT))return fail('DOWNLOAD_TOO_LARGE');
    if(!response.body)return fail('DOWNLOAD_EMPTY');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
    try{
      while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;
        if(size>ALIPAY_STATEMENT_ARCHIVE_LIMIT){cancel();return fail('DOWNLOAD_TOO_LARGE');}chunks.push(item.value);}
    }finally{controller.signal.removeEventListener('abort',cancel);reader.releaseLock();}
    if(size===0||length!==null&&Number(length)!==size)return fail('DOWNLOAD_LENGTH_INVALID');
    return Buffer.concat(chunks,size);
  })(),new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(new AlipayStatementError('DOWNLOAD_TIMEOUT'));},options.timeoutMs);})]);}
  catch(error){if(error instanceof AlipayStatementError)throw error;return fail('DOWNLOAD_NETWORK_INVALID');}
  finally{controller.abort();if(resources.body&&!resources.body.locked)void resources.body.cancel().catch(()=>{});if(timeout)clearTimeout(timeout);}
}

/** Evidence intake, not completed reconciliation. Current public sources prove
 * the signed URL protocol, but not a CSV column contract. Unknown rows cannot
 * become invented payments/refunds, zero totals, or a successful coverage claim. */
export function createAlipayStatementDownloader(options:DownloaderOptions){
  if(!/^2088\d{12}$/.test(options.merchantId)||!/^20\d{14}$/.test(options.appId)
    ||!Number.isInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>30000)return fail('CONFIG_INVALID');
  return async(input:AlipayStatementRequest):Promise<VerifiedAlipayStatement>=>{
    if(input.kind!=='trade'||input.accountType!==undefined)return fail('REQUEST_UNSUPPORTED');
    requestedDay(input.billDate,options.now());
    const metadata=await options.query(input.billDate),verifiedAt=Date.parse(metadata.verifiedAt);
    if(!/^[a-f0-9]{64}$/.test(metadata.signedResponseSha256)||!Number.isFinite(verifiedAt)
      ||verifiedAt>options.now()||options.now()-verifiedAt>=30000)return fail('METADATA_UNVERIFIED');
    if(metadata.data.code!=='10000')return fail('STATEMENT_UNRESOLVED');
    if(metadata.data.bill_file_code!==undefined&&metadata.data.bill_file_code!=='EMPTY_DATA_WITH_BILL_FILE')return fail('METADATA_UNSUPPORTED');
    const url=checkedDownloadUrl(metadata.data.bill_download_url,options.merchantId);
    const bytes=await downloadArchive(url,options),documents=inspectAlipayStatementArchive(bytes),digest=sha256(bytes);
    return {provider:'alipay',merchantId:options.merchantId,requestAppId:options.appId,billDate:input.billDate,kind:'trade',accountType:null,
      availability:'available',sha1:null,sha256:digest,byteLength:bytes.byteLength,verifiedAt:metadata.verifiedAt,
      evidence:{kind:'alipay_rsa2_download_url',signedResponseSha256:metadata.signedResponseSha256,downloadSha256:digest,
        signedUrlMerchantId:options.merchantId,requestedBillDate:input.billDate,requestBillType:'trade'},
      normalization:{status:'unresolved',reasons:['ALIPAY_CSV_FORMAT_UNVERIFIED']},documents,entries:[],totals:null};
  };
}
