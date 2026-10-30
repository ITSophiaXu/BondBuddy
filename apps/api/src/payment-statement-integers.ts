/** Ledger values stay exact through comparison and JSON-to-bigint persistence. */
export function statementInteger(value:unknown):bigint {
  if(typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('Statement integer is not exact');
  if(typeof value!=='number'&&typeof value!=='bigint'&&(typeof value!=='string'||! /^(?:0|-?[1-9]\d*)$/.test(value)))
    throw new Error('Statement integer is invalid');
  const parsed=BigInt(value as string|number|bigint);
  if(parsed<-(1n<<63n)||parsed>(1n<<63n)-1n)throw new Error('Statement integer exceeds int64');
  return parsed;
}
export function statementAbsolute(value:unknown):bigint {
  const parsed=statementInteger(value);
  return statementInteger(parsed<0n?-parsed:parsed);
}
