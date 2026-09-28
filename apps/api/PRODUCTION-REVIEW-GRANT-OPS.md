# Production rule-pack review grant operations

Production review grants are provisioned only by the controlled maintenance command. There is no HTTP grant endpoint. Run the command from a controlled deployment/operations host using the normal protected database credentials; the database role must own `bb_rule_pack_production_reviewer_grants` or be a superuser. Supply the existing active operator/grantor user ID explicitly. The command does not create users, reviewer identities, attestations, or release decisions.

Build the API package, then issue a grant with a scope JSON file:

```sh
npm run build -w @bondbuddy/api
DATABASE_URL="$DATABASE_URL" npm run production-review:grants -w @bondbuddy/api -- \
  grant <user_id> <grantor_user_id> <role> <market> <offering> \
  "<reason for this access>" <scope.json>
```

Supported roles are `rule_pack_operator`, `rule_pack_industry_reviewer`, and `rule_pack_technical_reviewer`. Market/offering pairs follow the production schema (`sse`/`szse`: `private`, `public`, `public_all`; `nafmii`: `ppn`, `mtn`, `cp`, `scp`, `dfi`). Both the named user and grantor must already be active accounts, and the grantee cannot be the grantor.

The scope file is exactly one JSON object with these fields (example values are placeholders, not production authorization):

```json
{
  "instruments": ["mtn"],
  "document_stages": ["issuance", "registration"],
  "issuer_scopes": { "mode": "explicit_codes", "codes": ["domestic_company"], "dictionary_version": "issuer-v1" },
  "investor_scopes": { "mode": "reviewed_unrestricted", "evidence_id": "review-evidence-id", "evidence_version": 1, "evidence_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "industry_codes": { "mode": "needs_review", "reason_code": "industry_boundary_pending", "reason": "Replace with the documented pending boundary" },
  "special_feature_scope": { "mode": "explicit_codes", "codes": ["green"], "dictionary_version": "features-v1" }
}
```

Arrays are sorted, unique sets; explicit code arrays cannot use `all` or `*`. Each reviewed dimension must match the #367 `reviewedDimension` shape. `needs_review` is valid to preserve a pending boundary, but it grants no coverage for that dimension. The scope hash uses the rule-pack registry canonical JSON SHA-256 over the six scope fields only; market and offering remain in the 0036 grant row. Grant and immutable scope are inserted in one transaction with the same database timestamp. The grant reason is retained in the outbox event; the grant row keeps the fixed reason code `controlled_ops_cli`.

Revoke by grant ID, explicit active revoker ID, and reason:

```sh
DATABASE_URL="$DATABASE_URL" npm run production-review:grants -w @bondbuddy/api -- \
  revoke <grant_id> <revoker_user_id> "<reason for revocation>"
```

Revocation takes `FOR UPDATE` on the grant row, records affected frozen manifest references and production release event references in an actor-owned `rule_pack_grant_revoked` outbox row, and commits with `revoked_at`. It does not withdraw a release. Operators review the emitted references and use the separate release withdrawal flow if required. Command output contains grant IDs, scope hashes, and affected references only; it never prints scope contents or source/sample material.
