import {sha256,requireThat} from './policy.mjs';

// Four immutable publications per completed cloud operation. Expiry never
// authorizes replaying StartInstances or an unconfirmed PutSecretValue.
export const ENROLLMENT_RECOVERY_GENERATIONS=3;
export function enrollmentVersionId(operationId,generation=0) {
  requireThat(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(operationId??'') &&
    Number.isInteger(generation)&&generation>=0&&generation<=ENROLLMENT_RECOVERY_GENERATIONS,'ENROLLMENT_GENERATION');
  return generation===0?operationId:`enr-${sha256(operationId).slice(0,40)}-${generation}`;
}

export function enrollmentVersionMatches(envelope,versionId) {
  try {return enrollmentVersionId(envelope.operation_id,envelope.enrollment_generation??0)===versionId;}
  catch {return false;}
}
