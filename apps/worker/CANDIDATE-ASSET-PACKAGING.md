# SSE private candidate asset packaging

`loadSsePrivateCandidateBundle(repositoryRoot)` requires these repository-relative files at runtime:

- `knowledge/exchange-bonds/drafts/sse-private/rule-pack.json`
- `knowledge/exchange-bonds/drafts/sse-private/chapter-template.json`
- `knowledge/exchange-bonds/drafts/sse-private/coverage.json`

The worker image or deployment package must include the three files and pass the repository/runtime root to the loader. Missing files, byte changes, version changes, hash changes, schema errors, and scope changes reject loading. The loader returns a `candidate_only` asset descriptor; it does not grant run capability or select a production or test channel.

The current Dockerfile is intentionally unchanged because the #17/#35 packaging work is active. Before this loader is wired into a deployed test path, that work must copy the pinned asset directory into the worker runtime image and provide its root path. This note documents a packaging dependency; it does not claim the image currently contains the assets.
