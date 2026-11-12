// Host dispatch changes execution environment only. Discovery, sharding, test
// timeouts, assertions and result evaluation remain in run.mjs.
export const HOST_PROFILES = Object.freeze({
  'apps/worker/src/codex-file-authoring.test.ts': Object.freeze({ id: 'native-sandbox', runner: 'node' }),
  'apps/worker/src/review-revision-cli-native.test.ts': Object.freeze({ id: 'native-sandbox', runner: 'node' }),
  'apps/worker/src/integrity-desktop.test.ts': Object.freeze({ id: 'native-desktop', runner: 'node' }),
  'python/tests/test_ocr.py': Object.freeze({ id: 'native-ocr', runner: 'python' }),
  'scripts/billing-functional/panel-session.test.mjs': Object.freeze({ id: 'windows-billing', runner: 'node' }),
});

export const HOST_ENV_KEYS = Object.freeze(['PR_GATE_HOST_PLAN', 'PR_GATE_HOST_DIRECTORY']);
