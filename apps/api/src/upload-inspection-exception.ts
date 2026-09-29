import { M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES } from '@bondbuddy/contracts';

type Scope = { ownerUserId: string; projectId: string; role: 'audit'; byteSize: number; sha256: string };
type Candidate = { ownerUserId: string; projectId: string; role: string; byteSize: number; sha256: string; mediaType: string };

/** Disabled by default. A single exact byte identity can bypass inspection only in preproduction. */
export function configuredUploadInspectionException(env: NodeJS.ProcessEnv = process.env): Scope | null {
  if (env.BB_UPLOAD_EXCEPTION_ENABLED !== '1') return null;
  if (env.BB_DEPLOYMENT_TIER !== 'preprod') throw new Error('Upload inspection exception requires preprod tier');
  const parts = env.BB_UPLOAD_EXCEPTION_SCOPE?.split(':');
  if (!parts || parts.length !== 5) throw new Error('Invalid upload inspection exception scope');
  const [ownerUserId, projectId, role, sizeText, sha256] = parts;
  const byteSize = Number(sizeText);
  if (!ownerUserId || !projectId || !/^[A-Za-z0-9_-]{1,128}$/.test(ownerUserId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(projectId) || role !== 'audit' ||
      !/^[1-9][0-9]*$/.test(sizeText!) || !Number.isSafeInteger(byteSize) || byteSize > M1_UPLOAD_LIMITS.fileBytes ||
      !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid upload inspection exception scope');
  return { ownerUserId, projectId, role, byteSize, sha256 };
}

export function uploadInspectionExceptionMatches(scope: Scope | null, candidate: Candidate): boolean {
  return scope !== null && candidate.mediaType === M1_UPLOAD_MIME_TYPES[2] &&
    scope.ownerUserId === candidate.ownerUserId && scope.projectId === candidate.projectId &&
    scope.role === candidate.role && scope.byteSize === candidate.byteSize && scope.sha256 === candidate.sha256;
}
