# Positive-cost chart scale review correction

The independent desktop review found that a known 0.0001 USD cost was drawn with zero height because the old denominator was at least 1. The chart now scales against its largest positive value, with fallback 1 for all-zero data. Zero/null costs still draw no activity bars. No API, billing, schema or trend date-window semantics changed.

Final affected page units: **13/13**, with fail/cancelled/skipped/todo=0. The new test verifies 0.0001 and 0.0002 draw heights 44 and 88 and zero/null days draw none. Only the affected page suite was rebuilt and rerun.

[results.json](results.json) binds all eleven final runtime/test/workflow sources and dist files to successful evidence: the unchanged [API/PG final 17/17](../ci-admin-final.json) and the [new page 13/13](page-units-cost-scale-final.json). It also binds the shared parent .gitattributes (* -text).

All fifteen entries in the original [SHA256SUMS](../SHA256SUMS) were verified byte-for-byte; original raw logs, JSON, manifests and discovery-era page results were not normalized or rewritten. [Original results](../results.json) remain historical evidence; this directory supersedes their final page source binding. The original PostgreSQL clone cleanup and smart stop still apply; no PostgreSQL or provider was restarted for this review correction.

Desktop discovery images and the ten-case browser rerun are archived separately by the UI agent. This directory does not claim those screenshots or a Linux/GitHub Actions run. No staging, commit or push was performed by this agent.
