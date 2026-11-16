# Fine-step timing deployment backport

This directory carries the narrowly selected deployment changes from master PRs #1428 and #1457 back to develop. It does not merge a complete API/worker runtime or replace develop's newer recovery and artifact changes.

## Status

The main API/ops/web release is deployed; authenticated performance summary/run reads were verified. The managed worker timing payload has **not** been installed on the current worker. See [the production receipt](main-node-eight/live-deployment-20261116.md) and [the final read-only main health check](main-node-eight/postdeploy-main-readonly-20261116T072626Z.json). No production action runs as part of this backport or its tests.

## Reproduce the checks

From the repository root, with Node.js 22+ and Python 3.11+:

```sh
node --test deploy/m1/releases/fine-step1420/managed-node-eight/helper.test.mjs deploy/m1/releases/fine-step1420/managed-node-eight/bootstrap-encoding.test.mjs
python3 -m unittest discover -s deploy/m1/releases/fine-step1420/main-node-eight -p 'test_*.py' -v
```

On Windows, set `PYTHON` to the installed Python executable for the Node test's syntax-only check. Tests directly import the current `deploy/tencent-elasticity/bootstrap.mjs` and `business-overlay.mjs`. They make no network, Docker, database or model calls. The main adapter is imported without executing its production entry point; all I/O in the boundary/driver tests is synthetic.

## Selected changes and evidence

- `bootstrap.mjs` compresses the same public Python installer as one bounded Brotli stream. Both actual slot manifests are 15,904 bytes, within the unchanged 16,384-byte cloud limit. Tests compare all decoded installer operations and payload bytes, reject malformed/oversize input, parse the actual Python wrappers, and preserve retained warm bytes.
- `business-overlay.mjs` accepts only the 40 authoring and 23 review paths in the new performance descriptor. It verifies all 66 tar members, including the three existing SQL files, and preserves the earlier four/eight-slot formats and read-only compose mounts.
- `managed-node-eight/overlay.tar.gz` is the previously validated, hash-bound release/test fixture. It is not automatically extracted or activated by this backport. The original Node 22.23.4 OCI import receipt is retained as historical evidence, not claimed as a fresh run here. `payload-provenance.json` describes the original source-to-payload selection.
- `main-node-eight/main-cutover-adapter.py` and `run_main_cutover.py` are byte-identical to the source used by the successful production release. The create-only probe uses the host-supported Compose flags; only the proven `OomKillDisable` unset/null/false equivalence is normalized. Full other HostConfig, ownership, lock and migration outcome checks remain.
- The synthetic main plan contains no real environment, credentials, mounts, backup receipt or deployable paths. It exists only for repeatable tests. Executing a production release still requires a fresh, authorized, exact bound plan and backup outside Git.

The `boot-reference` files preserve the original installer encoding for equivalence checks. Legacy archives and descriptors are compatibility fixtures. Hash-bound fixture bytes preserve their original line endings, and the five public bootstrap inputs use LF across checkouts. The fixture directory permits CR at end of line in Git whitespace checks while retaining the other normal whitespace checks.
