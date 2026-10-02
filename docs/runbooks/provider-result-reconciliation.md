# Provider result reconciliation (internal #17/#16 seam)

This procedure is for an authorized service maintainer handling a run paused at `provider_reconcile`. It describes the internal persistence seam in migrations 0004, 0005 and 0007. The private `deploy/m1/scripts/reconcile-run.sh` command runs in the ops service; it does not expose an HTTP route. Do not edit database rows to work around the run state machine.

## Private command

### M1 unified authoring timeout recovery (2026-10-02)

The user's M1 requirement is to continue from supplied material without asking the user to unblock technical processing. The runtime now automatically disposes **only a recorded, locally terminated `MODEL_TIMEOUT`** in a `unified_v1` input / `unified-v3` logical call. It requires exactly one unresolved attempt, a closed CLI process with no tool attempts, matching timeout observation, unknown usage, no result reference, no contradictory observation, no newer attempt, and no active lease. Missing runtime evidence, crashes, cancellation, result/usage conflicts and legacy runs keep their reconciliation path.

The transaction records `terminated_timeout_auto_retry` in the existing disposition checkpoint and outbox, keeps original usage unknown, and queues the same run/input. Previous completed results are reused. This is authorization for another bounded attempt, **not evidence that the supplier never received the previous request**. Each logical call allows two automatic retries, with six across the run; exhaustion records a truthful `MODEL_TIMEOUT` failure instead of an indefinite pause or unlimited model calls. New attempts retain the usual authorization, trial, evidence and isolation checks. Word delivery checks are unchanged.

No database migration, new API or timeout/model setting change is needed. Operators can inspect the retained evidence with the private command below. A known timeout recovered by this policy does not require re-uploading materials or a new input revision.

From the deployed checkout, run `deploy/m1/scripts/reconcile-run.sh list`. It prints paused run IDs, owner, channel, pending attempt IDs, logical call IDs, failure codes, start times, and known usage fields. Check the selected run and attempt against supplier evidence before deciding.

Use `deploy/m1/scripts/reconcile-run.sh resolve <run_id> <attempt_id> retry_unknown_usage <reason_code>` only when a valid result cannot be recovered and an additional call is authorized. This keeps the original usage `unknown` (never zero), records the OS account and reason with the run event and outbox, and queues the run for a fresh attempt. It may consume additional tokens. If a result reference or non-unknown usage exists, this decision is refused; complete reconciliation of that evidence first. The worker still checks its ordinary external-call gates before sending.

Use `deploy/m1/scripts/reconcile-run.sh resolve <run_id> <attempt_id> fail_run <reason_code>` to end the run as `failed` with `DATA_UNAVAILABLE`. The checkpoint and original call evidence remain queryable. Repeating the same decision and reason is idempotent; a different decision for the same attempt is rejected. Reason codes are short lowercase identifiers such as `supplier_history_unavailable`; avoid customer content. The command derives the owner from the locked run and requires the attempt to belong to its job.

## Triage and evidence

1. Use the restricted service identity to identify the run and attempt by the full tuple: owner, project, job, run, `logical_call_id`, `attempt_no`, and `call_id`. Confirm the run and job are paused for provider reconciliation and that the attempt is still unresolved. Derive the owner from trusted authorization; never take an owner ID from an untrusted client request.
2. Consult the supplier's authorized request history using the recorded `provider_request_id` and the approved account. Establish whether the request was definitely not sent, completed with a valid result and complete measured usage, definitively failed with measured usage, or remains unknown. Network timeout, missing response, missing usage, and disagreement between usage sources are not proof that the request was not sent.
3. Keep the original attempt and evidence immutable. Do not print or copy credentials, prompts, supplier response bodies, or customer content into a terminal, logs, Issue comments, or chat. Record only safe identifiers, result hashes, schema version, usage status and error codes in operational notes.

## Permitted outcomes

| Verified evidence | Internal handling | Retry/resume policy |
| --- | --- | --- |
| Request definitely was not sent | Append `confirmed_not_sent` for the exact attempt with no result reference or supplier request ID. | Only an explicit resume may proceed, and the sender must allocate the next attempt number. Never reuse the not-sent attempt ID. |
| Completed response, versioned result schema valid, result Blob available and hash checked, usage complete and non-conflicting | Store the JSON result in the private Blob container with `persistProviderResultObject`; append the exact observation with `reconcilePausedProviderCall`. The database transaction binds the result, usage, observation, checkpoint, run event and outbox to the same owner/project/job/run/call/attempt. | After an authorized resume, the processor must use `reuseProviderCallOrSend` (or an equivalent checkpoint reader) to revalidate the result and return it without another supplier request. |
| Definitive supplier failure with complete, measured usage | Append a `failed` observation with no result reference. This atomically fails the run. | No automatic retry. A later authorized retry is a new run under the applicable product policy. |
| Request state, result validity, Blob hash/schema, or usage is missing, unknown, conflicting, or inconsistent | Preserve all observations and candidate references. An authorized maintainer may explicitly choose `fail_run`, or `retry_unknown_usage` when usage is unknown and no result reference exists, after reviewing the risk of duplicate model work. | No automatic resend. A retry creates a new attempt and retains the original unknown usage. |

The code validates owner/project/run/job/attempt bindings and the referenced Blob bytes before recording a completed observation. The result reference is content-addressed and immutable. A transaction or outbox failure rolls back the observation, usage, checkpoint and run transition together; after the failing dependency is repaired, retry the same reconciliation evidence idempotently. Conflicting result hashes and conflicting #79 usage remain pending for manual resolution; this slice does not select a winner or expose a public repair endpoint.

## Verification and release limits

- After recording a completed result, confirm one immutable result reference, one matching completed/measured observation, zero usage conflicts, and a checkpoint reference for the same attempt. Check Blob size and SHA-256 through the service without displaying the result bytes.
- After a restart, confirm the worker validates and reuses the checkpointed result and the supplier-send counter does not increase. An attempt with no reusable checkpoint must raise reconciliation-required and must not fall through to send.
- Confirm the Word delivery gate independently: a run cannot succeed unless an owner-bound artifact version has passed quality checks, is available, and its Blob hash is verified. Provider-result reconciliation alone never constitutes run success.
- Tests use an explicit synthetic transport and synthetic JSON only. They do not prove a real DeepSeek request, model identifier/protocol compatibility, real usage reporting, production credentials, Word quality, or full #17/#16/#79 acceptance. Keep production execution disabled until those gates and an authorized operational entry point are reviewed and enabled.
