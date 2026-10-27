# Next connected work toward the original UX goal

The preceding goal turn made progress: canonical V1 fee identity, execution assignment and meter now drive actual debit/progress/finalization/history/audit. This is not completion of B1 or G03. B1 is already decided by the user; do not ask B/B1/B2 again.

Next implement actual successor billing/adoption rather than another V1 metadata-only slice. Retain the original run reservation pointer. Introduce rework and zero-additional assignments with exact confirmation/receipt/plan/candidate identity. Relax one-reservation and one-binding constraints only alongside the corresponding authority and lifecycle checks.

- Positive rework: original spent fees remain under their original policy; closing the original segment must not collect its unused full-price tail or recalculate/refund its historical work automatically. Give the accepted B1 rework its independent cap, reservation, zero-based meter, allocation/event keys, and failure/refund scope.
- Zero additional: no zero-point reservation, no waiver of the remaining original fee, and no new charge row. Bind the new execution to the existing fee and meter with explicit immutable authority.
- Adopt atomically: exact confirmed quote plus byte-verified preparation, source fee closure/carry, target execution/billing binding, head CAS, fresh stage/checkpoint and queued state. Confirmation alone must not create debit authority. Preserve complete lost-response/idempotency behavior.
- Keep 0135/0136 test paths intact; add a separate production authority recognized by assertRunExecution, call/prompt/artifact/working-file/Word delivery and finalization guards. Reuse actual three worker request paths already proven for internal successor execution.
- Update quote/charge display and history to reflect the relevant fee and clear additional amount. Wire the existing desktop preparation panel to quote, exact confirmation and same-run adoption/resume; recover expired/stale quote, insufficient funds, lost receipts and refresh safely. No dead-end confirm button.
- Prove the public desktop chain with real HTTP/PG/private synthetic bytes and actual worker stages, including new Word download and original-history byte preservation. Do not substitute isolated metadata tests for G03; old 15/15 and 662 counters stay separate.

0138 still hard-limits segment/assignment to original V1 and retains all paid successor gates. Relevant current source is run-billing-segment.ts, authoring-credit-debit.ts, authoring-progress.ts, queue.ts, billing-ops.ts, credit-history.ts and migration0138. Old finalizers are still financial compatibility paths; the next lifecycle must explicitly scope their effects to fee segments.

Database is stopped. Final migrated reusable test template is bb_segments_final02_20261027 on the task-owned cluster in .local/test-successor-postgres/data (137 migrations). The hidden-controller startup script avoids the prior inherited-pipe wait; inspect current process/port before starting. Never restart based solely on a wait timeout.
