# Exact API image: local build and HTTPS proxy validation

2026-10-29. Local isolated acceptance only. No application deployment, merchant login/request, customer payment, production service, or existing data volume was involved.

## Verified artifact

| Item | Observed value |
|---|---|
| Source commit and runtime `BB_RELEASE_SHA` | `279f13a0f086ca1048b38058fcc94703763f8b5a` |
| Dockerfile / target | Unmodified committed `deploy/m1/Dockerfile`, target `api` |
| Local tag | `bondbuddy-billing-api-local:279f13a0f086-20261029` |
| Exact image ID | `sha256:1ecf1c3b12966ffa986716dfdde891d1d31b25f2bcdfa20fde4061c780d421d2` |
| Runtime Node | `v22.23.4` |
| Official base | `node:22-bookworm-slim` |
| Recorded base digest | `sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da` |
| Build result | Exit 0; 7 minutes 39 seconds; no timeout |
| Probe result | Exit 0; four assertions passed; source SHA matched |

The build used the existing local Unix Docker daemon inside `BondBuddyM3`, with an empty isolated Docker configuration directory. Its allowlisted context contained **1,746 exact Git files, 30,528,623 bytes**. The manifest records each path, Git blob ID, size, and SHA256. Included data assets were only the checked-in product templates and public knowledge assets required by the release Dockerfile. No real `.env`, private credentials, customer/sample/upload/attachment directories, runtime state, dependency directories, or working-tree output was included.

The original legacy builder was used because buildx was not installed. Therefore the original Dockerfile's preceding Codex intermediate stage also ran; its pinned package-integrity and version assertions passed. The build stopped at the API target and did not build the worker, browser, OCR, LibreOffice, or Python runtime stages. The final API image includes the existing worker JavaScript dist as defined by `node-runtime`; it does not include `/app/scripts/local-integration` from the build stage.

The full workspace TypeScript build, Web production build (531 modules), and pinned SSE candidate-asset integrity check passed inside the build. The candidate check's existing `candidate_only` status and open coverage blockers are not an authorization to enable a product capability. Vite emitted its existing large-chunk advisory; it did not fail the build.

## Exact-image network probe

The probe ran by immutable image ID, as the image's default `node` user, with:

- `--network none`, with only its own loopback HTTPS origin and CONNECT proxy.
- Read-only root filesystem, all capabilities dropped, and `no-new-privileges`.
- A 256 MiB memory limit, 0.5 CPU limit, and 64-process limit.
- Only the probe script and two newly generated synthetic certificate files mounted read-only.
- TLS verification enabled through `NODE_EXTRA_CA_CERTS`; no bypass of certificate validation.

All assertions passed on **Node v22.23.4**:

1. An HTTPS fetch used the recording proxy's CONNECT tunnel.
2. An unreachable proxy rejected the fetch without falling back to the directly reachable origin.
3. Loopback `NO_PROXY` bypassed the proxy successfully.
4. The synthetic HTTPS certificate was validated normally.

Observed totals were one CONNECT and two successful local origin requests. `BB_RELEASE_SHA` exactly matched the source commit. External and merchant requests were zero. The temporary probe container was automatically removed; the existing container and volume inventory was identical before and after the probe.

## Issues found and resolved before success

The initial read-only review found that two newly imported CSS files were missing from the release Dockerfile's explicit COPY list and context exceptions. Root corrected the release assets and strengthened the import-discovery test.

The first actual build, from `e2773211da4c17a98195e9099ec3f1931be84b35`, then failed during Web TypeScript checking because three development E2E modules imported `scripts/local-integration/config.mjs`, which the release build stage had never copied. Root committed the explicit build-only module/declaration inputs and an import-discovery regression check in `279f13a0f086ca1048b38058fcc94703763f8b5a`. The second build above proved the fix in Linux while preserving the complete Web typecheck.

The first failed build took 5 minutes 42 seconds and its log/result/context manifest are retained under the `e2773211da4c-FAILED` / `e2773211da4c` filenames. Total active build time across both attempts was approximately 13 minutes 21 seconds, below the 30-minute bound. No existing image, container, or volume was pruned or replaced.

## Evidence and limits

- `RELEASE-API-BUILD.log` and `RELEASE-API-BUILD-RESULT.json`: successful build and image identity.
- `RELEASE-API-CONTEXT-MANIFEST.json`: exact allowlisted source inputs.
- `RELEASE-API-PROXY-PROBE.json`: exact-image runtime result and unchanged existing containers/volumes.
- `WSL-LOCAL-PROXY-PROBE.mjs`: the bounded, dependency-free probe used by the image.
- `WSL-LOCAL-DEPLOYMENT-VALIDATION.md` / `.log`: actual Compose interpolation/merge matrix and native WSL probe.

This closes the API release-image build and Node proxy-runtime gap. It does not claim production deployment, a full worker/OCR image build, runtime Squid allow-list acceptance, production callbacks, merchant product eligibility, real payment/refund/statement validation, or recurring deductions from a customer's external payment account. Merchant-related defaults must still follow their separate acceptance requirements.
