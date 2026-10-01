/**
 * Internal normalization for the #397/#18 active project-message set.
 *
 * The public aggregate "message set pin" contract now lives in
 * `@bondbuddy/contracts` (`project-message-set-pin.ts`, additive, no HTTP DTO). This
 * module only resolves immutable submission metadata that already lives in
 * PostgreSQL and adapts it to the shared contract; it never becomes a public DTO and
 * never reads the private prompt Blob body.
 *
 * Semantics fixed by the product owner (2026-09-29):
 * - one active member per message_id: its latest saved message_version;
 * - members accumulate in original conversation order (first-submission position);
 * - a saved edit changes the set hash while older snapshots keep their old pin;
 * - a bare max(submission version) is never accepted as set identity.
 */

import { createHash } from 'node:crypto';
import {
  PROJECT_MESSAGE_SET_EMPTY_VERSION,
  PROJECT_MESSAGE_SET_HASH_DOMAIN,
  PROJECT_MESSAGE_SET_MAX_MEMBERS,
  canonicalProjectMessageSetContent,
  projectMessageSetRef,
  projectMessageSetRefMatches,
  validProjectMessageSetPin,
  type ProjectMessageSetMember,
  type ProjectMessageSetPin,
  type ProjectMessageSetRef,
} from '@bondbuddy/contracts';
import {
  loadLatestProjectMessagePins,
  type ProjectMessagePin,
  type ProjectMessagePinQuery,
} from './project-message-pin-loader.js';

export { PROJECT_MESSAGE_SET_EMPTY_VERSION, PROJECT_MESSAGE_SET_HASH_DOMAIN };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type { ProjectMessageSetMember, ProjectMessageSetPin };

/** Aggregate ref bound into TargetPeriodCandidateSnapshot.supplemental_requirements. */
export type ProjectMessageSetRequirementsPin = ProjectMessageSetRef;

/** True when the error came from bounded message metadata loading or normalization. */
export function isProjectMessagePinError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === 'ProjectMessagePinLoaderError' || error.name === 'ProjectMessageSetPinError');
}

function fail(): Error {
  const error = new Error('PROJECT_MESSAGE_SET_INVALID');
  error.name = 'ProjectMessageSetPinError';
  return error;
}

function contractsFail(): never { throw fail(); }

function canonical(value: unknown): string {
  try { return canonicalProjectMessageSetContent(value); } catch { return contractsFail(); }
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

/**
 * Deterministically normalize one latest pin per message_id into the active set.
 *
 * Members are re-sorted by first_submission_version so the same logical set is stable
 * regardless of input array order. Missing/duplicate identifiers, a missing content
 * hash, duplicate conversation positions, or an over-limit set fail closed.
 */
export function normalizeProjectMessageSet(pins: readonly ProjectMessagePin[]): ProjectMessageSetPin {
  if (!Array.isArray(pins) || pins.length > PROJECT_MESSAGE_SET_MAX_MEMBERS) throw fail();
  const ordered = [...pins].sort((left, right) => left.first_submission_version - right.first_submission_version);
  const messageIds = new Set<string>();
  const submissionIds = new Set<string>();
  const positions = new Set<number>();
  for (const pin of ordered) {
    if (typeof pin.message_id !== 'string' || !IDENTIFIER.test(pin.message_id) ||
        typeof pin.submission_id !== 'string' || !IDENTIFIER.test(pin.submission_id) ||
        typeof pin.first_submission_id !== 'string' || !IDENTIFIER.test(pin.first_submission_id) ||
        !Number.isSafeInteger(pin.message_version) || pin.message_version < 1 ||
        !Number.isSafeInteger(pin.first_submission_version) || pin.first_submission_version < 1 ||
        !Number.isSafeInteger(pin.latest_submission_version) || pin.latest_submission_version < pin.first_submission_version ||
        typeof pin.content_sha256 !== 'string' || !SHA256.test(pin.content_sha256) ||
        messageIds.has(pin.message_id) || submissionIds.has(pin.submission_id) || positions.has(pin.first_submission_version)) {
      throw fail();
    }
    messageIds.add(pin.message_id);
    submissionIds.add(pin.submission_id);
    positions.add(pin.first_submission_version);
  }
  const members: ProjectMessageSetMember[] = ordered.map(pin => ({
    message_id: pin.message_id,
    message_version: pin.message_version,
    submission_id: pin.submission_id,
    content_sha256: pin.content_sha256,
  }));
  const version = members.length === 0
    ? PROJECT_MESSAGE_SET_EMPTY_VERSION
    : Math.max(...ordered.map(pin => pin.latest_submission_version));
  const message_ids = members.map(member => member.message_id).sort();
  const candidate: ProjectMessageSetPin = {
    version,
    content_sha256: '0'.repeat(64),
    members,
    message_ids,
  };
  const pin: ProjectMessageSetPin = { ...candidate, content_sha256: sha256(canonical(candidate)) };
  let valid = false;
  try { valid = validProjectMessageSetPin(pin); } catch { valid = false; }
  if (!valid) throw fail();
  return pin;
}

/** Project a normalized set into the aggregate shape stored in a candidate snapshot. */
export function projectMessageSetRequirementsPin(pin: ProjectMessageSetPin): ProjectMessageSetRequirementsPin {
  try {
    if (!validProjectMessageSetPin(pin)) throw fail();
    return projectMessageSetRef(pin);
  } catch (error) {
    throw isProjectMessagePinError(error) ? error : fail();
  }
}

/**
 * Compare a freshly normalized set with a bound aggregate pin. An aggregate that only
 * carries a version (or otherwise lacks verifiable members) can never match because the
 * expected side is always recomputed from exact member metadata.
 */
export function projectMessageSetRequirementsMatch(
  expected: ProjectMessageSetPin,
  actual: ProjectMessageSetRequirementsPin,
): boolean {
  try { return projectMessageSetRefMatches(expected, actual); } catch { return false; }
}

/**
 * Owner/project-scoped bounded load + normalization. The caller decides how to map a
 * failure to its own fail-closed error code; this helper never fabricates an empty set
 * when the metadata is incomplete.
 */
export async function loadProjectMessageSetPin(
  client: ProjectMessagePinQuery,
  expected: { readonly ownerUserId: string; readonly projectId: string },
): Promise<ProjectMessageSetPin> {
  return normalizeProjectMessageSet(await loadLatestProjectMessagePins(client, expected));
}
