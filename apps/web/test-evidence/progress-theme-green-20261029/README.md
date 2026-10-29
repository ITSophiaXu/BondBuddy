# Progress bars follow the theme green

User request (2026-10-29): change the blue progress bar in the question recognition panel to the theme green.

The shared native `progress` rule uses `accent-color: var(--green)`. This covers indeterminate QA activity and native determinate progress without changing animation, dimensions, values, controls, or task behavior. Existing explicitly styled green meters retain their styling.

Base: `5ec099a2` (develop). Implementation: `apps/web/src/style.css`; affected screenshot component: `apps/web/src/project-qa-workspace.ts` and `.css`. The existing QA design reference is `product-prototype/public/qa-document.html` at that base; it has no running-task panel, so the user's screenshot is the visual requirement for this state. Only the requested color changes.

## Same-size comparison

Real QA frontend, existing synthetic HTTP fixtures, Edge headless. No backend tasks, model calls, charging, or API writes. Desktop viewport: 1440 × 1000; mobile: 390 × 844. Images crop the question recognition panel.

- [Before, desktop](before-desktop.png): same page with the original `accent-color: auto` restored, reproducing the browser blue.
- [After, desktop](after-desktop.png): theme green in the running, indeterminate state.
- [After, mobile](after-mobile.png): same theme green and responsive layout.

The computed accent is `rgb(36, 86, 71)`, matching the page's `--green: #245647`. Indeterminate state remains true. Browser errors, unexpected fixture calls, and API writes: 0. Both determinate and indeterminate native meters were also visually checked in Edge.

## Validation

- `tsc -p apps/api/tsconfig.json` (build required local API declarations for existing frontend test imports): passed.
- `tsc -p apps/web/tsconfig.json --noEmit`: passed.
- `vite build apps/web --config apps/web/vite.config.ts`: passed; existing bundle-size warning remains.
- `playwright test project-qa-task-routing.spec.ts --config playwright.config.ts`: 5 passed using Edge and the isolated local frontend at port 5189.
- `git diff --check`: passed.

No migrations, new dependencies, API, worker, or billing changes. Development and self-check complete; user integration acceptance pending; not deployed.
