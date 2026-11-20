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
Run `sandbox` as the second mode. This compatibility probe makes no model call
and requires no model credential.

For FC, create a custom-container function in the same region as the image
repository, set the container port to `9000`, and use console test invocation.
Do not add a public HTTP trigger. Run one `platform` invocation first, then one
`sandbox` invocation. The free CU package covers CU usage only;
check other charges and remove the function and test image afterward.

`platform` checks the Codex binary, bundled `bwrap`, unprivileged user namespace,
and a minimal bubblewrap mount. `sandbox` runs the existing file-boundary
diagnostic. These checks distinguish “CLI starts” from “BondBuddy's file sandbox
works.” A later model and long-job test must use the project's durable leased
probe/worker path, not this small standalone container.
