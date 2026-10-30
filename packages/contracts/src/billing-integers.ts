import {Type} from '@sinclair/typebox';

/** Signed database int64 storage, restricted to nonnegative billing quantities. */
export const BILLING_INT64_MAX=9223372036854775807n;
export type Int64String=string;
const integerText=/^(0|[1-9][0-9]*)$/;

// The JSON schema itself rejects overflow; it does not rely on lossy JSON
// numeric bounds or an optional custom AJV format being installed.
function int64Pattern(positive=false):string{
  const limit=BILLING_INT64_MAX.toString(),alternatives=[...(positive?[]:['0']),`[1-9][0-9]{0,${limit.length-2}}`];
  for(let i=0;i<limit.length;i++){
    const lowest=i===0?1:0,highest=Number(limit[i])-1;
    if(highest<lowest)continue;
    const digit=lowest===highest?String(lowest):`[${lowest}-${highest}]`,remaining=limit.length-i-1;
    alternatives.push(limit.slice(0,i)+digit+(remaining?`[0-9]{${remaining}}`:''));
  }
  alternatives.push(limit);return '^(?:'+alternatives.join('|')+')$';
}
export const Int64Schema=Type.String({pattern:int64Pattern(),maxLength:19,$comment:'nonnegative int64 decimal string',
  description:'Canonical nonnegative int64 decimal string. JSON numbers, signs, fractions, exponents and overflow are invalid.'});
export const PositiveInt64Schema=Type.String({pattern:int64Pattern(true),maxLength:19,$comment:'positive int64 decimal string'});

/** Strict public-wire parser. Call before coercing schema validation. */
export function parseInt64(value:unknown):bigint{
  if(typeof value!=='string'||value.length>19||!integerText.test(value))throw new RangeError('Billing quantity must be canonical int64 decimal text');
  const amount=BigInt(value);if(amount>BILLING_INT64_MAX)throw new RangeError('Billing int64 overflow');return amount;
}

/** Domain/DB/config adapter; numeric inputs must already be exactly representable. */
export function int64(value:unknown):bigint{
  if(typeof value==='bigint'){
    if(value<0n||value>BILLING_INT64_MAX)throw new RangeError('Billing int64 out of range');return value;
  }
  if(typeof value==='number'){
    if(!Number.isSafeInteger(value)||value<0)throw new RangeError('Imprecise billing number');
    return BigInt(value);
  }
  return parseInt64(value);
}
export const serializeInt64=(value:unknown):Int64String=>int64(value).toString();
export function safeBillingNumber(value:unknown,maximum=Number.MAX_SAFE_INTEGER):number{
  if(!Number.isSafeInteger(maximum)||maximum<0)throw new RangeError('Invalid numeric compatibility bound');
  const amount=int64(value);if(amount>BigInt(maximum))throw new RangeError('Billing quantity cannot be narrowed exactly');
  return Number(amount);
}
export const addInt64=(a:unknown,b:unknown):bigint=>int64(int64(a)+int64(b));
export const subtractInt64=(a:unknown,b:unknown):bigint=>int64(int64(a)-int64(b));
export const minInt64=(a:unknown,b:unknown):bigint=>{const x=int64(a),y=int64(b);return x<y?x:y;};
export const shortageInt64=(required:unknown,available:unknown):bigint=>{const r=int64(required),a=int64(available);return r>a?r-a:0n;};
export const formatPoints=(value:unknown):string=>int64(value).toLocaleString('zh-CN');
export function formatFen(value:unknown,currencySymbol='¥'):string{
  const fen=int64(value);return currencySymbol+(fen/100n).toLocaleString('zh-CN')+'.'+(fen%100n).toString().padStart(2,'0');
}
export function parseYuanToFen(value:unknown):Int64String{
  if(typeof value!=='string'||value.length>22||!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(value))throw new RangeError('Expected CNY decimal text with at most two fractional digits');
  const [whole,fraction='']=value.split('.');return serializeInt64(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')));
}
