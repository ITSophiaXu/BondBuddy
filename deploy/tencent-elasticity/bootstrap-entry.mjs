import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {readPrivateJson} from './private-files.mjs';
import {bootstrapNode, writePrivateEnvelope} from './bootstrap.mjs';
import {requireThat, sha256} from './policy.mjs';

// This entry stays disabled until a reviewed, node-role-specific broker/runtime
// adapter is installed. It cannot fall back to a personal provider configuration.
try {
  const config = await readPrivateJson('/etc/bondbuddy/elastic-bootstrap.json');
  const publicManifest = await readPrivateJson('/etc/bondbuddy/elastic-public.json');
  requireThat(config.enabled === true && config.adapter_path.startsWith('/opt/bondbuddy/') &&
    /^[a-f0-9]{64}$/.test(config.adapter_sha256), 'BOOTSTRAP_ADAPTER_REQUIRED');
  requireThat(sha256(await readFile(config.adapter_path)) === config.adapter_sha256, 'BOOTSTRAP_ADAPTER_CHANGED');
  const module = await import(pathToFileURL(config.adapter_path).href);
  const adapter = await module.createConfiguredNodeAdapter({publicManifest});
  await bootstrapNode({publicManifest, metadata: await adapter.metadata(), broker: adapter.broker, runtime: adapter.runtime,
    writeEnvelope: (service, data) => writePrivateEnvelope('/run/bondbuddy/enrollment', service, data)});
} catch {
  process.stderr.write('Execution bootstrap failed closed; node is not ready.\n');
  process.exitCode = 1;
}
