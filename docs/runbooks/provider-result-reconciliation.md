# Provider result reconciliation (internal #17/#16 seam)

This procedure is for an authorized service maintainer handling a run paused at `provider_reconcile`. It describes the internal persistence seam in migrations 0004, 0005 and 0007. There is currently **no production reconciliation CLI or API route**; execute, cancel and resume remain `501 CAPABILITY_NOT_READY` until the live provider, #79 logging and checked Word delivery release gates pass. Do not invoke an ad hoc production script or edit database rows to work around that gate.

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
| Request state, result validity, Blob hash/schema, or usage is missing, unknown, conflicting, or inconsistent | Preserve all observations and candidate references; leave the attempt pending and run paused. Escalate to the provider/release owner with safe identifiers and hashes only. | Do not resume or resend. Do not delete or overwrite evidence to force a single candidate. |

The code validates owner/project/run/job/attempt bindings and the referenced Blob bytes before recording a completed observation. The result reference is content-addressed and immutable. A transaction or outbox failure rolls back the observation, usage, checkpoint and run transition together; after the failing dependency is repaired, retry the same reconciliation evidence idempotently. Conflicting result hashes and conflicting #79 usage remain pending for manual resolution; this slice does not select a winner or expose a public repair endpoint.

## Verification and release limits

- After recording a completed result, confirm one immutable result reference, one matching completed/measured observation, zero usage conflicts, and a checkpoint reference for the same attempt. Check Blob size and SHA-256 through the service without displaying the result bytes.
- After a restart, confirm the worker validates and reuses the checkpointed result and the supplier-send counter does not increase. An attempt with no reusable checkpoint must raise reconciliation-required and must not fall through to send.
- Confirm the Word delivery gate independently: a run cannot succeed unless an owner-bound artifact version has passed quality checks, is available, and its Blob hash is verified. Provider-result reconciliation alone never constitutes run success.
- Tests use an explicit synthetic transport and synthetic JSON only. They do not prove a real DeepSeek request, model identifier/protocol compatibility, real usage reporting, production credentials, Word quality, or full #17/#16/#79 acceptance. Keep production execution disabled until those gates and an authorized operational entry point are reviewed and enabled.
