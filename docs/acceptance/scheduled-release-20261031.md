# BondBuddy 2026-10-31 scheduled release

The user explicitly requested this one release: “一个小时以后，将最新的代码部署到服务器”. Human acceptance is **not recorded**. This record describes integration validation, not deployment completion.

## Scope

- #857: show ZIP preparation file counts, elapsed time and transfer progress.
- #858: responsive navigation, account avatar entry and a single assistant launcher.
- #859: validate missing Word output, bounded completion feedback and retained failure diagnostics.
- #860 and #862: preserve the selected source, original outline and PPN mapping; reject stale confirmation cards and provide both first-draft Word downloads.
- #863: automatically adopt uploaded historical/similar prospectuses and repair eligible existing source selections.

Product/image source: `3f81391822418b7b4e32a6e98e00b204ee290bf8`. Production baseline: `c874390996e784c7539eb7697ee12971091099e4`. Later integration changes only correct test fixtures and add this record; application code and dependency manifests remain identical to the image source.

## Validation

- Contracts/domain/registry/context/API/worker TypeScript, web typecheck/build and compiled web tests passed. Three Linux production images built with the existing verified Node 22.23.3 runtime; Python and knowledge files were refreshed from the fixed source.
- Web unit tests: 170 passed. Contracts: 72 passed; example scripts: 171 synthetic, 12 internal and 4 lifecycle examples passed.
- API with isolated PostgreSQL/Azurite: 26 unique checks passed across the initial run and targeted retries. Covers upload/adoption/selection, lifecycle, authentication and 248-file ZIP integrity, plus withdrawal to 247 files.
- Worker: 44 unique checks passed across initial run and retry. Test-only overlay provides pngjs and repository fixtures omitted from the production image.
- Python: 18 fixed-edit and 7 source-outline tests passed; one authorized-document opt-in suite skipped.
- Browser: 27 ZIP/progress, 147 material/source/Word and 85 account/navigation/assistant checks passed across initial runs and targeted retries; three existing opt-in cases skipped. Browser APIs are synthetic; real database/storage validation is recorded separately.
- Initial failures are retained. Corrected expectations for the initial zero transfer event, file withdrawal count, automatic source adoption and renamed assistant launcher. A Playwright clock setup failure and an account-workflow timeout passed targeted retries without changing application code, assertions or timeouts.
- Hosted GitHub Actions did not start because of account payment/spending limits. It is not reported as passing. Local validation is the available evidence.

## Deployment requirements and boundaries

One migration: `0162_automatic_prospectus_upload_adoption.sql`. No dependency changes. The migration registers missing uploaded versions and updates eligible selection/project metadata; immutable inputs, existing content, tasks and charges must remain unchanged. Rehearse on an isolated restored production backup before applying it. Compatible application rollback must retain the additive migration and adoption records; no automatic database restore after new traffic.

Use the shared production deployment lock, recheck the live commit and drain customer work naturally. Verify actual server sandbox policy, completion protocol, backup readback/restore, coordinated API/web/workers/ops versions, readiness, public assets and affected functions before declaring deployment complete.

No real paid model or payment tests were run. User acceptance and real model output quality are not inferred from these tests. Draft/unverified work, including #861, #823 and #770, is outside this batch. Detailed local evidence: `work/release-control/20261031-late-scheduled/` in the release owner's workspace.
