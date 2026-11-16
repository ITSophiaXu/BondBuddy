# Remaining deployment handoff for PR #1428

Status: candidates built and verified; no production cutover or 0185 migration executed. The existing managed capacity release must remain intact. This file records the missing operational handoff, not permission to improvise a replacement cloud provisioning path.

## Fixed candidate artifacts

- Authoring OCI: `sha256:a25756ab6b879a5e43e1bc9e7b2b6147185457185e5ea1dedc63b6dc19a9a48c`.
- Review OCI: `sha256:2b147a7a207f913dd3f6eb5619631b85a449f003506785a8edb72e6f9f2477ce`.
- Both currently exist on the Azure Docker host. Candidate build files and receipts: `/var/lib/bondbuddy/fine-step1420-managed-oci-4181f5151fe8`.
- Build manifest SHA-256: `4181f5151fe86285f8351354ca54772ac46dfde8a7c0856ed41c76cfb06f3e65`.
- Authoring replacement business archive SHA-256: `2323495579f239f8454d9c51a9fe90086b9b42eb229e7efb2b0565ed6a4ddc9a`. Review has no business overlay.
- Source overlay SHA-256: `b83da7b645fd04764706a85dc3dd2699736ffe8d44e27484006cfa72873e083d`.

The build kept every parent layer and the original User, Entrypoint, Cmd, WorkingDir and Env. Each role adds one COPY layer. All 36 targets matched their hashes; 34 JavaScript files passed Node 22.23.4 syntax checks in network-disabled, read-only verification containers. These were artifact checks, not task execution or cloud-node acceptance.

## Required handoff from the managed capacity release

Provide the existing controlled system-image creation/update entry point, including its management host and isolation configuration. The current formal system image is `img-6cnm1flv`; directly booting it has not been proven to suppress runtime and heartbeat before first startup. Historical builder retirement and budget receipts do not supply that guarantee. The needed entry point must cover isolated builder startup, OCI loading, matching `/etc/bondbuddy/elastic-node.json` pins, CreateImage, snapshot budget, builder retirement, and publication of the resulting approved system-image identity.

The existing host-side OCI build/export/upload scripts are available, but are not a complete system-image publication workflow. Do not execute their old hard-coded image IDs or overwrite their existing private blobs. Keep at least 2 GiB free on the existing hosts; do not stage full image exports or database dumps there.

## Final controlled rollout

After the handoff is available, assemble and verify the new system-image and boot contract, preserving the current source, launcher and issuer contract except for required logging artifact identities. Recheck all live bindings under the actual shared deployment/control locks. Preserve global capacity 8, per-node capacity 4, maximum 2 nodes, and existing cost/stop rules. Azure authoring/review remain stopped; Azure parsing remains running.

Drain active work and take a fresh off-host backup before migration. Preserve the existing 187 migration records and apply only canonical 0185 plus the reviewed performance-table column grants. Update main API, ops and web from their pinned byte recipes, keeping the current ops mounts. Update future-node launch bindings and any retained node pins together. Verify actual boot, queue/lease behavior, logging writes and reads, parser health, and rollback identities. Old timing tables and grants can remain after a code rollback.

This batch still needs its applicable full quality gate or a specific user-approved exception. The earlier #1350/#1364 exception does not automatically cover #1420. Missing evidence is not a pass, and draft status remains until the final candidate and rollout are ready for approval.
