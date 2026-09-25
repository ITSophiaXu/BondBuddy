# M1 staging acceptance — 2026-09-25

**Synthetic accounts and files only; no model provider was called** (model credential absent, execute returns `CAPABILITY_NOT_READY`).

- Stack: `deploy/m1/compose.yaml` on the worker host, release `729a5aa71612` deployed with `scripts/deploy.sh`, bound to `127.0.0.1:18080`, and exposed as `https://handed-rules-ant-bedding.trycloudflare.com` through a cloudflared quick tunnel (TLS is Cloudflare's certificate; Playwright ran with certificate checks on).
- Browser: Playwright Chromium headless shell, `deploy/m1/acceptance/staging.spec.ts`; 10/10 tests passed. Per-item results are in `results.json`.
- Production profile check (`compose.yaml` + `compose.prod.yaml`, 848 MiB limits, Azurite standing in for Azure Blob): the same suite passed with 13 pass items (`prod-profile/results.json`), measured peak sum ≈ 306 MiB, no OOM. That check stack was removed afterwards.
- Egress (`egress-test.txt`): direct internet from the worker is unreachable; `example.com` and `github.com` through the proxy get 403; `api.deepseek.com` gets a CONNECT tunnel, closed immediately with no TLS or request.
- Release log (`releases.log`): deploy → restore drills → deploy (pre-deploy backup) → rollback → deploy.

| issue | acceptance item | result | evidence |
|---|---|---|---|
| #7 | username/password register + UI login over HTTPS; Secure/HttpOnly/SameSite=Strict session cookies | **pass** | `07-login-projects.png, results.json` |
| #7 | duplicate username (case-normalised) is rejected with a stable code | **pass** | `results.json` |
| #6 | closing the tab does not cancel the server-side job; re-login shows progressed, persisted state | **pass** | `06-upload-saved.png, 06-reopened-recovered.png, results.json` |
| #6 | web works with only a browser (no Node/Python/CLI); no provider key/secret in bundle or API responses | **pass** | `results.json` |
| #6 | explicit product copy for upload scope, cloud processing, retention and deletion; no "originals stay on this machine" claim | **partial** | `06-account-policy-copy.png, results.json` |
| #8 | guessing another account's project/material/artifact IDs cannot enumerate or download (404) | **pass** | `08-b-cannot-open-a-project.png, results.json` |
| #8 | editing the draft after a run snapshot does not change the snapshot | **pass** | `results.json` |
| #8 | edit conflict returns a stable error code | **pass** | `results.json` |
| #8 | duplicate create (same bytes re-uploaded) returns the same resource | **pass** | `08-duplicate-upload-reused.png, results.json` |
| #6/#17 | run submission with model disabled shows explicit not-ready (no fake success) | **pass** | `results.json` |
| #7 | logout revokes the session; replaying the old cookies cannot read or download materials | **pass** | `07-logged-out.png, results.json` |
| #8 | backup -> restore drill preserves project, material bytes (sha256) and the locked snapshot | **pass** | `08-restored-material.png, results.json` |
| #7 | failed logins and the rate-limit response are identical for existing and unknown usernames | **pass** | `07-rate-limited-ui.png, results.json` |
| #79 | admin log routes reachable only with a grant (no grant -> 404; log_reader -> 200; prompt/operator routes still 404 without their own grants) | **pass** | `results.json` |

Not provable here: production TLS on the real hostname, real Azure Blob backup/restore, real-provider runs and checked Word delivery, and load/capacity behaviour with real 100 MB files.
