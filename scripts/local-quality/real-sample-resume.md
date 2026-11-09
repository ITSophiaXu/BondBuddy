# Continue observing an existing RQ task

The initial real-sample test writes `run.json` immediately after the execute
response, before checking its status or input metadata. The same unique external
directory holds `session.json`, which is a private synthetic-account session.
On Windows that directory disables inherited access and grants only the current
user and SYSTEM. Never print, attach or commit this session file.

If the test harness stops after a run was accepted, inspect the existing run
first. Do not start the creation spec again just because observation timed out.
The resume spec opens the original session, confirms the exact owner, instance,
project, run and locked input, then waits for that existing run and downloads its
actual artifacts. It does not create an account, project, payment or task, and
does not call the task resume action. At the end it checks the original immutable
execution request replay and verifies the ledger and model attempts are unchanged.

From the repository root, set the exact directory printed in the first test's
private provenance record, then run only the resume spec:

```powershell
$env:BB_E2E_LOCAL_PRELAUNCH = '1'
$env:BB_E2E_REAL_MODEL = '1'
$env:BB_E2E_RQ_REAL_SAMPLE = '1'
$env:BB_E2E_BASE_URL = 'http://localhost:18087'
$env:BB_E2E_BROWSER_CHANNEL = 'msedge'
$env:BB_PRELAUNCH_RQ_RESUME_DIR = 'C:/Users/lezhai/Downloads/Bondbuddy/quality-prelaunch-20261107/<original-run-directory>'
node node_modules/@playwright/test/cli.js test --config=apps/web/playwright.config.ts local-prelaunch-real-sample-resume.spec.ts --workers=1 --retries=0
```

A failed, cancelled or paused product run remains a red outcome. This observer
does not change its state. An expired session must be restored through normal
authentication for the same synthetic account; it is not permission to change
task ownership or manufacture a new result. Original failed evidence is retained
alongside the new timestamped observation report.
