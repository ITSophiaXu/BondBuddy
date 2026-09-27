# SSE private candidate asset packaging

`loadSsePrivateCandidateBundle(repositoryRoot)` requires these repository-relative files at runtime:

- `knowledge/exchange-bonds/drafts/sse-private/rule-pack.json`
- `knowledge/exchange-bonds/drafts/sse-private/chapter-template.json`
- `knowledge/exchange-bonds/drafts/sse-private/coverage.json`

The worker image or deployment package must include the three files and pass the repository/runtime root to the loader. Missing files, byte changes, version changes, hash changes, schema errors, and scope changes reject loading. The loader pins both the dictionary version/hash and the distinct overall-review taxonomy version; these must not be treated as interchangeable. It returns a `candidate_only` asset descriptor and does not grant run capability or select a production or test channel.

`deploy/m1/Dockerfile` now copies only these three assets into the build and Node runtime layers (API/worker/ops). The build runs `node apps/worker/dist/verify-sse-private-candidate-assets.js` and rejects missing or changed assets. Source documents and customer samples are not copied. `.gitattributes` forces LF for these three exact paths, so Windows checkouts and `git archive` have identical pinned bytes.

`SSE_PRIVATE_CANDIDATE_RUNTIME_ROOT` derives the root from the compiled module location, not the process working directory. `loadSsePrivateCandidateAssets(root)` returns the descriptor plus typed content parsed from the same verified buffers, avoiding a second filesystem read after validation. The existing descriptor loader remains compatible.

Before enabling the channel, run the verifier in the **built worker image** and record its image SHA and returned hashes. This repository change and isolated-directory tests do not prove the target machine has deployed the image.

The historical research projection normalises repeated document metadata while retaining all 31 rules, 179 source quotes/locators and 32 coverage items; it is under the existing 180 KB reference budget. It is explicitly `research_reference_only`, has no release event or compliance approval, and does not itself grant run capability. Effective grants, candidate sample membership and the public test-channel lifecycle remain #19/#17 responsibilities.
