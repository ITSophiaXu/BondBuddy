# Windows billing host adapter

`windows-billing.mjs` executes the original `scripts/billing-functional/panel-session.test.mjs` in the gate's fresh Windows checkout. The generic dispatcher supplies its in-memory candidate/plan entry; this adapter does not accept a container's commands, paths or environment.

The host supplies an existing, matching `dependencyRoot` and an already-created private `evidenceRoot`. Dependencies are not installed on Windows. The root lock may differ only by CRLF; product workspace links must resolve into the current candidate, and Vite scratch data stays in its own directory. Raw tracked Git bytes are checked before and after the run. All seven required dependency/API/web builds run again on that checkout; an older build or receipt cannot substitute for them.

The adapter requires the existing Node 22+, Git, Edge, current local Docker Desktop Linux engine and local `postgres:16.10` image. It creates a private PostgreSQL bridge with a conflict-checked subnet and exactly one `127.0.0.1:55432` binding. The product test server retains its original loopback ports 5189/3089, database marker and orderly start/stop scripts. A real Windows-to-PostgreSQL probe runs before startup. No system route, TLS trust, installed software, production database or real payment/model service is changed.

The test remains a complete, unfiltered file with its original 90-second deadline, bounded by the original gate file budget. Return values contain its original stdout, stderr, exit, timeout and duration. Build/provision/cleanup failure throws with execution/evidence attached, and cannot become a passing result. Child processes receive a small host environment allowlist. On cancellation, only the adapter's own command process tree is stopped; cleanup still uses the original instance-bound stop endpoint. A service that cannot be confirmed stopped keeps its PostgreSQL available and blocks the gate.

Evidence records each actual command and output hash, exact candidate commit/tree, raw source manifest, resources and absence checks. The owned container and network are removed after the service exits. Its stopped synthetic database volume and local runtime remain for diagnosis; no original report is overwritten, no global prune is used, and no production acceptance is implied.

Pure regression command:

```sh
node --test scripts/pr-gate/host-adapters/windows-billing.test.mjs
```

This adapter is a capability implementation. Only its execution inside the same candidate's complete gate can count toward that candidate's gate receipt. The earlier standalone billing probe on `867dbb22` remains auxiliary evidence.
