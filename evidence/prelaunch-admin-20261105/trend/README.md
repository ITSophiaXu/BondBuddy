# Administrator trend regression (2026-11-05)

Base: develop@3bb7baf12dba1c75465e9c5dd71ef7b073c176a9. All fixtures are synthetic. No real model or payment is called.

The chart now contains inclusive UTC calendar dates, defaults to 14 dates anchored to the requested end or current day, and displays at most the last 90 dates. Summary and paginated details retain the full filter. The page labels actual first/last dates, calendar-day denominator and capped window; idle dates do not produce activity bars or measured-zero costs. The existing daily schema, including maxItems90, stays unchanged.

| Round | tests/pass/fail | Meaning |
|---|---|---|
| pg-before-fix | 7/0/7 | Username fixture SQL23514 before product assertions; not a product bug. |
| pg-before-fix-fixture-corrected | 7/0/7 | Seven real product assertion failures on unmodified 3bb API. |
| pg-after-fix | 7/7/0 | First fixed-product PG pass; final test source later strengthened. |
| api-units-after-fix | 10/10/0 | Final API source/unit pass. |
| page-units-after-fix | 12/12/0 | Final page source/unit pass. |
| ci-admin-final | 17/17/0 | Final seven PG plus ten API tests and exact new workflow TAP guard. |

Every round has cancelled/skipped/todo=0. Overlapping rounds are not added together. Final PG evidence is ci-admin-final, which binds the strengthened PG source (nonzero excluded owner/state/date usage and settlements, long-window daily totals). Each log has execution metadata, source/dist SHA256 and raw-log SHA256. results.json verifies all eleven final source/dist/workflow bindings against successful rounds and also records LF-normalized source hashes.

Required PG outcomes: 14 sparse dates and historical-to anchoring; 90/91/120-day summary and paginated detail completeness with schema-valid bounded series; identical UTC midnight task/credit dates under Asia/Shanghai and UTC sessions; distinct runs/users with duplicate provider/framework usage and multiple settlements; empty and unpriced costs remain null. Page units verify 3 active-user-days over 14 calendar dates renders 0.2, actual date range, cap disclosure and absence of zero-height activity proxies.

PostgreSQL16.14 used the existing private 168-migration template. All automatic clones were gone and other clients=0 before smart stop; stop exit0, status exit3, TCP ECONNREFUSED. The initial pg_ctl start failed with Windows restricted-token87; the existing native postgres binary started the verified loopback instance. See postgres-lifecycle.json. No Azurite was started.

The .github/workflows/m2-credits-pr.yml step is new and keeps the existing billing group unchanged. ci-admin-final is local Windows/Node26 evidence; GitHub Actions/Linux, live production operator data, real merchants/models and professional acceptance remain separate. No commit or staging was performed by this agent.
