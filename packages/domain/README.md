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

Run:

```bash
npm run build -w @bondbuddy/domain
npm test -w @bondbuddy/domain
```
