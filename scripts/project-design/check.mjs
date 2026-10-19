import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/web/tsconfig.project-design.json']);
run(['node_modules/typescript/bin/tsc', 'apps/web/src/project-design/model.test.ts', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop', '--skipLibCheck', '--strict', '--outDir', '.local-design/model-tests']);
run(['--test', '.local-design/model-tests/model.test.js']);
run(['node_modules/typescript/bin/tsc', 'apps/web/src/dashboard-model.test.ts', 'apps/web/src/update-form.test.ts', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM,DOM.Iterable', '--esModuleInterop', '--skipLibCheck', '--strict', '--outDir', '.local-design/production-tests']);
run(['--test', '.local-design/production-tests/dashboard-model.test.js', '.local-design/production-tests/update-form.test.js']);
run(['../../node_modules/vite/bin/vite.js', 'build', '--mode', 'project-design', '--outDir', 'dist-project-design'], resolve(root, 'apps/web'));
