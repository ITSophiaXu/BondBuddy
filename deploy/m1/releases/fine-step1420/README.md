# Fine-step timing release source

This release preserves the exact running component versions and adds PR1420 telemetry. The master branch carries the feature and test history plus two reconstruction recipes; its entire tree is not the runtime deployment source.

`recipe.json` pins two sources. `current` (`c402fde4d8d974e9b5ec30b6ae587d6ebb1f9a76`, tree `dc5ebe29251c6af8500f329ae39ea067bed05b27`) is used by main API and Azure primary worker and retains their deployed four-way capacity behavior. `prior` (`511dfd0aa13a05a106194b8857b3a0ce28819441`, tree `fab7af5949de0733df595c5c0c0af807da0bac4f`) supplies unchanged telemetry payload bytes for main ops, Azure review worker and main web. Neither complete source tree is deployed.

Both patches are raw LF `git diff --binary` output against the declared base. Read the Git blob bytes, verify the recipe SHA-256, apply to a temporary Git index, and require `git write-tree` to match the declared source tree. Each component has its own artifact hashes and provenance; a shared artifact path does not imply shared bytes across roles.

The API and primary worker currently have read-only code-file bind mounts from the capacity release. The new images absorb those exact files: non-telemetry files retain their observed bytes; telemetry intersections use the reviewed combined source. Only the exact absorbed code mounts are removed from candidate container configuration. Other configuration and data mounts remain unchanged; rollback retains the complete original configuration and mounts.

The Azure pure-parse worker remains the active parsing service. The relocated, stopped main-host parser must not be restarted. Deployment rechecks parser identity, source manifests and configuration together with all changed components.

Keep already deployed migrations 0180 and 0186. Execute only the exact `0185_performance_spans.sql`, advancing the current ledger from 184 to 185 entries. Do not run the whole migration directory or add unrelated migrations 0181 through 0184.

The current source has six successful builds on Windows Node 24.22.1 and TypeScript 5.9.3. Linux Node 22 regressions and actual candidate-image verification are recorded separately in the release evidence. Prior-source test evidence applies only to its exact bytes; retained failures, skips and synthetic model boundaries must not be reported as full quality-gate success.

This recipe grants no execution permission and is not a quality-gate receipt. The draft release requires current test and image evidence plus the applicable full gate or an explicit exception for this batch. Earlier batch exceptions are not inherited. Final cutover uses the shared deployment locks, fresh state checks, natural task drain, off-host backup and verified rollback configuration.
