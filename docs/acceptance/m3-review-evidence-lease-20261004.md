# M3 long-review citation validation

Related: #56. This is a runtime performance repair, not professional review acceptance.

On release `36065efba9dd`, one post-deployment review lost its lease after approximately 26 minutes. The worker did not restart or report OOM. Its intent remained `pending_reconcile`, with no runtime observation, result reference or matching private result object. The worker log had a 71.405-second gap immediately before `lost`. No completed report can be recovered from the retained evidence.

A read-only replay over the same immutable input (35,269 records across three materials) measured 100 individual citation validations at 22,673 ms; batch validation took 373 ms and returned identical results. This reproduces a synchronous validation bottleneck capable of starving the 30-second lease heartbeat. The original process result was not retained, so its final model response and exact exit cause remain unknown.

The single-reference validator now checks owner, project, parser record ID and material ID before serializing full evidence pins, computing the requested pin only once. It retains all matching records to detect ambiguity, and still verifies exact source/parse hashes, locator, quote, extraction method, uncertainty and target identity. No persistent cache or lease/check relaxation is introduced. Prompt, logical call identity, schema and UI are unchanged.

Regression coverage uses 35,000 unrelated synthetic records and verifies that their full pins are not serialized on every citation. It also verifies duplicate ambiguity and source/owner mutations. Deployment and real task recovery must be recorded separately; previous usage stays unknown and this change does not automatically resend an unresolved call.
