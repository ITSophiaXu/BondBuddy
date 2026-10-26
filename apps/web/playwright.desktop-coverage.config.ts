import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Current desktop user journeys. Historical screenshot collectors and live
// supplier/payment tests have separate acceptance requirements.
// Run from apps/web: several existing fixtures resolve styles from that cwd.
export default defineConfig({
  ...base,
  workers: 2,
  retries: 0,
  testMatch: [
    'authoring-onboarding.spec.ts', 'authoring-continuation.spec.ts',
    'authoring-source-guide.spec.ts', 'prospectus-saved-reentry.spec.ts',
    'project-execution.spec.ts', 'project-document-journey.spec.ts',
    'review-workspace.spec.ts', 'review-flow-editor.spec.ts', 'review-followup.spec.ts',
    'review-result-continuity.spec.ts', 'review-editor-recovery.spec.ts', 'review-completion-download.spec.ts',
    'desktop-file-workflow.spec.ts', 'word-roundtrip.spec.ts',
    'project-file-return.spec.ts',
    'consistency-history.spec.ts', 'consistency-update-history.spec.ts',
    'consistency-confirmation.spec.ts', 'consistency-manual-reading.spec.ts',
    'batch-delivery-workbench.spec.ts', 'file-generation-workbench.spec.ts', 'generation-entry-intent.spec.ts',
    'material-draft-comparison.spec.ts', 'material-reference-picker.spec.ts',
    'material-task-draft.spec.ts', 'qa-result-next.spec.ts', 'project-qa-recovery.spec.ts',
    'm4-workspace.spec.ts', 'project-assistant.spec.ts', 'assistant-continuation.spec.ts', 'result-handoff-assistant.spec.ts',
    'integrity-continuation.spec.ts', 'integrity-delivery.spec.ts',
    'parallel-projects.spec.ts', 'all-projects.spec.ts', 'billing-navigation.spec.ts',
    'register.spec.ts', 'account.spec.ts',
    'pr745-market-acceptance.spec.ts',
  ],
  grepInvert: /component comparison|matches.*prototype|prototype.*implementation|(?:320|390|430)(?:px)?\b|mobile|collects.*screenshots|prototype screenshots|prototype comparison capture/i,
  outputDir: '../../.local/desktop-coverage',
  reporter: [['list'], ['json', { outputFile: '../../.local/desktop-coverage-report.json' }]],
  use: { ...base.use, viewport: { width: 1440, height: 960 } },
});
