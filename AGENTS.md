# BondBuddy repository guidance for Codex

This file applies to the whole repository. Read the relevant M1 issue and the documents below before changing code. Keep implementation details in the architecture document; update this file only when a working agreement changes.

## Sources of truth

1. The user's current request and the assigned GitHub issue define the task.
2. `product-prototype/product-specs/00-产品边界与需求决策.md`, `16-数据模型接口与状态机.md`, and `17-验收测试与实施路线.md` define product behavior, data semantics, and acceptance.
3. `docs/M1-TECH-ARCHITECTURE.md` defines the proposed M1 technical stack, component boundaries, shared contracts, and four-person ownership. Keep it synchronized with implementation decisions.
4. `product-prototype/` is the BondBuddy UX and algorithm prototype. The root `backend/`, `web/`, and current `deploy/vm/` are the older Cowork application. Do not create a second M1 production API by extending the old Cowork server.

If these disagree, identify the conflict in the issue or PR and resolve the shared contract before building dependent code. Do not silently choose a different business rule or API shape.

## M1 technical baseline

- Browser UI: preserve the existing `product-prototype/public/` experience; migrate to Vite and shared API types incrementally. New browser modules use TypeScript. Avoid a wholesale UI framework rewrite for M1.
- API: Node.js 22, TypeScript, Fastify, JSON Schema/OpenAPI, under `/api/v1`.
- Data: PostgreSQL 16 for identity, projects, versions, jobs, reference metadata, audit, and outbox; private Azure Blob Storage for materials, prompt snapshots, and artifacts. Use Azurite locally.
- Jobs: a separate Node worker using PostgreSQL leases and durable checkpoints. Python 3.11+ subprocesses handle parsing, OCR, and Word operations through versioned JSON inputs and outputs.
- AI: server-side Codex/DeepSeek adapter. #16 must establish the actual model ID and protocol behavior before production use. Record each call attempt and real usage or `unknown`.
- Deployment: Docker Compose and Nginx/TLS on Azure VM for M1. M1 trial usage is paid by the platform and recorded; do not use demo credits as production accounting.

These are the review baseline in the architecture draft. Record a deliberate change in that document and the affected contracts before merging an implementation that differs.

## Shared contract rules

- Define API request/response schemas, error codes, enums, job events, and public DTOs once in `packages/contracts/`; generate or import clients from them. Do not hand-copy market, offering, status, or error enums across UI and worker.
- Every personal resource is scoped to `user_id`; API and worker validate ownership on reads and writes. Browser state and client-supplied IDs do not grant access.
- Execution locks an immutable `input_revision`/`input_hash` and material, rule, template, and reference versions. Repeated `execution_request_id` must return the same run for the same input.
- Persist business changes and their outbox events in the same database transaction. A browser closing does not cancel a run. Worker recovery checks previous model calls before retrying.
- Store file bytes in private object storage and metadata/hash in PostgreSQL. Do not persist production accounts, projects, jobs, or reference releases in prototype JSON files.
- Treat unverified OCR digits, missing evidence, missing model usage, and unpublished or withdrawn reference material as explicit unresolved states. Do not turn them into confirmed facts, zero usage, or successful output.
- Mark a run successful only after its Word artifact passes delivery checks and an authorized user can retrieve it. #79 logging must be ready before any real user update task is opened.

## Four-person collaboration

- Start each issue branch from the latest `develop` and use an isolated workspace/worktree. Open normal feature, fix, documentation, and infrastructure PRs **against `develop`**. Do not target the old `feat/review-classification-optimization` branch or push directly to `develop`.
- Treat `master` as the release branch. Only a reviewed release PR from `develop` to `master` advances it; deploy from the merged `master` commit and record the commit/tag, migration plan, verification, and rollback. Do not merge unfinished M1 work into `master` just to keep branches synchronized.
- For an urgent production fix, branch from `master`, review the fix into `master`, then merge or cherry-pick the same fix back to `develop` before further releases.
- Keep PRs small enough to review, with the issue number, contract or migration changes, sample evidence, and remaining blockers. Set the PR base explicitly to `develop`, because the GitHub repository default branch may still point elsewhere.
- Chris owns the browser UI and API client. Felix owns API, job infrastructure, database migrations, deployment, and observability. Maxy owns bond business rules, market/product applicability, and reference-library acceptance. Xuefeng owns extraction, OCR, fact processing, matching, and generation algorithms. The detailed boundaries are in the architecture document.
- Changes to `packages/contracts/`, `db/migrations/`, the run state machine, or shared market/rule enums need review from affected owners before merge. Add new migrations; do not edit a migration already deployed.
- Use stable schema examples and authorized sample documents for cross-module integration. Mark synthetic data as synthetic. Do not claim a model response or demo flow satisfies a real-provider or professional acceptance requirement.
- Do not commit credentials, customer materials, local runtime directories, or generated artifacts. Keep deployment secrets in the target environment.

## Starting an assigned issue with Codex

1. Fetch the latest `develop`, create an issue-specific branch and isolated worktree from it, then read this file, the full issue (including its prerequisites and acceptance criteria), and the linked product specs. Some issue links still point to the old default branch; read the corresponding files from your checked-out `develop` instead.
2. Write down the issue's deliverable, affected modules, shared contracts, prerequisites, and acceptance evidence before editing. The GitHub assignee owns delivery even when another person owns a touched module; request that module owner's review for cross-boundary changes. One assignee should coordinate each issue's PRs so parallel Codex sessions do not implement competing contracts.
3. The layout in `docs/M1-TECH-ARCHITECTURE.md` is a target, not a completed scaffold. Until #6 lands the first shared contracts and project skeleton, independent UI, parsing, rules, and provider research may proceed, but integration code must agree on schemas with the affected owners first. Do not invent a second API, copy shared enums, or present a mock integration as complete. An issue's prerequisites govern when its acceptance can be claimed, even if isolated work can start earlier.
4. Use the scripts and setup instructions that actually exist in the touched package. There is no repository-wide M1 build command yet. Keep each PR scoped to one issue or an explicitly agreed integration slice; update contract/schema examples and the architecture document in the same PR when a shared decision changes.
5. Open the PR with `develop` as the explicit base. Include the issue number, acceptance criteria addressed, contract/migration changes, evidence, and remaining dependencies. Ask affected owners to review before merge. An assigned issue is done only when its acceptance criteria and prerequisites are satisfied; record unresolved items in the PR or issue rather than marking a demo or stub as complete.

## First integration target

Real sign-in → create project → upload and verify DOCX/PDF → save material version → submit a durable run → reopen the browser and recover its state → obtain a validated Word artifact. Include prompt, job, call attempt, token, error, and terminal-result evidence in this path.
