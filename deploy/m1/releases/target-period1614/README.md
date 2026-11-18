# PR1614 target reporting period label — scoped web release

This release changes eight display strings in four frontend files from 最新报告期 to 目标报告期. 原稿最新报告期 remains unchanged. No input fields, date derivation, saved metadata, API code, models, worker code, billing, database schema, dependencies or production configuration values change.

Source: PR #1614 / 9041719457743c5f55f47612879f67621f030726, separately merged into develop. The release branch starts at master 271d693161c6b08fa567472f2f05aec6a3994f04 and includes only that PR plus this release package. Production is a composition of component releases, so deployment uses the verified current web baseline rather than building all of develop or master.

## Provenance and checks

The independently copied audit-pdf1610 composite frontend reproduced all seven currently served entry resources byte for byte. Applying exactly 1/3/2/2 string replacements in material-draft-comparison.ts, project-assistant.ts, review-workspace.ts and update-form.ts produces the candidate. A byte comparison of the compiled main JS verifies that its only changes are the eight label substitutions. Only index.html and assets/main-CkDxpGTE.js are overlaid; all original mounts, earlier assets, API and CSS chunks remain.

Original PR validation: TypeScript/build and 22 unit tests passed; 29/34 browser tests passed. All five failures reproduced on the PR parent and are documented in the local test report. Current-composite static candidate: 12 browser cases passed. A mobile original-source radio click timeout reproduced on the exact current-production baseline; the source-import-only assistant test cannot run under static preview. Its separate Vite rerun completed the UI assertions but failed the fixture's unexpected-request check on GET /me. The initial Vite cold-load timeout is retained. These results are not described as an all-green suite.

The user first requested testing PR1614 and then explicitly instructed deployment to the server. This authorizes this limited UX deployment; no full prospectus quality gate or user acceptance is claimed. full_quality_gate_passed=false. All business interactions in local tests used synthetic HTTP fixtures; no real backend generation or model calls occurred. GitHub hosted UX checks could not start because of the recorded account billing/spending-limit error.

Server preparation passed against the pinned registry and web preimages, including a non-started Docker probe that verified preserved process, host and mount configuration. It changed no running service. Exact package, activation script, adapter and source hashes are in manifest.json; archive contains only two public frontend files.

## Activation and rollback

The operator invokes activate.py as root with JSON on stdin containing action=activate and source_commit=<exact merged release commit>. The script uses /var/lib/bondbuddy/migration-908/state-main/config.lock and deploy.lock, rejects any foreign pending release, rechecks lock inodes, current registry, environment binding, source configuration, every existing file mount, the active seven files and protected API/PostgreSQL/ops containers. It saves the previous private compose/inspect/registry and active files, then recreates only web with --no-deps --no-build --pull never. No API, worker, database or other service restart is performed.

It verifies running configuration, network IDs, effective files, served hashes, health and protected containers before atomically updating the existing component registry and clearing its owned pending record. Other component records are retained. The immutable release root is /var/lib/bondbuddy/target1614-20261118; secrets and original configurations remain in its private directory on the server.

If activation fails, retain pending and inspect the actual state before any retry. The same script accepts action=rollback with the deployed source commit. Rollback uses the same locks, requires this release's owned attempt and expected registry, restores the exact saved frontend compose, checks original seven hashes and records the rollback. Do not delete another release's pending state or replace the shared state path.

Deployment completion is recorded separately in deployment.json and public-verification.json. Preparation and test success alone do not mean deployed or user accepted.
