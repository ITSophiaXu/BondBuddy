# Controlled prospectus quality publisher

Hosted CI runs mechanical checks as `prospectus-quality-mechanical`. The separate `prospectus-release-acceptance` status comes from a controlled Linux publisher after the complete gate, including private real-model and independent human review. Customer documents and human-review evidence stay on that host. Mechanical success never becomes a passing release receipt.

## Host and identity

Use a reviewed clean checkout with canonical `https://github.com/<owner>/<repo>.git` or `git@github.com:<owner>/<repo>.git` origin. Install the same Linux Node/Python/LibreOffice/PostgreSQL prerequisites as the full gate and the GitHub CLI. Provision `gh` with a dedicated release service or GitHub App identity allowed to create commit statuses for this repository. Do not use a model worker's credential. Keep publisher credentials outside candidate/model workspaces and never mount the publisher's credential home into untrusted candidate containers.

The CLI removes GitHub token/config variables from the gate subprocess environment; this is defense in depth, **not an operating-system sandbox**. Host ACLs or process/container isolation must prevent model/candidate processes from reading credential files. The controlled operator must review the candidate and gate changes before granting access to private files or running this publisher. Do not run a privileged self-hosted publisher automatically on arbitrary pull requests.

An independent human reviewer supplies the private review record and completed evidence bundle described in [the acceptance schema](prospectus-acceptance.md). Store it in an operator/reviewer-controlled directory that model workers cannot write. Confirm its provenance through that person's authorized handoff; do not promote a model's JSON to human review by editing flags. The verifier checks bytes and review completeness; it does not authenticate a natural person or provider signature. A regular workspace file containing `actor_type: human` is insufficient provenance.

## Run

After the actual model run, review and source bindings have been completed for the exact checkout:

```sh
export BONDBUDDY_TEST_PYTHON="$(command -v python3)"
export BB_TEST_DATABASE_URL=postgresql://bondbuddy:synthetic-quality-only@127.0.0.1:5432/bb_prospectus_quality
export BB_PROSPECTUS_ACCEPTANCE_FILE=/private/reviewer-controlled/current-candidate.json
# GH credentials are provisioned by the controlled service, not pasted into this command.
node scripts/publish-prospectus-quality.mjs <full-40-character-commit>
```

The CLI refuses a dirty checkout, abbreviated SHA, a different HEAD, non-Linux runtime or unsupported origin before publishing. It posts `pending` on that exact SHA, runs the fixed full gate, verifies the receipt for the same SHA, rechecks HEAD/tree/cleanliness and then posts `success` with only the receipt SHA256. A gate, receipt or source-binding failure posts `failure`; failure to publish a status is itself an error. Initial `pending` failure stops before running candidate code. Never publish success by hand when this command fails. No private paths, documents or acceptance JSON are sent in the status request. Private logs and receipt remain under `.local/` on the controlled host.

Use the resulting `.local/prospectus-quality.json` with the existing gated export/deploy procedures. The GitHub green status does not replace the 24-hour, exact-commit receipt required by deployment. Retain the successful receipt privately for rollback as documented in the deployment runbook.

## Required checks and exact source

Configure both `prospectus-quality-mechanical` and `prospectus-release-acceptance` as required checks on develop/master and the relevant merge queue. Pin release status creation to the dedicated trusted App/service identity using the repository's available protection controls. A matching context name alone is not proof of who ran the private gate; if current permissions/plan cannot enforce the trusted source, report that limitation and retain the controlled deployment check. Never claim these settings were enabled merely by adding scripts or workflow YAML.

PR head, GitHub test-merge SHA, merge queue SHA and final master SHA may differ. Supply review and invoke the publisher for the SHA whose status is being required. After a new merge commit or any source change, repeat full acceptance for the final deployment commit. Prior PR status cannot authorize another commit, even if an operator believes its code is equivalent.

The publisher has fake-command orchestration tests. They do not create real GitHub statuses, real provider records, human-review evidence, or passing release receipts. No live status publication was performed as part of implementation testing.
