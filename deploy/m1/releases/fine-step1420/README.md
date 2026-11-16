# Fine-step timing release source

This recipe reconstructs the exact scoped runtime source tree `fab7af5949de0733df595c5c0c0af807da0bac4f` from baseline `a0a051111dc583db9b39459a5f215e63a8c522e5`. The master branch also carries the two PR1420 feature commits for source history; its whole tree is not the runtime deployment source.

`source.patch` is the raw LF output of `git diff --binary BASE SOURCE`, not a merge of the old baseline into master. Apply it to the declared base using a temporary Git index and require `git write-tree` to equal `source_tree`. The recipe stores the patch SHA-256 and observed current parent image identities. Deployment must re-read the current images/configuration and reject changed preimages.

Build the reconstructed source, then use the reviewed component-specific file allowlists. Preserve existing parent-image files outside those lists. The ops overlay needs only the log retention call and performance lifecycle module; review must retain its older authoring/batch modules. Web publishes only admin/index.html and its referenced content-addressed asset closure.

The only database migration is exact `0185_performance_spans.sql`; never enumerate the newer migration directory. The recipe grants no execution permission and does not satisfy the current batch quality gate. This PR remains a draft until the release owner completes and reviews the required receipts. Earlier deployment exceptions are not inherited.

Source proof: a fresh temporary GIT_INDEX_FILE reconstructed the declared tree exactly. Runtime candidate targeted Windows checks passed 67/67 using actual Node v24.22.1, including 18 real TCP login/query assertions inside one test. Linux Node v22.23.2/TypeScript 5.9.3 builds of contracts/domain/registry/context/API produced 1,163 files byte-identical to those tested artifacts; worker evidence is produced separately. These facts do not assert browser acceptance or model output quality.
