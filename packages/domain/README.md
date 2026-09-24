# BondBuddy domain rules (#19)

`@bondbuddy/domain` is the HTTP/database-independent rule-pack boundary. It imports market and offering values from `@bondbuddy/contracts`; consumers must not duplicate those enums.

The `rule-pack-v1` schema is strict and versioned. A pack fixes exactly one market/offering combination and records source type and version, official location and quote, validity, applicability, checker version, boundaries, positive/negative/boundary examples, owner role, sample evidence and release audit metadata.

Production publication requires all of the following:

- every source is verified and no `unverified_lead` remains;
- every enabled rule has positive, negative and boundary examples;
- no research-only or disabled rule is presented as a production capability;
- all authorized real sample cases pass and cover positive, negative and boundary scenarios;
- separate industry and technical attestations confirm sources, scope and samples;
- the market/offering combination comes from `@bondbuddy/contracts`;
- release metadata carries a deterministic content hash.

`evaluateRulePackCapability` never returns a compliance conclusion. It only decides whether an immutable production pack is eligible to evaluate a precisely matched context. Draft, test-channel, withdrawn, expired, wrong-market, wrong-offering and wrong-issuer packs cannot produce an eligible decision. Unknown document stage returns `needs_evidence`.

Rollback creates an append-only event from one immutable production release hash to another. It does not mutate historical runs or silently rewrite a released pack.

Rule and source text is data, not an execution instruction. The strict schema has no prompt/system/tool fields, and runtime selection returns identifiers and reason codes rather than concatenating rule text into a model prompt. A later model adapter must use a separately versioned, escaped rendering boundary.

The checked-in example is explicitly synthetic, draft, disabled and unverified. It validates schema behavior only and must never appear in a production capability table. Actual MTN/CP/SCP and other product packs belong to their individual Issues and require authorized official sources and professional acceptance.

## MTN engineering draft (#27)

`nafmiiMtnDraftRulePack`, `nafmiiMtnChapterTemplate` and `nafmiiMtnCoverageManifest` form the first MTN-specific engineering bundle. It is deliberately a draft and therefore cannot advertise capability. The bundle:

- is scoped only to `nafmii` + `mtn` + standard domestic public issuance;
- fingerprints the official 2020 M-table, 2021 MTN and disclosure rules, and 2023 registration rule originals;
- records the official 2026 basic-tier change without silently applying superseded fourth-category assumptions;
- maps M-0 through M-17 to semantic input fields;
- explicitly marks PPN/CP/SCP/DFI as other packs and specialist/industry overlays as uncovered;
- contains synthetic engineering cases only.

Production release remains blocked until an industry reviewer confirms source effectivity and scope, authorized real positive/negative/boundary MTN samples pass, and the uncovered specialist and industry overlays are either completed or excluded by an approved launch scope. The repository's older `S019` excerpts are not sources for this bundle.

Product-specific releases must use `publishRulePackBundle`; it validates the pack, chapter template and coverage manifest together and rejects any remaining `uncovered` item or open blocker before the lower-level publication checks run.

## CP engineering draft (#28)

`nafmiiCpDraftRulePack` is an independent `nafmii` + `cp` bundle. It reuses only the association-wide M-table chapter structure and common registration/disclosure sources. Its product identity comes from the fingerprinted 2021 CP guide, including the one-year tenor boundary. SCP's 270-day definition and disclosure omission mechanism are explicitly outside this pack. Like the MTN bundle, CP remains a non-advertised draft until its machine-readable blockers are resolved with industry review and authorized real samples.

## SCP engineering draft (#29)

`nafmiiScpDraftRulePack` is scoped to standard public SCP only. It pins the official 2021 product guide, enforces the 270-day-inclusive boundary and the working-capital-only/no-long-term-investment use boundary, and overlays MC.4-1 through MC.4-4 on the shared M-table chapters. Omission of M-5/M-6/M-7 is evidence-dependent and is rejected for first public registration or when effective public issuer information is unavailable. Specialist products, 2026 transition interpretation and authorized real samples remain explicit release blockers.

Run:

```bash
npm run build -w @bondbuddy/domain
npm test -w @bondbuddy/domain
```
