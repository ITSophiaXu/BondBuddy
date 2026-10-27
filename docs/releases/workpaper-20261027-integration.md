# Workpaper integration, 2026-10-27 night

Candidate: `e947884e1ae49d6f0292188999518d3fbe2c716c`, including PRs #762 and #763.

The new project workpaper library makes an additional read-only GET request on the generation page. Existing generation/recovery browser fixtures now return the empty library shape. Unexpected requests and business-write checks remain enforced. The API knowledge assertion now expects fixed templates and private preparation notes, matching the delivered-file boundary.

Validation in an isolated Linux API/worker/PostgreSQL/Azurite environment:

- TypeScript packages, web typecheck and Vite bundle passed.
- Backend initial run: 48/50 passed, including the 300-item queue/retry/billing/ZIP stress test, library/preview/change checks and owner isolation. One stale preparation-note assertion and one read-only test-output mount failed. Updated assertion and writable ephemeral evidence mount: all 14 affected tests passed, zero skipped.
- Browser initial run: 63/72 passed. Nine old fixtures lacked the new library GET. Both affected suites passed 20/20 after fixture correction, zero skipped.
- Python full source extraction and 147 neutral template tests: 5/5 passed. Workpaper generation-stage test: 1/1 passed.
- Contracts: 171 synthetic examples, 12 internal examples and 4 lifecycle examples passed; 46 Node tests passed. Run on the host against freshly compiled candidate, because the production-like image deliberately does not include unrelated test example/prototype directories.

Initial failure logs are retained with corrected-run evidence under the release controller's `work/release-control/20261027-night`. GitHub Actions did not start because of the repository account billing/spending limit; its failure status is not reported as a pass.

Migrations 0117–0119 add workpaper state and widen existing M4 type checks. API, workers, web, contracts, templates and skills require a coordinated release. `yazl` 3.3.1 and `buffer-crc32` 1.0.0 are promoted to production dependencies without version changes.

The user explicitly authorized a single delayed deployment. Automated validation is separate from user acceptance; user acceptance has not occurred. Deployment, real-model sample results, backup/restore and migration rehearsal are recorded separately in the final release receipt.
