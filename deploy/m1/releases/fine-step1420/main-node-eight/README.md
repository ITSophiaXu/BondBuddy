# Main-only cutover source

These two production scripts are extracted unchanged from the #1457 package (`aa1da9be0c08677d4cdd10634689ddd7394c02c335ba83ef04798e6de0c89070`). `source-selection.json` pins their hashes.

`main-plan.synthetic.json` is deliberately not a production plan. The tests replace the production plan with this minimal fixture and remove one unused local path. All 28 assertions retain the production boundary/rollback behavior, including continuing existing worker leases and accepting an unchanged live budget.

The 0185 SQL and telemetry ACL are original release inputs, not executed by tests. No existing migration is changed. Historical real-host prepare results are under `evidence/`; the final deployment receipt distinguishes the deployed main services from the uninstalled managed-worker payload.
