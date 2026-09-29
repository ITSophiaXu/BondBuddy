type TestGrantTarget = { granted_by: string; reason: string };
type Target = { market: 'sse'; offering: 'private'; document_purpose: 'registration'|'issuance';
  as_of: string; status: 'confirmed'|'pending_test_assumption' };

/** A service-pinned rule evaluation date/stage is only a test assumption. */
export function testWorkingDraftTarget(manifest: Record<string,unknown>,grant:TestGrantTarget,owner:string):Target|null {
  if(manifest.market!=='sse'||manifest.offering!=='private')return null;
  const value=manifest.target_confirmation;
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const target=value as Record<string,unknown>;
  if(target.status==='confirmed'&&target.confirmed_by===owner&&target.market==='sse'&&target.offering==='private'&&
      ['registration','issuance'].includes(String(target.document_purpose))&&typeof target.as_of==='string')
    return {market:'sse',offering:'private',document_purpose:target.document_purpose as Target['document_purpose'],
      as_of:target.as_of,status:'confirmed'};
  if(grant.granted_by!=='preprod_service'||target.status!=='unconfirmed')return null;
  const match=/^controlled_working_draft:(registration|issuance):(\d{4}-\d{2}-\d{2})$/.exec(grant.reason);
  if(!match||!Number.isFinite(Date.parse(`${match[2]}T00:00:00Z`))||
      new Date(`${match[2]}T00:00:00Z`).toISOString().slice(0,10)!==match[2])return null;
  return {market:'sse',offering:'private',document_purpose:match[1] as Target['document_purpose'],
    as_of:match[2],status:'pending_test_assumption'};
}
