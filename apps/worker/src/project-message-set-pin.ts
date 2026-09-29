/**
 * Internal normalization for the #397/#18 active project-message set.
 *
 * The public aggregate "message set pin" format (ordered member pins + monotonic
 * set version) is still pending confirmation by the #17/#18 owners. This module
 * deliberately stays internal: it never becomes a public DTO and never reads the
 * private prompt Blob body. It only normalizes immutable submission metadata that
 * already lives in PostgreSQL.
 *
 * Semantics fixed by the product owner (2026-09-29):
 * - one active member per message_id: its latest saved message_version;
 * - members accumulate in original conversation order (first-submission position);
 * - a saved edit changes the set hash while older snapshots keep their old pin;
 * - a bare max(submission version) is never accepted as set identity.
 */

import { createHash } from 'node:crypto';
import {
  loadLatestProjectMessagePins,
  type ProjectMessagePin,
  type ProjectMessagePinQuery,
} from './project-message-pin-loader.js';

export const PROJECT_MESSAGE_SET_HASH_DOMAIN = 'bondbuddy:project-message-set:v1' as const;
/** Version bound to the empty active set so the aggregate contract stays >= 1. */
export const PROJECT_MESSAGE_SET_EMPTY_VERSION = 1 as const;
const MAX_PROJECT_MESSAGE_SET_MEMBERS = 500;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Exact member identity hashed for one active message. Intentionally excludes the Blob body. */
export interface ProjectMessageSetMember {
  readonly message_id: string;
  readonly message_version: number;
  readonly submission_id: string;
  readonly content_sha256: string;
}

/**
 * Normalized, owner/project-scoped active message set.
 *
 * `content_sha256` is SHA-256 over a domain-separated canonical JSON object whose
 * `members` array preserves conversation order. `version` is deterministic from the
 * set: the baseline for empty and the max first-submission position otherwise.
 * It is a conversation-order baseline, not a bare max(message_version), and never a
 * substitute for the hash as set identity.
 */
export interface ProjectMessageSetPin {
  readonly version: number;
  readonly content_sha256: string;
  /** Lexicographically sorted active message IDs for the aggregate contract field. */
  readonly message_ids: readonly string[];
  /** Exact ordered members whose hash is `content_sha256`. */
  readonly members: readonly ProjectMessageSetMember[];
}

/** Aggregate shape accepted by TargetPeriodCandidateSnapshot.supplemental_requirements. */
export interface ProjectMessageSetRequirementsPin {
  readonly version: number;
  readonly content_sha256: string;
  readonly message_ids: string[];
}

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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw fail();
  return json;
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
  if (!Array.isArray(pins) || pins.length > MAX_PROJECT_MESSAGE_SET_MEMBERS) throw fail();
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
        typeof pin.content_sha256 !== 'string' || !SHA256.test(pin.content_sha256) ||
        messageIds.has(pin.message_id) || submissionIds.has(pin.submission_id) || positions.has(pin.first_submission_version)) {
      throw fail();
    }
    messageIds.add(pin.message_id);
    submissionIds.add(pin.submission_id);
    positions.add(pin.first_submission_version);
  }
  const members = ordered.map(pin => ({
    message_id: pin.message_id,
    message_version: pin.message_version,
    submission_id: pin.submission_id,
    content_sha256: pin.content_sha256,
  }));
  return {
    version: members.length === 0
      ? PROJECT_MESSAGE_SET_EMPTY_VERSION
      : Math.max(...ordered.map(pin => pin.first_submission_version)),
    content_sha256: sha256(canonical({ hash_domain: PROJECT_MESSAGE_SET_HASH_DOMAIN, members })),
    message_ids: members.map(member => member.message_id).sort(),
    members,
  };
}

/** Project a normalized set into the aggregate shape stored in a candidate snapshot. */
export function projectMessageSetRequirementsPin(pin: ProjectMessageSetPin): ProjectMessageSetRequirementsPin {
  return { version: pin.version, content_sha256: pin.content_sha256, message_ids: [...pin.message_ids] };
}

/**
 * Compare a freshly normalized set with a bound aggregate pin. An aggregate that only
 * carries a version (or otherwise lacks verifiable members) can never match because the
 * expected side is always recomputed from exact member metadata.
 */
export function projectMessageSetRequirementsMatch(
  expected: ProjectMessageSetPin,
  actual: { readonly version: number; readonly content_sha256: string; readonly message_ids: readonly string[] },
): boolean {
  if (!actual || typeof actual.content_sha256 !== 'string' ||
      expected.version !== actual.version || expected.content_sha256 !== actual.content_sha256 ||
      expected.message_ids.length !== actual.message_ids.length) return false;
  return expected.message_ids.every((messageId, index) => messageId === actual.message_ids[index]);
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
