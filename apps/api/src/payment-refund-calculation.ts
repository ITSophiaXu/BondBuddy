/** Cash and credit quantities are different units. Keep the original A/Q basis
 * and the successful R/F cursor; consuming the last available credits does not
 * entitle a customer to the cash consideration of already consumed credits. */
export function cumulativeRefundFen(originalFen:number,originalPoints:number,refundedPoints:number,refundedFen:number,points:number):number{
  if(![originalFen,originalPoints,refundedPoints,refundedFen,points].every(Number.isSafeInteger)||
    originalFen<1||originalPoints<1||refundedPoints<0||refundedFen<0||points<0)throw new RangeError('Invalid original refund basis or cursor');
  const a=BigInt(originalFen),q=BigInt(originalPoints),r=BigInt(refundedPoints),f=BigInt(refundedFen),next=r+BigInt(points);
  if(next>q||f!==a*r/q)throw new RangeError('Refund cursor does not match original consideration');
  return Number(a*next/q-f);
}
