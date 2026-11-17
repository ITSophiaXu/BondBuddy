# Managed database prerequisites production release (#1484)

This narrow release starts from stable master a23e522c and cherry-picks #1485. It retains #1490's drain/zombie fix, timing, recovery, both OCI images, all model/business modules, and 8/8 capacity. The 74-file overlay changes only the two execution-node-runtime leaves and adds evidence-gate and managed-database-preflight to both services; 68 prior runtime files remain byte-identical. Migration 0190 and four reviewed ACL deltas are applied on the main database only.

The public bootstrap uses Python-compatible Base85 around the existing bounded Brotli stream so the enlarged strict manifest fits the 16 KiB UserData limit. Decoding preserves exact installer/file bytes; existing retained warm launch bytes stay pinned.

Validation: worker TypeScript build passed; both actual production OCI images imported the candidate in network-none isolation and passed 13 tests each (26 total, zero fail/skip); public new/old closure and two-slot bootstrap 6/6; Base85 Python decoder and installer byte checks 2/2. Earlier permission PostgreSQL and real-model replay evidence remains in #1484; Qixian delivered both Word files, Cangzhou ended in the independent provider HTTP 413. No fabricated full business-quality credential.

Release order: stage-control; create-only probe-control and main-api prepare; back up ACL and apply-database; activate-control; main-api activate (API plus same-image web refresh); one standard persisted warm Start; exact install-request through the existing maintenance identity; verify actual 74 hashes and preflight under both service identities, READY, then graceful idle drain and stop charging. Existing four roles, future two slot templates, current helper, and controller authority are separate checks. No historic customer task is resubmitted.

All mutations use the existing state-main locks and pending ownership. Original immutable archives are retained. Rollback keeps additive SQL and audit data; restoring the old direct-lock binary is not a functional rollback for restricted consumers. Main/API rollback files and controller preimages are protected on the target. Node old helper/pin is preserved at /var/lib/bondbuddy/managed-db1484-install.

Production activation was not performed when this candidate was written. A pre-existing expired tariff horizon currently blocks normal node Start; refresh with verified official evidence and the existing operations identity, preserving hourly/day caps. Do not extend timestamps or use direct cloud Start to bypass that gate.
