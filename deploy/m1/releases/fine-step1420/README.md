# Fine-step timing release

PR #1428 carries the PR #1420 timing changes on the current managed execution runtime. The feature is already merged into develop. The release branch incorporates master 325c88248a41b33fccbb31d8262b57dab41d6659, including eight executions per node and retained warm-start bindings. Preserve node/global limits 8/8 and at most two nodes.

## Current main payload

The frozen component sources in recipe.json retain their exact prior meaning. main-node-eight/manifest.json adds only the current eight-slot batch admission, execution-capacity contract and the combined contracts index to the previously verified main API image. The built API is sha256:e995a4928f4ec16048ac6b5c5cc136bf9582baf758bc71361cb08e20f4a9eb85. Ops and web reuse their verified logging candidates. Main API absorbs its thirteen current code mounts; ops preserves all current mounts, including the latest review dependency installer repair. Actual configuration and target hashes are checked at the cutover. The main and worker deployments are reported separately.

The observed ledger contains 188 migrations, including 0188. Apply only canonical 0185_performance_spans.sql (SHA256 20f7e159dca10fc86137f03e93d79a073c1787b4e6455693314a4f0d83dc347b), then the separately pinned managed-performance-grants.sql. The resulting ledger has 189 entries. Existing business tables and queued tasks are not rewritten. Main rollback restores its observed containers and leaves the additive telemetry schema in place.

The database was backed up off host and fully decoded without a production restore; the safe receipt is main-node-eight/offhost-backup-summary.json. The private backup itself is not in Git. Downloaded apt package cache was cleaned to preserve the two-GiB server disk floor; no package or service was changed by that cleanup.

## Managed execution payload

The earlier managed/ directory preserves the original OCI build, regression and failure evidence. Those candidate images were prepared but not deployed. The current delivery uses the existing controlled business bootstrap with a new exact role-specific logging descriptor, retaining system image img-6cnm1flv and the installed original OCI images. The updated archive carries the entire required logging closure separately for authoring and review, preserving the current node-eight business changes and its review import repair.

The current warm node retains immutable creation and epoch evidence. A new overlay in the control configuration alone does not install its host helper. Its actual update requires a valid maintenance path or a new node admitted through the existing capacity controls. No IAM policy or runtime cloud-action allowlist is widened to obtain that access. Final node installation and live trace collection require their own positive evidence.

See deployment-authorization.md for the current instruction and validation limits. No real-model golden acceptance, independent human signoff or standard full-quality release receipt is claimed.
