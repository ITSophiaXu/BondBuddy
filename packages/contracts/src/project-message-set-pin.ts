import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Public, additive contract for the active project-message set pin (#18/#397 handoff).
 *
 * Product semantics fixed by the product owner (2026-09-29):
 * - exactly one active member per `message_id`: its latest saved `message_version`;
 * - members accumulate in original conversation order (first-submission position),
 *   never lexicographic order; a later saved edit changes the set hash while older
 *   snapshots keep their old pin and every older message version stays auditable;
 * - a bare `max(version)` is never a set identity.
 *
 * `content_sha256` is SHA-256 over a domain-separated canonical JSON object whose
 * `members` array preserves conversation order; object keys are sorted and array
 * order is preserved (`PROJECT_MESSAGE_SET_CANONICALIZATION`). This module is a pure
 * contract: it never reads a prompt Blob body and adds no HTTP operation. The
 * aggregate {@link ProjectMessageSetRef} is what immutable input/candidate snapshots
 * pin; the ordered {@link ProjectMessageSetPin} is its verifiable member identity.
 */
export const PROJECT_MESSAGE_SET_PIN_SCHEMA_VERSION = 'project-message-set-pin-v1' as const;
export const PROJECT_MESSAGE_SET_HASH_DOMAIN = 'bondbuddy:project-message-set:v1' as const;
export const PROJECT_MESSAGE_SET_CANONICALIZATION = 'utf8-json-sorted-object-keys-preserve-declared-array-order-v1' as const;
/** Aggregate version bound to the empty active set so the contract stays >= 1. */
export const PROJECT_MESSAGE_SET_EMPTY_VERSION = 1 as const;
export const PROJECT_MESSAGE_SET_MAX_MEMBERS = 500 as const;

const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const revision = Type.Integer({ minimum: 1, maximum: 2147483647 });

/** One active message: its latest saved version plus the immutable submission/content hash. */
export const ProjectMessageSetMemberSchema = Type.Object({
  message_id: id,
  message_version: revision,
  submission_id: id,
  content_sha256: hash,
}, { additionalProperties: false, description: 'Immutable latest-saved metadata for one active message; never the prompt body.' });

/** Ordered member identity. `members` is conversation order, not message-id order. */
export const ProjectMessageSetPinSchema = Type.Object({
  version: revision,
  content_sha256: hash,
  members: Type.Array(ProjectMessageSetMemberSchema, {
    maxItems: PROJECT_MESSAGE_SET_MAX_MEMBERS,
    description: 'Active members in exact conversation (first-submission) order; never sorted by message_id.',
  }),
  message_ids: Type.Array(id, {
    maxItems: PROJECT_MESSAGE_SET_MAX_MEMBERS,
    description: 'Derived strictly increasing lexicographic projection; must equal the members message IDs and is not their order.',
  }),
}, { additionalProperties: false, description: 'Verifiable active message-set identity. A set version alone is not an identity; an empty set is explicit with empty members/message_ids.' });

/** Aggregate reference bound into immutable input/candidate snapshots. */
export const ProjectMessageSetRefSchema = Type.Object({
  version: revision,
  content_sha256: hash,
  message_ids: Type.Array(id, {
    maxItems: PROJECT_MESSAGE_SET_MAX_MEMBERS,
    description: 'Strictly increasing lexicographic projection of the member IDs; an aggregate field, not the conversation order.',
  }),
}, { additionalProperties: false, description: 'Exact selected active-message set; an empty set still has an explicit version and hash.' });

export const projectMessageSetSchemas = {
  ProjectMessageSetPin: ProjectMessageSetPinSchema,
  ProjectMessageSetRef: ProjectMessageSetRefSchema,
} as const;

export type ProjectMessageSetMember = Static<typeof ProjectMessageSetMemberSchema>;
export type ProjectMessageSetPin = Static<typeof ProjectMessageSetPinSchema>;
export type ProjectMessageSetRef = Static<typeof ProjectMessageSetRefSchema>;

function fail(): never { throw new Error('PROJECT_MESSAGE_SET_PIN_INVALID'); }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(',')}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) fail();
  return json;
}

function strictlySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

/** Unique message/submission identity for the ordered member array; any duplicate or malformed member fails. */
function validMemberInventory(members: readonly ProjectMessageSetMember[]): boolean {
  const messageIds = new Set<string>();
  const submissionIds = new Set<string>();
  for (const member of members) {
    if (!Value.Check(ProjectMessageSetMemberSchema, member) ||
        messageIds.has(member.message_id) || submissionIds.has(member.submission_id)) return false;
    messageIds.add(member.message_id);
    submissionIds.add(member.submission_id);
  }
  return true;
}

/**
 * Canonical hash input for `content_sha256`: domain-separated JSON with sorted object
 * keys and the conversation-ordered `members` array preserved. Throws on a malformed
 * member array rather than hashing an incomplete set.
 */
export function canonicalProjectMessageSetContent(value: unknown): string {
  if (!Value.Check(ProjectMessageSetPinSchema, value)) fail();
  const pin = value as ProjectMessageSetPin;
  if (!validMemberInventory(pin.members)) fail();
  return canonicalJson({ hash_domain: PROJECT_MESSAGE_SET_HASH_DOMAIN, members: pin.members });
}

/**
 * Structural and uniqueness invariants a JSON Schema alone cannot express. The trusted
 * producer still recomputes and compares `content_sha256`; this helper deliberately
 * cannot prove conversation `version` without the internal first-submission metadata.
 */
export function validProjectMessageSetPin(value: unknown): value is ProjectMessageSetPin {
  if (!Value.Check(ProjectMessageSetPinSchema, value)) return false;
  const pin = value as ProjectMessageSetPin;
  if (!validMemberInventory(pin.members) || !strictlySorted(pin.message_ids)) return false;
  const expectedIds = pin.members.map(member => member.message_id).sort();
  if (expectedIds.length !== pin.message_ids.length ||
      !expectedIds.every((messageId, index) => messageId === pin.message_ids[index])) return false;
  return pin.members.length === 0 ? pin.version === PROJECT_MESSAGE_SET_EMPTY_VERSION : true;
}

/** Aggregate ref invariants: strictly sorted unique message IDs. */
export function validProjectMessageSetRef(value: unknown): value is ProjectMessageSetRef {
  if (!Value.Check(ProjectMessageSetRefSchema, value)) return false;
  return strictlySorted((value as ProjectMessageSetRef).message_ids);
}

/** Project an ordered set into the aggregate ref stored in an immutable snapshot. */
export function projectMessageSetRef(pin: ProjectMessageSetPin): ProjectMessageSetRef {
  if (!validProjectMessageSetPin(pin)) fail();
  return {
    version: pin.version,
    content_sha256: pin.content_sha256,
    message_ids: pin.members.map(member => member.message_id).sort(),
  };
}

/**
 * Compare a freshly normalized set with a bound ref. A ref that only carries a version
 * (or otherwise lacks a verifiable hash/member projection) can never match, because the
 * expected side is always recomputed from exact ordered members.
 */
export function projectMessageSetRefMatches(expected: ProjectMessageSetPin, ref: ProjectMessageSetRef): boolean {
  if (!validProjectMessageSetPin(expected) || !validProjectMessageSetRef(ref)) return false;
  const projected = projectMessageSetRef(expected);
  return projected.version === ref.version && projected.content_sha256 === ref.content_sha256 &&
    projected.message_ids.length === ref.message_ids.length &&
    projected.message_ids.every((messageId, index) => messageId === ref.message_ids[index]);
}
