# Copilot Enterprise model provider (preproduction)

The contained worker adapter can use Codex's command-backed bearer authentication. This is an explicit preproduction switch. The legacy DeepSeek configuration remains available for rollback. It never acts as an automatic fallback after a Copilot configuration or authentication failure.

## Switch

1. Preserve the current private environment file and deployment image tag. Obtain the account's persistent OAuth access token through the approved account flow, and store it in a private regular file readable by container UID 1000. Do not place the token in the environment file, image, command arguments, or repository. Set the host file path in `BB_COPILOT_OAUTH_HOST_FILE`; Compose mounts it read-only into **worker only**. The default `/dev/null` mount cannot authenticate.
2. Set these values together in the private environment file:

   ```dotenv
   BB_CODEX_AUTH_MODE=copilot_enterprise
   BB_COPILOT_OAUTH_HOST_FILE=<private absolute host file path>
   BB_CODEX_CREDENTIAL_ENV=
   BB_CODEX_PROVIDER=copilot_enterprise
   BB_CODEX_BASE_URL=https://api.enterprise.githubcopilot.com
   BB_CODEX_MODEL=gpt-6-sol
   BB_CODEX_REASONING_EFFORT=max
   BB_CODEX_CONFIG_VERSION=copilot-gpt6-max-v1
   BB_OPS_PROVIDER_BALANCE=off
   BB_EGRESS_ALLOW=api.github.com api.enterprise.githubcopilot.com <existing Blob host and any separately approved hosts>
   ```

3. Validate `docker compose config` with the production overlays, then recreate the worker, ops, and egress services from the reviewed image. The worker uses a fresh Codex home for each attempt and ignores host user settings. It sets a 1,000,000 token context window and compacts at 800,000 tokens, below the advertised 872,000 prompt limit. No public API contract or database migration changes.
4. Run the operator's fixed synthetic platform probe and inspect its persisted attempt, actual usage status, provider error code, and request identifier status. A successful connection alone does not establish full document acceptance. Confirm 401 and 429 paths remain classified and that unresolved old attempts remain in reconciliation before allowing new work.

The helper exchanges the mounted OAuth token at `api.github.com/copilot_internal/v2/token` when Codex requests a bearer token. The short-lived bearer is printed only to Codex's private auth pipe. The helper emits a generic failure on stderr; neither OAuth nor bearer values enter application logs. The contained child receives only the OAuth file path and the existing allow-list proxy variables, not the parent environment. Egress permits only configured HTTPS hosts.

The DeepSeek balance endpoint measures DeepSeek account health only. It is skipped automatically while `BB_CODEX_PROVIDER=copilot_enterprise`, even if a legacy DeepSeek key remains configured. Existing balance alert history is retained; use synthetic probe results and attempt records for Copilot health. The provider balance alert settings become active again in DeepSeek mode.

## Rollback

Stop new model submissions, settle or explicitly reconcile unresolved attempts, then restore the saved private environment and reviewed image tag. In particular, clear `BB_CODEX_AUTH_MODE` and the Copilot host-file setting; restore the DeepSeek provider, endpoint, model, credential variable, egress allow-list, and balance probe setting as one change. Recreate worker, ops, and egress, run the fixed synthetic probe, and verify its provider and usage evidence. Do not retry an unresolved prior attempt merely because the provider changed.
