# M1 platform model probe (#79 / #16)

The platform probe produces a real, anonymized, end-to-end #79 record on a deployed stack without waiting for the generation stages. An operator with `log_operator` enqueues one fixed synthetic prompt template. The worker sends it through the contained Codex adapter to the configured supplier. The PostgreSQL durable journal then writes the normal #79 rows: call intent, provider observation, measured usage, runtime row and the cost ledger with `pricing_status=unknown`. The probe then shows up in the admin job timeline.

Code: `apps/api/src/platform-probe.ts` (route and enqueue), `apps/worker/src/platform-probe-job.ts` (worker one-shot), `queue.ts` (`claim(..., {platformProbe:true})`, `finishPlatformProbe`), migration `0027_m1_platform_probe.sql`. Contract: `packages/contracts/src/platform-probe.ts`.

## Boundaries

- **No user data.** Probes are owned by the reserved platform principal `bb-platform-probe` (username `bb_platform_probe`, status `disabled`, so it cannot sign in). It has one fixed synthetic project, `bb-platform-probe-project`, with input revision 1. The request body accepts only `template_id`, `request_id` and `reason_code`. Database triggers reject a `platform_probe` job or run owned by anyone else, and reject any non-probe work owned by the principal.
- **Fixed prompt.** The only template is `bb_probe_json_echo_v1`. It asks for `{"status":"ok","probe":"bb_probe_json_echo_v1"}`, and the reply is validated against that JSON schema. The prompt text is stored server-side and saved as the run's `model_request` snapshot (`redaction_version=synthetic_probe_v1`, `template_version=bb_probe_json_echo_v1`).
- **Guards.** Enqueue checks the kill switch and deny override of the platform principal. The worker checks them again, plus the evidence gate, before it records the call intent. A probe that is rejected there fails with the guard's code, for example `MODEL_CALLS_SUSPENDED`, and has no attempt row. Run-count submission caps are retired; a probe still requires its node lease and shared model permit.
- **Separate claim.** The run pipeline never claims a probe, and the probe worker never claims a user run.
- **Success.** A probe run is `succeeded` without a Word artifact only if it has a completed attempt with a stored result and measured usage. Migration 0027 enforces this. User runs still need verified Word delivery.
- **Credentials.** DeepSeek uses env credential mode (`BB_CODEX_CREDENTIAL_ENV`, default `DEEPSEEK_API_KEY`). The explicit Copilot Enterprise command mode uses the read-only OAuth mount described in [copilot-model-provider.md](copilot-model-provider.md). The probe rejects `auth.json`; neither mode prints or stores credential values.
- **No user route.** There is no browser or user-facing route. Without a `log_operator` grant, `POST /api/v1/admin/probes/model` returns the same owner-safe 404 as an unknown resource.

## Egress

The worker has no internet route. Its compose env sets `HTTPS_PROXY=http://egress:3128`, and the squid allow-list (`BB_EGRESS_ALLOW`, default `api.deepseek.com`) permits only `CONNECT` to allowed hosts. The adapter passes `HTTPS_PROXY`, `https_proxy`, `NO_PROXY` and `no_proxy` to the `codex` child and nothing else from the proxy family. Proxy URLs may not carry userinfo. codex-cli 0.154.0 honours `HTTPS_PROXY` for supplier requests. This was checked on the worker host against a local fake proxy, with no credential and no real request: the fake proxy received `CONNECT api.deepseek.com:443`. The binary also tries `github.com`, `api.github.com` and `chatgpt.com` (update and metadata lookups). The allow-list denies these, and that is expected.

## Image

The worker image (`deploy/m1/Dockerfile`, `worker` target) installs codex-cli **0.154.0**, the version used in the #16 live probes. It comes from the npm platform package `@openai/codex@0.154.0-linux-x64` (or `-linux-arm64`), checked against the registry sha512 integrity. Only the static `codex` binary and its bundled `bwrap` are kept, under `/opt/codex`, with `/usr/local/bin/codex` pointing to them. The build fails unless `codex --version` prints `codex-cli 0.154.0`. The image runs as `node` (non-root).

## How the CTO triggers a probe on the host

1. Configure the worker in the target environment's `.env`, which stays on the host: `DEEPSEEK_API_KEY` (never echoed), `BB_CODEX_MODEL=deepseek-flash` (or the confirmed model id), `BB_PLATFORM_PROBE_ENABLED=1`. Optional: `BB_CODEX_CONFIG_VERSION`, `BB_CODEX_TIMEOUT_MS`. Redeploy or recreate the worker. Check the `BB_TRIAL_*` limits and make sure the kill switch is released: `GET /api/v1/admin/trial/status`.
2. Grant roles to an operator account: `deploy/m1/scripts/grant-operator.sh <username> log_operator live_probe_evidence` and `... log_reader live_probe_evidence`. Add `prompt_viewer` only if the plaintext prompt view is needed.
3. Sign in as that account, for example with the browser or `POST /api/v1/auth/login` and a cookie jar. Then enqueue the probe. The mutation needs the `bb_csrf` cookie echoed in `x-bb-csrf` and the configured `Origin`:

   ```sh
   curl -sS -b jar -c jar -X POST "$ORIGIN/api/v1/admin/probes/model" \
     -H "origin: $ORIGIN" -H "x-bb-csrf: $(awk '$6=="bb_csrf"{print $7}' jar)" -H 'content-type: application/json' \
     -d '{"template_id":"bb_probe_json_echo_v1","request_id":"live-probe-20260925-01","reason_code":"live_probe_evidence"}'
   ```

   The response is `202` and contains `job_id`, `run_id` and `timeline_path`. Sending the same `request_id` again returns the same probe with `replayed: true`.
4. The worker loop runs one probe pass after each parse pass, every `BB_WORKER_IDLE_SECONDS`. Poll `GET <timeline_path>` once a minute, not continuously, until `job.state` is `succeeded`, `failed` or `paused`.
5. Set `BB_PLATFORM_PROBE_ENABLED=0` again after the probe window.

If the job is `paused` at `provider_reconcile`, the call may have been sent but its outcome was not recorded, for example because of a timeout or crash. It is never resent automatically. Follow `docs/runbooks/provider-result-reconciliation.md`.

## Evidence to collect (anonymized)

Post only these fields on the Issue. Do not post the credential, cookies, raw model output or environment values.

- Release SHA or image tag, `codex --version` from the worker container (`docker compose exec worker codex --version`), and `BB_CODEX_MODEL` / `BB_CODEX_CONFIG_VERSION`.
- The `202` response with ids.
- From `GET /api/v1/admin/jobs/<job_id>/timeline` (log_reader): `job` (type `platform_probe`, state, attempts, duration), `stages` (queued → running → provider_call → succeeded), `attempts[]` (attempt id, status, `usage_status`, input/output/cached/reasoning tokens, `duration_ms`, `error_code`), `prompts[]` (snapshot id, sha256, template version) and `consumption`.
- `GET /api/v1/admin/trial/cost-ledger` rows for the attempt, with `pricing_status=unknown` and no amount.
- `GET /api/v1/admin/logs/events?job_id=<job_id>` for the event sequence (`model.call_started`, `model.usage_observed`, `model.call_finished`).
- If needed, `docker compose logs worker --since 10m | grep platform_probe` for the one-shot outcome lines only.
