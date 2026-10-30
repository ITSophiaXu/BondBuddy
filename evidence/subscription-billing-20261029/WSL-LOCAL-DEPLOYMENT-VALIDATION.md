# WSL local deployment validation

2026-10-29. Local synthetic validation only. No merchant configuration was read, no merchant request was sent, and no existing container or volume was started, stopped, or modified.

## Runtime established

The earlier restricted-shell WSL enumeration returned `E_ACCESSDENIED`; that was a permission limitation of that invocation, not evidence that Docker was absent. The explicitly approved WSL invocation confirmed the existing `BondBuddyM3` distribution and these runtimes:

- Docker context `default`, endpoint `unix:///var/run/docker.sock`.
- Docker Engine 29.1.3, Ubuntu 24.04.5 LTS, Linux x86_64.
- Docker Compose 2.40.3.
- Native WSL Node v24.14.0; Python 3.12.3.
- Initial image cache: `postgres:16.10` and `mcr.microsoft.com/azure-storage/azurite:3.35.0`; twelve existing containers were stopped. No API, worker, or Node 22 release image was cached. Build cache was empty and buildx was unavailable.

## Actual Compose execution

The validator executed the installed `docker compose config --format json`, using an explicit empty synthetic env file, a separate empty Docker configuration directory, the local Unix daemon endpoint, and an allowlisted child-process environment populated only with synthetic placeholders. It did not load a real `.env`, use `up`, `build`, `pull`, or persist/print the resolved JSON.

All **24/24 cases** had the expected outcome, with **13 payment-deployment checks per case**:

| Configuration | Both channels off | WeChat on | WeChat + Alipay + statements/refunds on | Missing WeChat host | Missing Alipay host | Merchant in NO_PROXY |
|---|---|---|---|---|---|---|
| Base + staging-blob profile | Pass | Pass | Pass | Rejected | Rejected | Rejected |
| Base + prod | Pass | Pass | Pass | Rejected | Rejected | Rejected |
| Base + prod + integrity-browser | Pass | Pass | Pass | Rejected | Rejected | Rejected |
| Base + prod + integrity-beijing | Pass | Pass | Pass | Rejected | Rejected | Rejected |

The base configuration is explicitly tested with its `staging-blob` profile. Without that profile, Compose omits the Azurite service while the base default `NO_PROXY` still includes `azurite`; the conservative deployment checker rejects `api_internal_proxy_bypass`. Production overlays remove Azurite from the default bypass list and pass. This was an actual Compose/profile difference that the earlier manual YAML merge had not exercised.

## Native Node HTTPS proxy probe

The independent probe starts an HTTPS origin and recording CONNECT proxy on loopback only. Its self-signed certificate is generated solely for this test and trusted using `NODE_EXTRA_CA_CERTS`; TLS verification remains enabled. Fetch has a two-second timeout and each child process has a ten-second hard limit.

Native WSL Node v24.14.0 passed all four assertions:

1. HTTPS fetch traversed the recording proxy using CONNECT.
2. An unreachable proxy rejected the fetch without reaching the directly reachable origin.
3. Loopback `NO_PROXY` bypassed the proxy successfully.
4. The synthetic HTTPS certificate was validated normally.

Observed counts: one CONNECT and two successful local origin requests. External requests: zero. The broader existing compiled library test entry did not complete within a 45-second bound in this WSL-mounted checkout; it is not counted as passed. The independent bounded probe above supplies the recorded behavior evidence.

The Docker container, image, volume, and network inventory digest was unchanged across the successful configuration/proxy run. The matching before/after digest is in `WSL-LOCAL-DEPLOYMENT-VALIDATION.log`.

## Scope remaining

This verifies the actual Compose interpolation/merge and the native WSL Node runtime. The exact API release image was subsequently built and passed its own Node v22.23.4 proxy probe; see `RELEASE-API-LOCAL-VALIDATION.md`. This document does not verify application container startup/shutdown, Squid runtime egress, production HTTPS callbacks, merchant product eligibility, live signing/queries/refunds/statements, or external-account automatic renewal. No merchant enablement follows from this evidence.
