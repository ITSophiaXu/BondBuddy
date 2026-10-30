/** Exact, report-local arithmetic. This is not the public billing wire contract. */
export type ExactRatio=Readonly<{numerator:bigint;denominator:bigint}>;
export type RatioJson={numerator:string;denominator:string};
export type IntegerInput=string|number;
const INT64_MAX=9223372036854775807n;
const abs=(n:bigint)=>n<0n?-n:n;
function gcd(a:bigint,b:bigint):bigint{while(b){const next=a%b;a=b;b=next;}return a;}
export function ratio(numerator:bigint,denominator=1n):ExactRatio{
  if(denominator===0n)throw new RangeError('Zero rational denominator');
  if(denominator<0n){numerator=-numerator;denominator=-denominator;}
  const divisor=gcd(abs(numerator),denominator);
  return {numerator:numerator/divisor,denominator:denominator/divisor};
}
export const ZERO=ratio(0n);
export const add=(a:ExactRatio,b:ExactRatio)=>ratio(a.numerator*b.denominator+b.numerator*a.denominator,a.denominator*b.denominator);
export const subtract=(a:ExactRatio,b:ExactRatio)=>ratio(a.numerator*b.denominator-b.numerator*a.denominator,a.denominator*b.denominator);
export const divide=(a:ExactRatio,b:ExactRatio)=>ratio(a.numerator*b.denominator,a.denominator*b.numerator);
export const ratioJson=(value:ExactRatio|null):RatioJson|null=>value===null?null:{numerator:value.numerator.toString(),denominator:value.denominator.toString()};

/** Bounded legacy integer inputs may be normalized, but never an imprecise JS number. */
export function unsignedInteger(value:unknown):bigint{
  if(typeof value==='number'){
    if(!Number.isSafeInteger(value)||value<0)throw new RangeError('Expected an exact nonnegative integer');
    value=String(value);
  }
  if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||value.length>19)throw new RangeError('Expected int64 decimal text');
  const parsed=BigInt(value);if(parsed>INT64_MAX)throw new RangeError('int64 overflow');return parsed;
}

/** PostgreSQL numeric text is finite decimal; no Number/parseFloat round trip is allowed. */
export function nonnegativeDecimal(value:unknown):ExactRatio{
  if(typeof value==='number'){
    if(!Number.isSafeInteger(value)||value<0)throw new RangeError('Fractional costs require decimal text');
    value=String(value);
  }
  if(typeof value!=='string'||value.length>4096||!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))throw new RangeError('Expected nonnegative finite decimal text');
  const [whole,fraction='']=value.split('.');return ratio(BigInt(whole+fraction),10n**BigInt(fraction.length));
}

/** Returns null for a repeating decimal; the rational remains authoritative. */
export function exactDecimal(value:ExactRatio):string|null{
  let denominator=value.denominator,twos=0,fives=0;
  while(denominator%2n===0n){denominator/=2n;twos++;}
  while(denominator%5n===0n){denominator/=5n;fives++;}
  if(denominator!==1n)return null;
  const scale=Math.max(twos,fives),scaled=abs(value.numerator)*2n**BigInt(scale-twos)*5n**BigInt(scale-fives);
  const digits=scaled.toString().padStart(scale+1,'0');
  const decimal=scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits;
  return (value.numerator<0n?'-':'')+decimal;
}

/** Display only: fixed decimal places, nearest with ties away from zero. */
export function roundedDecimal(value:ExactRatio|null,places:number):string|null{
  if(value===null)return null;
  if(!Number.isSafeInteger(places)||places<0||places>18)throw new RangeError('Invalid display precision');
  const scale=10n**BigInt(places),scaled=abs(value.numerator)*scale;
  const rounded=scaled/value.denominator+(scaled%value.denominator*2n>=value.denominator?1n:0n);
  const digits=rounded.toString().padStart(places+1,'0');
  return (value.numerator<0n&&rounded!==0n?'-':'')+(places?digits.slice(0,-places)+'.'+digits.slice(-places):digits);
}
