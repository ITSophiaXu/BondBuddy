# Generation preparation delayed-save investigation (synthetic)

Conclusion: the suspected old-save-response overwrite was not reproduced. No product source changes were made.

The public-HTTP browser fixture used the production FileGenerationPanel at base 7f3c4ac77ef2128a5c9793bc31a20f2b8c84c9e5 plus current prelaunch edits. Edge, desktop 1440 × 960. The catalogue contained two synthetic entries; it did not use an online account, run a model or charge credits.

One probe held three actual preparation PUT replies independently and exercised native mouse/locator clicks, native keyboard input, requirements save and refresh. It verified:

- During the first held save, the form was inert and an extra physical mouse click created no concurrent preparation write.
- Selecting entry 1 after the prior response sent exactly [entry-1]. During its held response the busy render temporarily showed unchecked / 0 files; after reply it showed checked / 1 file / 3,458 points.
- Native typing during inert did not enter the form. It was never accepted by the page. After the reply, accepted requirements plus the selected entry were saved and survived refresh.
- The three writes each used the current expected_revision. Zero quote and batch submissions occurred. No unexpected fixture requests or page errors occurred.

Code explanation: act() synchronously sets busy and paints before invoking the mutation. It therefore temporarily paints the old value while waiting. Controls are inert, and another act is rejected by the busy guard. The save response updates data.preparation and revision, never this.prep, which is the rendered local input. Thus the transient unchecked DOM explains a check-tool failure but does not demonstrate a stale response overwriting accepted input.

There is a visible saving-period friction: the form locks while the request is in flight and briefly shows the prior selection. This investigation did not change it because the requested race was unconfirmed; a separate UX change would need its own scope and evidence.

Actual command (apps/web):

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5175'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
npm exec playwright -- test tests/generation-save-investigation.spec.ts --grep 'investigation:' --output .test-output/generation-save-investigation
```

Result: 1 passed, 0 failed, 0 skipped, 7.3 s (test body 3.4 s). The temporary spec copied the existing file-template-preparation.spec.ts setup, then appended the probe preserved in probe.spec.txt. The temporary spec and output directory were removed after the run. Both PNGs were visually inspected.
