# Task-scoped managed retry containment

Status: local implementation and synthetic Linux checks, **not deployed**. This
changes managed task retries, not timeout budgets, task delivery, capacity policy,
or the general scheduler. Follow the [split-deployment runbook](../../docs/runbooks/m1-split-deployment.md)
and the current fixed-source release gates before any deployment.

## Proof and scope

`ManagedRunRetries` tracks exact `(jobId, lease token)` entries. A pending or slow
entry cannot close another claim loop or prevent another entry's release. The
pipeline, assistant and probe claim paths require initialized containment on an
enrolled worker. Unenrolled main/API/parser behavior is unchanged.

Each task attempt has one cgroup v2 subtree. New workflow model calls additionally
open a child subtree bound to the logical call and its attempt generation. Closing
that child seals admission, kills its exact subtree, and proves no pending launcher
or executing descendant remains; the parent remains open for the next chapter and
trusted host tools. Legacy calls keep the original task boundary. Python, OCR, Word helpers, Xvfb/dbus/desktop children and Playwright
use the central native launcher. The immutable Python runner receives one exact
`cgroup.procs` descriptor from the trusted host broker, writes kernel PID `0`,
closes that descriptor, and waits for verified acknowledgment before exec.
The broker never migrates a caller-supplied numeric PID. Chromium uses the same
protocol through an immutable wrapper. `setsid` and init adoption do not escape
cgroup inheritance.

Admission and sealing are serialized. Release requires the sealed cgroup's
`populated=0` plus absence of any same-attempt pre-admission launcher. This is a
presence/absence proof, not an exact process count. Nonexecuting zombies do not
block it. Unreadable inventory, unknown ownership, missing journals, changed
process start identity, replaced cgroups or missing acknowledgments fail closed;
there is no PID-only, process-group or TTL fallback.

The private SQL handoff still checks exact job/token, owner, node epoch, session,
lease expiry and provider reconciliation. Model holders and waiters for that
same job block release, including records in another session; unrelated jobs do
not. The legacy private handoff retains its whole-session check. No public DTO,
market enum, migration, supplier replay policy or billing rule changes.

**Whole-node drain is not task release.** Existing PID-namespace inventory,
native orphan detection, model-holder checks and cloud epoch fencing still
apply. A clean A does not establish that the node or B is idle.

## Restricted host boundary

Only the existing trusted root node adapter prepares and binds the broker.
Docker inspect supplies the actual service init; enrollment context is captured
before the worker-readable envelope is handed to UID 1000. The worker registers
its protected Node executable and exact runtime argv. A restarted/replaced
worker cannot adopt the former worker's release authority.

Authoring and review each mount only their root-owned socket directory read-only
at `/run/bondbuddy/task-cgroups`. Neither receives a host cgroup mount, Docker
socket, extra container capabilities or privileged mode. Both use an init.
The host broker's systemd unit has no `CAP_SYS_ADMIN`; it restricts writes to the
actual service cgroup subtree, private state and per-service socket directory.
Docker/containerd sockets and enrollment configuration are inaccessible to it.
The mandatory named AppArmor profile permits metadata inspection only toward
`bondbuddy-codex-v1`; the worker grants reciprocal `ptrace(readby)` only to that
profile. AppArmor must be enabled and both profiles loaded in enforce mode.
Do not remove that check to make a host pass.

Durable state lives under `/var/lib/bondbuddy/task-cgroups/<session>`. Empty
proof precedes removal; exact retirement is idempotent after a lost reply.
Tombstones prevent an absent/recreated path being mistaken for completion.
Keep these journals across broker restart. Do not garbage-collect an unresolved
epoch by age, delete a cgroup to manufacture proof, or rebind a live worker.
Recovery of unreadable state requires the existing audited node drain/cloud
death and epoch reconciliation path, not a new worker's claim of emptiness.
Archive journals only after that epoch has positively stopped and its retained
leases/provider state have been reconciled.

## Call completion and durable preservation

`call_cgroup_v1` proves only its call is empty. It cannot replace the parent
`task_cgroup_v1` proof for lease release. Parent inventory includes pending child
launchers through their trusted journal parent binding; sealing a parent also
rejects attachment to any open child. Call tombstones forbid reuse of a completed
generation. The runner checks the broker's parent, logical call and generation
binding before business exec.

After that empty proof, Node copies only workspace input/scratch/output and
private response/log evidence into the same persistent volume. File and directory
fsyncs precede the atomic spool manifest. The original session registers this
sealed capture and actual usage before releasing physical model capacity. It
does not mark a timeout candidate provider-completed or settled. Missing proof,
disk failure or failed DB registration retains responsibility and blocks the
affected capacity; ordinary sealed upload-pending evidence does not stop unrelated
task claims. Incomplete captures and `retained-attempt-*` directories pin readiness.

`BB_DURABLE_SPOOL_ROOT` must be a private persistent bind on the same filesystem as
the worker work directory. Defaults are 256 MiB minimum free space and the existing
4096-file/100 MiB-file/512 MiB-total recovery limits. `durableSpoolHealth` separates
sealed pending evidence from unsafe incomplete capture and low disk conditions.
Node drain requires all pending evidence remotely verified and registered.

The spool pump uses `/usr/bin/flock` with a single immutable Node lock keeper;
kernel lock release follows process death, never a TTL. Upload/readback SDK work
runs in children killed and joined after at most 120 seconds, with a five-minute
pass budget and at most three upload attempts. Children have no enrollment, DB
identity or model credentials. The original or separately registered recovery
pool records only exact attempt-bound isolated capture evidence. Remote-verified
captures retry registration without re-uploading; GC requires a recorded remote
capture and successful registration. Do not delete incomplete markers or retained
directories to manufacture an empty-node receipt. Their recovery requires actual
native termination/fencing and a separately verified preservation handoff.

