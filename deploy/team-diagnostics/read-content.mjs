// Executed inside the trusted API container. Credentials never leave the container.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require = createRequire('/app/apps/api/package.json');
const {BlobServiceClient} = require('@azure/storage-blob');
let execDeadlineExpired = false;
try {
  const row = JSON.parse(process.argv[2]);
  const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  if (!id.test(row.owner_user_id) || !id.test(row.project_id) || !['prompt','result','exec'].includes(row.kind)) throw Error();
  const selected = Object.hasOwn(row, 'file');
  if (selected && (row.kind !== 'result' || row.file !== 'operations.json' || !id.test(row.run_id) || !id.test(row.attempt_id))) throw Error();
  const prefix = `users/${row.owner_user_id}/projects/${row.project_id}/`;
  const relative = row.object_key?.startsWith(prefix) ? row.object_key.slice(prefix.length) : '';
  const expected = row.kind === 'prompt' ? /^snapshots\/[A-Za-z0-9_-]{1,128}$/ : row.kind === 'result' ? /^provider-results\/[A-Za-z0-9_-]+-[a-f0-9]{64}\.json$/ : null;
  if (expected ? !expected.test(relative) : (!id.test(row.run_id) || !id.test(row.attempt_id) || relative !== `runs/${row.run_id}/attempts/${row.attempt_id}/exec.log`)) throw Error();
  if (!/^[a-f0-9]{64}$/.test(row.sha256?.trim())) throw Error();
  const maxBytes = row.kind === 'exec' ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
  const service = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
  const blob = service.getContainerClient('bondbuddy-private').getBlockBlobClient(row.object_key);
  // Exec captures can be 20 MiB; every page still verifies the complete Blob.
  // This fixed bound must remain below the broker's exec command deadline.
  const controller = new AbortController(); const timer = setTimeout(() => {
    if (row.kind === 'exec') execDeadlineExpired = true;
    controller.abort();
  }, row.kind === 'exec' ? 120000 : 35000);
  try {
    const properties = await blob.getProperties({abortSignal: controller.signal});
    if (!Number.isSafeInteger(properties.contentLength) || properties.contentLength > maxBytes ||
        row.byte_size !== null && properties.contentLength !== Number(row.byte_size) ||
        selected && (row.byte_size === null || !Number.isSafeInteger(Number(row.byte_size)) || typeof properties.etag !== 'string' || !properties.etag)) throw Error();
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
    let text;
    let child;
    if (selected) {
      // The caller selects a fixed filename, never a Blob key. Only the verified
      // registered result can supply its immutable, exactly scoped descriptor.
      const result = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
      if (result?.version !== 'codex-file-word-v1' || !result.files || typeof result.files !== 'object' || Array.isArray(result.files) || !Object.hasOwn(result.files, 'operations.json')) throw Error();
      child = result.files['operations.json'];
      if (!child || typeof child !== 'object' || Array.isArray(child) || !/^[a-f0-9]{64}$/.test(child.sha256) || !Number.isSafeInteger(child.byte_size) || child.byte_size < 1 || child.byte_size > 1024 * 1024) throw Error();
      const expectedKey = `owners/${row.owner_user_id}/projects/${row.project_id}/runs/${row.run_id}/file-authoring/${row.attempt_id}/${child.sha256}/operations.json`;
      if (child.key !== expectedKey) throw Error();
      const childBlob = service.getContainerClient('bondbuddy-private').getBlockBlobClient(child.key);
      const childProperties = await childBlob.getProperties({abortSignal: controller.signal});
      if (childProperties.contentLength !== child.byte_size || typeof childProperties.etag !== 'string' || !childProperties.etag) throw Error();
      const childResponse = await childBlob.download(0, child.byte_size + 1, {abortSignal: controller.signal, conditions: {ifMatch: childProperties.etag}});
      const childChunks = []; let childSize = 0;
      for await (const chunk of childResponse.readableStreamBody ?? []) {
        childSize += chunk.length;
        if (childSize > child.byte_size) throw Error();
        childChunks.push(Buffer.from(chunk));
      }
      const childBytes = Buffer.concat(childChunks);
      if (childSize !== child.byte_size || createHash('sha256').update(childBytes).digest('hex') !== child.sha256) throw Error();
      text = new TextDecoder('utf-8', {fatal: true}).decode(childBytes);
      JSON.parse(text);
    } else text = bytes.toString('utf8');
    for (const [name,value] of Object.entries(process.env)) {
      if (value?.length >= 8 && /KEY|TOKEN|PASSWORD|SECRET|CONNECTION_STRING/i.test(name)) text = text.split(value).join('[redacted]');
    }
    process.stdout.write(selected ? JSON.stringify({verified_parent_sha256: row.sha256.trim(), verified_child_sha256: child.sha256,
      verified_child_byte_size: child.byte_size, redacted_content_base64: Buffer.from(text, 'utf8').toString('base64')}) : text);
  } finally { clearTimeout(timer); }
} catch {
  // Fixed exit status distinguishes an observed deadline from all other errors;
  // never forward SDK errors, object URLs, connection strings or content.
  process.stderr.write(execDeadlineExpired ? 'CONTENT_READ_TIMEOUT\n' : 'CONTENT_UNAVAILABLE_OR_INTEGRITY_FAILED\n');
  process.exitCode = execDeadlineExpired ? 3 : 2;
}
