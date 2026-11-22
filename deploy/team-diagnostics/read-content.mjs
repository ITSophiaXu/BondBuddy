// Executed inside the trusted API container. Credentials never leave the container.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require = createRequire('/app/apps/api/package.json');
const {BlobServiceClient} = require('@azure/storage-blob');
try {
  const row = JSON.parse(process.argv[2]);
  const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  if (!id.test(row.owner_user_id) || !id.test(row.project_id) || !['prompt','result','exec'].includes(row.kind)) throw Error();
  const prefix = `users/${row.owner_user_id}/projects/${row.project_id}/`;
  const relative = row.object_key?.startsWith(prefix) ? row.object_key.slice(prefix.length) : '';
  const expected = row.kind === 'prompt' ? /^snapshots\/[A-Za-z0-9_-]{1,128}$/ : row.kind === 'result' ? /^provider-results\/[A-Za-z0-9_-]+-[a-f0-9]{64}\.json$/ : null;
  if (expected ? !expected.test(relative) : (!id.test(row.run_id) || !id.test(row.attempt_id) || relative !== `runs/${row.run_id}/attempts/${row.attempt_id}/exec.log`)) throw Error();
  if (!/^[a-f0-9]{64}$/.test(row.sha256?.trim())) throw Error();
  const maxBytes = row.kind === 'exec' ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
  const service = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
  const blob = service.getContainerClient('bondbuddy-private').getBlockBlobClient(row.object_key);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 35000);
  try {
    const properties = await blob.getProperties({abortSignal: controller.signal});
    if (!Number.isSafeInteger(properties.contentLength) || properties.contentLength > maxBytes ||
        row.byte_size !== null && properties.contentLength !== Number(row.byte_size)) throw Error();
    const chunks = []; let size = 0;
    if(properties.contentLength) {
      const response = await blob.download(0, properties.contentLength + 1, {abortSignal: controller.signal, conditions: {ifMatch: properties.etag}});
      for await (const chunk of response.readableStreamBody ?? []) {
        size += chunk.length; if (size > properties.contentLength || size > maxBytes) throw Error();
        chunks.push(Buffer.from(chunk));
      }
    }
    const bytes = Buffer.concat(chunks);
    if (size !== properties.contentLength || createHash('sha256').update(bytes).digest('hex') !== row.sha256.trim()) throw Error();
    let text = bytes.toString('utf8');
    for (const [name,value] of Object.entries(process.env)) {
      if (value?.length >= 8 && /KEY|TOKEN|PASSWORD|SECRET|CONNECTION_STRING/i.test(name)) text = text.split(value).join('[redacted]');
    }
    process.stdout.write(text);
  } finally { clearTimeout(timer); }
} catch {
  process.stderr.write('CONTENT_UNAVAILABLE_OR_INTEGRITY_FAILED\n'); process.exitCode = 2;
}
