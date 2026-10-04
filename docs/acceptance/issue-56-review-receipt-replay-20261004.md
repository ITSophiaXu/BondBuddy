# M3 worker lease repair: complete receipt replay

Related: #56. This record describes a synthetic reproduction and an execution repair. The user's target production project has not been inspected through an authenticated session, so this is not a confirmed diagnosis of that project's run or evidence of deployment.

## Reproduced defect and change

The worker synchronously replayed every financial/compliance tool receipt after Codex returned, during private result persistence/observation, during checkpoint reuse and during report assembly. Forty valid financial receipts over 35,269 synthetic records held the event loop for 32,162.94 ms. The default lease is 30 seconds, renewed every 12 seconds; a synchronous pass this long can prevent renewal before runtime/observation evidence is saved.

Production worker paths now await complete replay and yield to timers between each receipt. The synchronous API remains available to isolated MCP callers. All original source, owner, project, immutable input, read-scope, argument hash, evidence and independently recomputed result checks remain. Initial/final data and trace hashes reject mutations during a yield, and cancellation cannot return a trusted envelope. Validation still repeats at the existing persistence/replay boundaries; there is no verdict cache or lease extension.

The API accepts an asynchronous validator and awaits its verdict before storing bytes, recording an observation or returning a checkpoint. Persisted bytes are copied before validation, so a caller changing its Buffer during a yield cannot substitute different bytes. `Promise.resolve(false)` and validator rejection do not become a successful result.

Runtime and public-search evidence also used an inverted lock order: they locked the job before their INSERT acquired a foreign-key lock on the run, while renewal/cancellation locked run then job. Both now use run then job, check the project and terminal state, and keep the lease/token/attempt fencing. These separate concurrency defects have dedicated real PostgreSQL regressions; neither is claimed as the observed production cause.

Cancellation during the yielding local replay is classified as cancellation, retaining measured usage if the CLI already completed. It cannot be classified as a schema failure and trigger a re-ask. Already-aborted execution is guarded before intent/spawn, and cancellation during persistence or observation also prevents a subsequent attempt. Dedicated tests assert no additional supplier process or intent.

The AI execution engine remains the existing contained Codex CLI. There are no migrations, billing changes, new supplier calls, UI changes or automatic retries of unresolved calls.

## Synthetic evidence

The [measurement record](issue-56-review-receipt-replay-20261004.json) includes the fixture and environment. The asynchronous pass over 35,269 synthetic records and 40 valid receipts returned true in 35,425.90 ms. A 100 ms timer ran 40 times; its maximum gap, including full initial/final hashes, was 3,272.64 ms. Baseline and asynchronous fixtures use different parse-snapshot profiles, so their total durations are not an identical-fixture speed comparison. The measurements show synchronous timer starvation and the repaired yielding behavior.

Build/contracts and targeted automated checks are recorded with the PR. Tests use synthetic material, a separate PostgreSQL 16.10 container and private database clones; customer data and the existing local M3 database are untouched. Linux MCP tests run from a private Linux-native source/dependency snapshot: initial runs from the Windows-mounted filesystem timed out during process startup, so those failures are retained separately and are not counted as passed checks. Real CLI/provider use, professional result quality and the production project's delivery require separate acceptance.

## Release and task recovery

Deploy the tested release from the resulting `master` SHA through the existing trusted deployment route, preserving the previous image and release record. No database migration is required. Check active runs/model calls before restarting the worker, then record the exact SHA, health/readiness and lease behavior.

For an existing paused call, first inspect its exact owner/project/run, immutable input, attempt, retained private result and supplier evidence. Reuse only verified results with the existing reconciliation rules. Missing output and unknown usage remain missing/unknown; this patch cannot recover a discarded result or authorize an automatic third model call. The local Windows session currently lacks a working trusted SSH route to production, so merge/release and deployment status must be reported separately.

An additional unverified static risk is recorded in the JSON: cumulative CLI stdout has a 4 MiB limit, while the fake MCP fixture omits tool-result bodies. This repair does not adjust that bound or claim that it caused a production failure.
