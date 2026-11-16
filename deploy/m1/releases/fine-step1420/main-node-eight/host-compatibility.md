# Actual host compatibility verification

The first prepare action failed because Docker Compose 2.40.3 `create` does not accept `--no-deps`. The probe contains one service and no dependencies; remove that flag only from `create`, retaining it for real `up` actions.

The second create-only probe found exactly one HostConfig difference: existing Docker metadata stores `OomKillDisable` as null, while Compose emits false. Both retain normal kernel OOM killing. Normalize only null to false in this field before the full HostConfig comparison; true, memory, networking and security-option changes still fail.

All 28 local boundary checks pass. The final real host prepare action created and verified all three stopped probes, removed them, and cleared its owned pending record. No ingress or business container was changed. Earlier failures and the exact sole HostConfig difference are preserved here. Application images, plan, SQL and backup inputs are unchanged.
