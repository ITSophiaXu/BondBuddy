# FC Codex CLI compatibility probe

This is a test-only image based on the project's actual `worker` image. It replaces
the long-running worker entrypoint with a small HTTP server for FC custom-container
invocations. It does not connect to BondBuddy's production database or storage.

Build from the repository root:

```powershell
docker build --target worker -f deploy/m1/Dockerfile -t bb-fc-worker-base:local .
docker build --build-arg BASE_IMAGE=bb-fc-worker-base:local -f scripts/fc-codex-probe/Dockerfile -t bb-fc-codex-probe:local .
```

Run locally with no model credential:

```powershell
docker run --rm -p 127.0.0.1:19000:9000 bb-fc-codex-probe:local
```

In a second terminal, call `Invoke-RestMethod -Method Post -ContentType
application/json -Body '{"mode":"platform"}' http://127.0.0.1:19000/`.
Run `sandbox` as the second mode. These two compatibility modes make no model
call and require no model credential.

The optional `model` mode runs the project's existing synthetic-only Codex
adapter probe. It sends one invented issuer arithmetic question to the real
DeepSeek provider and returns a redacted attempt record with usage. It has no
database lease or durable journal, and does not exercise any BondBuddy task
pipeline or generate a Word file. Only use it in this isolated test function.
It requires the function environment variables `BB_FC_PROBE_ALLOW_MODEL=1` and
`DEEPSEEK_API_KEY` (set in the cloud environment, never in the request or Git).
Then invoke `{"mode":"model"}` once. The request has a 90-second Codex timeout;
check the provider attempt status and measured usage in the response. A
precondition failure (`model_probe_not_configured`) does not call the provider.

For FC, create a custom-container function in the same region as the image
repository, set the container port to `9000`, and use console test invocation.
Do not add a public HTTP trigger. Run one `platform` invocation first, then one
`sandbox` invocation. Run `model` only when explicitly testing provider access.
The free CU package covers CU usage only;
check other charges and remove the function and test image afterward.

`platform` checks the Codex binary, bundled `bwrap`, unprivileged user namespace,
and a minimal bubblewrap mount. `sandbox` runs the existing file-boundary
diagnostic. These checks distinguish “CLI starts” from “BondBuddy's file sandbox
works.” The optional `model` mode checks provider connectivity and metered
Codex execution only. Full authoring, review, project QA, file generation and
integrity tasks need isolated PostgreSQL and object storage, the current worker
image, durable leases and actual deliverable checks. Do not treat this small
standalone container as a full task or long-job test.
