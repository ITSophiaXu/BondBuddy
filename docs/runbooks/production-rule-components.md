# Production rule component snapshot import

This maintenance command registers one complete immutable snapshot set (`rule_pack`, `chapter_template`, and `coverage_manifest`) in `bb_rule_pack_production_component_snapshots`. It is an input preparation step for the separately controlled freeze/release workflow. It does not create a reviewer attestation, grant, release event, production capability, or professional signoff.

The database must already be migrated through `0072_m1_production_component_snapshots.sql`. Prepare a local UTF-8 JSON bundle with exactly two top-level keys:

```json
{
  "refs": {
    "rule_pack": { "kind": "rule_pack", "id": "…", "version": "…", "sha256": "…" },
    "chapter_template": { "kind": "chapter_template", "id": "…", "version": "…", "sha256": "…" },
    "coverage_manifest": { "kind": "coverage_manifest", "id": "…", "version": "…", "sha256": "…" }
  },
  "snapshots": {
    "rule_pack": {},
    "chapter_template": {},
    "coverage_manifest": {}
  }
}
```

Replace the abbreviated values with the full component JSON and its exact identity, version, and content hash. The registry validates companion relationships and recomputes the references; incomplete sets, mismatches, and attempts to replace an existing `(kind, id, version)` with different content fail. Identical imports are idempotent. The command uses one explicit `BEGIN`/`COMMIT` transaction and rolls back on failure.

Run from the repository root with a `DATABASE_URL` for the intended environment. Keep the bundle in a protected local path, outside the repository; neither the source JSON nor database credentials are printed.

```sh
npm run build -w @bondbuddy/api
DATABASE_URL='postgresql://…' npm run production-components:import -w @bondbuddy/api -- /protected/path/component-bundle.json
```

On success, stdout contains only the result and each component's id, version, and SHA-256. On failure, stderr contains a stable error code. Preserve the bundle according to the applicable change record and remove local copies according to team handling rules. Import success proves only that the immutable snapshots were stored; it does not mean they are approved, effective, released, or suitable for a real project.
