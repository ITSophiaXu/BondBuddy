# Issue #19 production review ledger, phase 1

This implementation freezes review content and records authenticated review decisions. It does not publish, withdraw, or roll back a production rule release. Production selection stays closed until those later gates and real professional evidence are complete.

## Scope binding

Migration `0071_m1_production_review_attestation_ledger.sql` adds one immutable `bb_rule_pack_production_grant_scopes` row per new 0036 grant. A deferred constraint trigger requires new grants and scope rows to be committed in the same transaction. Existing grants without a scope row remain unusable for review and cannot be backfilled implicitly. There are no grant seeds or HTTP grant-management routes.

The scope row pins sorted `instruments`, the permitted `document_stages`, and the four reviewed dimensions `issuer_scopes`, `investor_scopes`, `industry_codes`, and `special_feature_scope`. `scope_hash` is lowercase SHA-256 of canonical JSON over those six fields (sorted object keys, declared array order preserved), matching the #367 production-review canonicalization. At use time the API recomputes the hash. Market and offering come from the existing 0036 grant row and must exactly match the frozen manifest.

Instrument and stage values in the manifest must be subsets of the grant. A grant dimension in `reviewed_unrestricted` covers any manifest value; an `explicit_codes` grant covers only a manifest `explicit_codes` subset with the same `dictionary_version`; `needs_review` never covers. A missing or malformed scope row, hash drift, inactive user/grant, or scope mismatch fails closed. Scope expansion requires revoking the old grant and issuing a new grant with a new immutable scope.

## Routes and transaction behavior

- `POST /api/v1/rule-pack-reviews/manifests` accepts `request_id` and content only. `manifest_id` is the pinned rule-pack ID; the API assigns the next version and computes `content_sha256` after validating the #367 content schema and canonical hash.
- `GET /api/v1/rule-pack-reviews/manifests/:manifest_id/versions/:version` returns a frozen version only to an active grant whose scope covers it.
- `POST /api/v1/rule-pack-reviews/manifests/:manifest_id/versions/:version/attestations` accepts `request_id`, `manifest_content_hash`, `attestation_kind`, decision, reason, and the kind-specific evidence. Session identity, role grant, and grant scope are server-derived. The operator who froze the content cannot attest it, and one user cannot sign both roles on a manifest.
- `POST /api/v1/rule-pack-reviews/manifests/:manifest_id/versions/:version/attestations/:attestation_event_id/withdrawal` accepts `request_id` and reason. It appends a withdrawal only for the original reviewer with an active account. The original grant's retained scope is checked even if that grant was later revoked; revocation still blocks new attestations and the signature cannot count toward later release.

Writes use request IDs plus server-computed request hashes; identical requests replay the original row and conflicting reuse returns 409. Audit and outbox rows commit with each freeze, attestation, and withdrawal. The lock order follows the #19 decision: pack advisory lock, manifest row, grant/scope/user rows ordered by grant ID, source and sample evidence rows ordered by ID, then attestation/release/event rows and outbox. There is no project-row lock in these routes.

## Evidence and remaining gates

The PostgreSQL 16 integration fixture is explicitly synthetic and records only `request_more_evidence`; it does not create a professional approval or turn its example sample references into real samples. The test exercises hash drift, stale pins, scope omission rejection, session-derived actor, role separation, own withdrawal, grant revocation, idempotency, concurrent reviewer submissions, audit and outbox.

No production grant, manifest, professional decision, sample authorization, or production release was created. This slice does not map the three component references to immutable full pack/template/coverage snapshots, and does not write 0036 release events. The real source, sample, industry, technical, release, selector, and production acceptance gates remain open.
