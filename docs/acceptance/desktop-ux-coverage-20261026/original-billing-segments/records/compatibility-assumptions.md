# Billing compatibility assumptions found by bounded source scan

Read-only inventory at base 05155d3d, 2026-10-27. No PG/build/test was started. This list excludes test fixtures and historical acceptance copies.

## Current execution meter/debit paths (root ownership)

- apps/api/src/authoring-credit-debit.ts:8: debitAuthoringCredits selects only run.reservation_id.
- apps/api/src/authoring-progress.ts:20/46: meter insert/read/update by run_id, and reservation/policy from the original run pointer.
- apps/api/src/queue.ts:149/193: activity timestamps update bb_authoring_progress by run_id; :615: finish drains the run reservation to its cap.
- apps/api/src/server.ts:1341: credit-charge combines the original credit quote with progress. This must not accidentally combine a V1 quote with V2 price progress.
- apps/api/src/m4-billing.ts:166: readM4CreditCharge similarly reads original M4 quote/state then current progress. :140/148: settleM4Metering selects original run reservation and, for metered tasks, assumes one run quote.
- apps/worker/src/m4-method.ts:12: m4PinnedModelGate reads by reservation.run_id. It only runs for metered M4, which must remain outside fixed-document rework authority or use an explicit selector.

## Original fee creation (keep original policy and provenance)

- apps/api/src/billing.ts:72: reserveCredits (M1/review), one original credit quote and one run pointer.
- apps/api/src/m4-billing.ts:99: reserveM4, original M4 quote and one run pointer.
- apps/api/src/project-file-billing.ts:23, integrity.ts:33, project-qa.ts:54: unrelated original fixed-fee reservations. These task types must remain unable to create supplement segments unless their joins are adapted deliberately.
- db/migrations/0087_m2_fixed_credits.sql:25: bb_credit_reservations.run_id UNIQUE and positive points; :45: bb_runs.reservation_id.
- db/migrations/0103_authoring_progress.sql:6: bb_authoring_progress PK(run_id).
- db/migrations/0091/0112/0113/0115: immutable quote-type reservation guard only recognizes existing original quote families.

## Historical/operational views (this agent ownership)

- apps/api/src/billing-ops.ts:8 correctSettlement chooses rows[0] from reservations by run_id; with multiple fees this becomes ambiguous. Proposed compatibility: optional explicit reservationId; omitted remains valid only for a single-reservation run. Select after locking the account so concurrent segment creation cannot change the ambiguity check mid-operation. Keep correction keys scoped to the exact reservation and original lot.
- apps/api/src/billing-ops.ts:27 auditCredits assumes every audited reservation is run.reservation_id and its quote is bb_credit_quotes. Proposed: validate original-pointer mapping separately from segment mapping, then audit every fee independently against its actual quote source, ledger and policy. Gross debit/settle history remains intact after separate compensation credits.
- apps/api/src/credit-history.ts:27 consumptionHistory already selects and paginates reservations by immutable microsecond(created_at,id), so it can retain one history row per charged authority without new public required DTO fields. Resolve input/name/task from each bound segment, label new fee as supplement rework, and avoid multiplying rows when a zero-additional execution reuses the same fee.
- apps/api/src/data.ts:99 runDto exposes reservation_id. Keeping this as the original fee pointer is compatible only if current-execution fee resolution is explicit elsewhere.
- apps/web/src/credit-history.ts:43/52 already uses reservation_id as the stable row key; preserving that key avoids public UI changes.

## Joins/guards that must remain explicit

- apps/api/src/integrity.ts:70 and project-qa.ts:82 LEFT JOIN reservation by run_id; safe only while these run types cannot acquire more than one payable segment.
- apps/api/src/m4-workspace.ts:284/507 reads the original reservation policy to hide dynamic deliveries before success. Since original policy is preserved for new segments, this static policy check can remain; it must not be used as the current amount/segment selector.
- apps/api/src/run-supplement-quote.ts:93 reads original paid source by run.reservation_id, correctly preserving original category. db/migrations/0137_run_supplement_quotes.sql:151 currently instead SELECTs reservation by run_id; changing uniqueness requires making that SQL guard match the exact original run pointer.
- apps/api/src/run-supplement-adopted-scope.ts:35 and run-supplement-test-adoption.ts:43 reject paid state. 0135/0136 internal non-production functions also reject any reservation/nonzero meter. Keep these test gates intact and add distinct production billing authority.
- apps/worker/src/integrity-input.ts:17 and project-qa-input.ts:23 validate their original quote by run_id. They remain outside supplement scope.

## Minimal internal selector data needed

Complete execution identity; segment/fee identity; reservation ID or explicit zero/no-extra result; original vs B1 quote source; source original quote ID and supplement quote/confirmation IDs; immutable points ceiling; unchanged billing policy; and the fee/meter identity reused by zero-additional continuation. Historical joins need a stable one-to-one fee mapping rather than one-to-many execution rows.

Public consumption-history DTO fields can stay unchanged: each fee already has reservation_id, task_name, gross charged/released/corrected totals and policy. Additional private segment/quote identities must not leak accidentally through the whitelist mapping.
