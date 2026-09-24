# M1 public contract (Issue #6)

This is the importable source for public values, DTOs, JSON Schema and OpenAPI. All `/api/v1` operations are **contract only** in this slice. The API skeleton implements only `/health` and `/openapi.json`; it has no login, database, object storage, queue, model calls or artifact delivery. Synthetic examples do not demonstrate deployed behavior.

## Fresh checkout

Use Node.js 22 and npm 10 or newer at repository root:

```bash
npm ci
npm run build
npm run check:contracts
npm run test:api
npm run start:api
```

Open `http://127.0.0.1:3000/health` and `http://127.0.0.1:3000/openapi.json`. `PORT` and `HOST` can change the local listener. It binds to `127.0.0.1` by default. The root `package.json` introduces npm workspaces only for `packages/contracts` and `apps/api`; `product-prototype/` remains an independent existing package. Do not use the old Python `backend/server.py` for M1 routes.

Consumer code imports values and inferred types from one package:

```ts
import { MARKETS, MARKET_OFFERINGS, RUN_STATES, schemas, type Project, type RunEvent } from '@bondbuddy/contracts';
```

Use `npm run build` before importing compiled package output. `schemas` are runtime JSON Schema objects; `openApiDocument()` exposes the same schemas and operation catalog. The synthetic examples in `examples/synthetic.json` are validated with AJV by `npm run check:contracts`. The checker also verifies revision/idempotency conflict envelopes, owner-safe 404, recovery of the *same* run after a new session, ordered event cursors, OCR uncertainty, and missing usage represented as `null` rather than inferred zero. The runnable API test verifies advertised routes remain contract only.

## Contract conventions and handoffs

- Public HTTP prefix is `/api/v1`. Spec 16's `/platform/v1` is an older prefix; the newer M1 architecture and `AGENTS.md` set `/api/v1`. Affected maintainers should review this in PR #6 before implementing #8.
- All times are UTC ISO-8601 with trailing `Z`. `null` means unavailable, unknown or not yet determined as described by the field; `0` means a measured zero. SHA-256 hashes use 64 lowercase hexadecimal characters. Cursor pagination is opaque; `next_cursor: null` ends a page. Run event `seq` is a per-run increasing integer and clients deduplicate `event_id`.
- `ProjectPatchRequest` requires `If-Match` with current `draft_revision`; stale revisions return `INPUT_REVISION_CONFLICT` (409). After upload completion, `POST /projects/{project_id}/input-revisions` binds the current draft, verified owner material versions and submitted requirement messages into an immutable snapshot. The server computes `input_hash`; the browser cannot choose it. This explicit route is a #6 design choice for affected maintainers to review. `execution_request_id` is unique per user action: same key and same immutable input returns the same run; same key with changed input returns `IDEMPOTENCY_CONFLICT` (409).
- Unknown and foreign personal resource IDs share `NOT_FOUND` (404). The service must derive `user_id` from the session, check ownership at every read, association and download, and never accept caller-supplied `user_id` as authority. The browser must not receive supplier credentials, private Blob keys, internal reference candidates or raw model request bodies.
- Upload is created with a scoped, short lived URL; completion succeeds only after server byte count, type/signature and hash verification. `persisted` means an immutable server copy exists; parsing and source recognition are asynchronous. OCR ambiguity remains `needs_confirmation`, with evidence and uncertainty. `MARKET_OFFERINGS` and `isMarketOffering()` express the approved combinations from spec 00; no new market or offering values were invented.
- Runs belong to the server. Closing a tab causes no cancel request. A reauthenticated user calls `GET /api/v1/runs/{run_id}` and `GET /api/v1/runs/{run_id}/events?after=<last_seq>` to recover the same run; the examples show the intended contract, **not a live recovery test**. Explicit cancel is its own operation. Worker recovery must reconcile provider attempts before retry. Only a checked, authorized, retrievable Word artifact permits `succeeded`.
- #79 will implement durable operation/job/prompt/call/outbox records and access controls. This slice provides trace IDs, prompt references, model attempt shape and `usage_status`; it does not persist logs. Missing usage is `pending` or `unavailable` with `null` unknown counts. #16 will validate actual provider model IDs and protocol behavior; the synthetic model ID is not a real provider selection.

**Chris:** import shared values/types for project, upload, OCR confirmation, event cursor and artifact UI. Show server save separately from transfer completion. **Felix:** implement authorization, CSRF/Origin, storage verification, revisions, idempotency, outbox and consistent errors behind the schema, then add PostgreSQL 16/Azurite integration under #8. **Xuefeng:** produce recognition/evidence status and keep ambiguous source fields null until corrected. **Maxy:** review market/offering combinations, capability release and professional labels; this slice does not assert rule coverage.

PostgreSQL and Azurite are intentionally absent from this first executable slice because it has no persistent or upload route. Adding empty Compose services would not exercise their contract. #8 must add migrations, local services and integration tests before claiming persistence or owner isolation. No public mutation routes may be enabled without real session, owner, CSRF/Origin and outbox handling.
