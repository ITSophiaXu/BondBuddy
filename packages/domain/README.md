# BondBuddy domain rules (#19)

## Historical-period difficulty estimator (#76)

`update-difficulty.ts` is an internal, deterministic estimator for a historical
prospectus update. It compares evidenced reporting-period cutoffs with the
target set, counts retained/new/replaced/substantially restated cutoffs once,
and records source-to-target market/offering migration separately from N.
Unknown source classifications or unresolved cutoff evidence block an N
estimate; no filename, cover year, or signing date can fill that gap. The
estimate is not an actual execution count or a price.

This slice does not recognize historical documents, persist profiles, expose a
public API, run OCR, or charge credits. Those capabilities remain #76 work and
depend on the existing material/worker pipeline and #14 OCR.

## Fact and cache foundation (#15)

`facts.ts` is an internal, HTTP/database-independent foundation, covered by
synthetic boundary tests. Fact identity includes account, entity, scope, metric,
period/as-of, currency, unit, basis, and data version. Same-key disagreements
retain all candidates; user statements remain asserted, uncertain OCR values
cannot become verified, and template/reference issuer facts are excluded.
Bank-facility totals use exact decimal arithmetic only when bank, date, scope,
currency, unit, and basis match. The private parse-cache key includes account,
content SHA-256, parser/OCR/basis versions but not filename or project.

Migration `0010_m1_facts_parse_cache.sql` adds owner-scoped candidate metadata
and private Blob cache references. The worker package now has a unit-tested
internal cache read/write seam, but this does not install a production fact
extractor, active worker processor, public DTO, or conflict-resolution log.
The trusted processor must still authorize the material version and record
source/date/anchor when creating facts. #13
native parsing and #14 OCR are still open; PostgreSQL integration and authorized
professional sample acceptance remain required before #15 can close.

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
