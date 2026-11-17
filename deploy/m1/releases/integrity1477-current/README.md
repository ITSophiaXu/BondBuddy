# Browser repair on the retained encrypted-source release

This package applies the reviewed integrity browser deployment repair while retaining the current 78-file business archive and both worker images. The historical `integrity1477` package pins an earlier archive/helper and must not be replayed after the encrypted-source release.

The new manifest fixes the current helper preimage, current business archive, and exact public installer. Staging, activation and node installation use separate receipt directories; the historical release and rollback evidence remain intact. Pool limits, service-template contents, retained launch bindings and business bytes are unchanged. No database migration or image rebuild is required.

Follow the lifecycle and shared-lock requirements in `../integrity1477/README.md`. Reconcile the already installed official-site listener against its original receipt instead of reinstalling it. Use the existing native Start and drain path. Arm the next boot only after inspecting the current node; do not assume an old container identifier still exists. Do not start bootstrap twice in an epoch where consumers have registered.

Generate with `node deploy/m1/releases/integrity1477-current/package.mjs /data/workspaces/<private-output> [fixed-source-commit]`. The optional source commit identifies a Git archive exported from that exact reviewed commit. Preserve LF source bytes. Run deployment contract and encrypted-source package checks, exercise the exact public installer in a disposable network-none filesystem, and verify both real slot UserData lengths during staging.

Activation and business acceptance are separate. Verify both registered services, installed profiles, init, official egress, unchanged 78 business files and images. A new associated integrity run must then produce effective queries, screenshots and a downloadable Word through normal authorization and accounting. Keep the original failed run and its released reservation intact.