## Existing and future nodes

1. Fix the source/tree and affected component images/configurations through the
   normal release gate. Record actual service versions, manifests and rollback
   preimages. No production change was performed for this implementation.
2. Drain the affected authoring/review services and prove whole-node quiescence;
   stop their containers and brokers before replacing their launch boundary.
   The installer and adapter refuse active or unobservable prior brokers.
   This is not a hot rebind or an in-place adoption of surviving native work.
3. Preinstall compatible immutable worker images and the reviewed host helper
   bundle. A source overlay alone is insufficient: the image needs the immutable
   runner/wrapper, real Chromium target, compiled task protocol, public helper
   assets, Compose and worker AppArmor profile. The adapter verifies exact image
   identity first, then runs an isolated UID-1000, no-network, cap-dropped image
   preflight. Old/missing/incompatible assets reject startup.
4. Update existing nodes **and** future creation templates. The bounded public
   bootstrap creates, but never starts, a container from the locally installed
   immutable authoring image, copies only fixed public assets, verifies every
   file hash/type, and removes that exact container. It does not pull an image
   or read credentials. The existing 16,384-byte cloud-init bound is unchanged.
   Supported predecessor hashes are explicit; unknown preimages require a
   separately reviewed migration rather than bypassing the hash check.
5. The installer saves `.before-task-cgroups-v1` preimages of replaced code,
   configuration and profiles. Interrupted replacement remains fail closed:
   pins are checked before startup and partial installation is not success.
   Retained warm-launch bytes intentionally remain immutable; an old retained
   launch does not automatically acquire this fix. Reconcile its node/template
   pins explicitly or replace it with a new reviewed launch.
6. Validate actual socket ownership, broker confinement, runtime registration,
   cgroup membership, task-specific retry and whole-node drain before reopening
   affected admission. Rollback also requires drain, compatible paired
   code/image/profile/configuration preimages and normal version checks. Do not
   replace the whole Azure host or widen application permissions.

## Reproducible local checks

Build with the repository's existing declaration workaround:

```powershell
npm run build -w @bondbuddy/worker -- --declaration
npm run build -w @bondbuddy/api -- --declarationDir .types-validation
node --test deploy\tencent-elasticity\task-cgroups.test.mjs deploy\tencent-elasticity\node-images.test.mjs deploy\tencent-elasticity\warm-bootstrap.test.mjs deploy\tencent-elasticity\bootstrap-warm-entry.test.mjs
```

Use an already available local worker image with Node, Python, Playwright and
the repository dependencies, plus local `postgres:16`. Build the **test-only**
image using `task-cgroup-test.Dockerfile` and its allowlisted context; it is not
a production release image. In a disposable Linux host with root, Docker,
writable cgroup v2 and systemd:

```sh
docker image inspect "$BASE_IMAGE" >/dev/null
docker build --network none --pull=false --build-arg BASE_IMAGE="$BASE_IMAGE" \
  -f deploy/tencent-elasticity/task-cgroup-test.Dockerfile \
  -t bondbuddy-task-cgroup-test:local .
BB_TASK_CGROUP_TEST_IMAGE=bondbuddy-task-cgroup-test:local \
BB_TASK_CGROUP_TEST_DATABASE=1 BB_TASK_CGROUP_TEST_SYSTEMD=1 \
python3 -B deploy/tencent-elasticity/task-cgroup-broker.test.py -v
docker run --rm --pull never --init --network none --read-only \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint node bondbuddy-task-cgroup-test:local \
  --test apps/worker/dist/managed-run-retries.test.js
TASK_TEST_IMAGE_ID="$(docker image inspect --format '{{.Id}}' bondbuddy-task-cgroup-test:local)" \
node --input-type=module -e "import {verifyTaskExecutionImage} from './deploy/tencent-elasticity/node-adapter.mjs'; await verifyTaskExecutionImage(process.env.TASK_TEST_IMAGE_ID);"
```

The fixture creates and cleans up named disposable containers, an internal
database network, isolated databases, cgroups and transient systemd units.
Its synthetic protected runtime uses current compiled code, never production
credentials, provider calls or business data. Temporary SQL copies normalize
CRLF for the existing migration chain; no historical migration is edited.
Run `apps/worker/dist/managed-run-retries.test.js` as the sole Node test entrypoint
in its own Docker PID namespace with current worker/API/package output mounted
read-only. `docker exec` beside unrelated tests is not equivalent drain evidence.

Local evidence: worker/API builds and 16 deployment regressions passed; seven
dedicated Linux retry/drain tests and seven cgroup/database fixture checks passed
with zero skips. Real cgroup tests cover
multiple calls, setsid/init orphans, identity/restart fencing, independent tasks,
admission descriptor closure and fail-closed inventory. The PostgreSQL fixture
exercises the actual two-slot pipeline/runtime, same-job holders/waiters and
concurrent exact lease release/claim. The systemd option exercises the restricted
filesystem/capability/namespace sandbox, with a test-only bind for disposable
`/tmp` state.

**Remaining release conditions:** local WSL has AppArmor disabled and no parser,
so AppArmor syntax/loading and real enforcing-profile compatibility are not
validated here. The synthetic image preflight does not replace a complete
production worker-image build or the fixed-tree real-model/quality release gate.
The full cloud-init installer has not been applied to a cloud seed image. These
checks, existing-node/template migration and production symptom acceptance
remain required; do not treat Windows skips or local fixture success as deployment
or user acceptance.
