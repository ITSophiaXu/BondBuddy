# #18 / #361 UX-05: saved user messages in the project workspace

Baseline: `develop@9421b386` (project message API from #468); prototype: the unchanged `product-prototype/public/project-conversation.js` and `project-workspace.js` at that baseline. Implementation commit and final merge SHA are recorded in the associated PR. This is a **synthetic Chromium / HTTP-boundary** comparison, not a deployed API, model, prompt/usage or Word acceptance.

| 1440 × 960 / 390 × 844 viewport | Original prototype | Browser implementation |
| --- | --- | --- |
| Create / desktop | [Prototype](bb18-reference-create.png) | [Implementation](bb18-implementation-create.png) |
| Create / mobile | [Prototype](bb18-reference-create-mobile.png) | [Implementation](bb18-implementation-create-mobile.png) |
| Materials + one user message / desktop | [Prototype](bb18-reference-materials.png) | [Implementation](bb18-implementation-materials.png) |
| Materials + one user message / mobile | [Prototype](bb18-reference-materials-mobile.png) | [Implementation](bb18-implementation-materials-mobile.png) |

Both sides use the same viewport, synthetic issuer, market, reporting cutoff, and user text. Compared side by side: desktop keeps the prototype's two-column create/materials workspace and right-side message panel; mobile stacks the panel below the form/materials without horizontal overflow. The implementation form is shorter because pre-existing form sections differ from the prototype; this slice does not rewrite them. The prototype saves its local `projectMessages` as part of its create action; the implementation **does not** claim a pre-creation message was sent. It carries the unsent composer to the created project and the user explicitly sends it to the server. In the real workspace, a saved bubble says *user-provided, unverified*, offers an exact prior-version read after edit, and never shows a made-up assistant reply or auto-run. The extra status/retry/history affordances are required by the server's 409/503 and revision semantics; there is no deletion endpoint, so the prototype's local-only “remove” action is not presented.

Reproduce with Node 22+ and locked dependencies:

```sh
BB_UX_EVIDENCE_PREFIX=bb18 BB_UX_EVIDENCE_DIR=apps/web/ux-evidence/issue-18-conversation node apps/web/scripts/capture-prototype.mjs
BB_UX_EVIDENCE_DIR=ux-evidence/issue-18-conversation npm test -w @bondbuddy/web -- tests/project-conversation.spec.ts
```

The #33 no-history generation route uses the same explicit message-set lock without changing its `generation` execution kind. Remaining #18 / #361 UX-05 acceptance: no public assistant, intent classifier, streaming interruption/resume, attachment replacement UI, clarification/job/attempt/usage chain, or deployed original-project professional/Word validation. A message send is `save_only`; explicit “开始更新” remains a separate action. The parent issues stay open pending product review and real service evidence.
