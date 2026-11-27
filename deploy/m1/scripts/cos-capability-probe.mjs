// Run only against an isolated, empty COS test bucket. No customer objects are read.
import { randomUUID } from 'node:crypto';
import COS from 'cos-nodejs-sdk-v5';

const env = process.env;
if (env.BB_COS_PROBE_ACK !== 'isolated-test-bucket') throw new Error('Explicit isolated COS test bucket acknowledgement required');
const { BB_COS_TEST_SECRET_ID: id, BB_COS_TEST_SECRET_KEY: secret,
  BB_COS_TEST_BUCKET: bucket, BB_COS_TEST_REGION: region } = env;
if (!id || !secret || !bucket || !region) throw new Error('COS test credentials, bucket and region required');
if (!/^[a-z0-9][a-z0-9-]*-[0-9]+$/.test(bucket) || !/^[a-z][a-z0-9-]+$/.test(region))
  throw new Error('Invalid COS test bucket or region');
const client = new COS({ SecretId: id, SecretKey: secret });
const key = `migration-probe/${randomUUID()}`;
const object = { Bucket: bucket, Region: region, Key: key };
const result = { conditionalPut: 'unknown', conditionalDelete: 'unknown', rangeRead: 'unknown', versioning: 'unknown', cleanup: 'unknown' };
let failure;

try {
  await client.headBucket({ Bucket: bucket, Region: region });
  try {
    const versioning = await client.getBucketVersioning({ Bucket: bucket, Region: region });
    result.versioning = versioning.VersioningConfiguration?.Status || 'disabled';
  } catch (error) { result.versioning = `error:${error?.code || error?.statusCode || 'unknown'}`; }
  await client.putObject({ ...object, Body: Buffer.from('first'), ContentLength: 5,
    Headers: { 'If-None-Match': '*' } });
  let duplicateRejected = false;
  try { await client.putObject({ ...object, Body: Buffer.from('second'), ContentLength: 6,
    Headers: { 'If-None-Match': '*' } }); }
  catch (error) { duplicateRejected = error?.statusCode === 412; if (!duplicateRejected) throw error; }
  const body = (await client.getObject(object)).Body;
  result.conditionalPut = duplicateRejected && body.equals(Buffer.from('first')) ? 'supported' : 'unsupported';
  const range = await client.getObject({ ...object, Range: 'bytes=0-2' });
  result.rangeRead = range.Body.equals(Buffer.from('fir')) ? 'supported' : 'failed';
  const etag = (await client.headObject(object)).ETag;
  let staleRejected = false;
  try { await client.deleteObject({ ...object, Headers: { 'If-Match': '"stale-etag"' } }); }
  catch (error) { staleRejected = error?.statusCode === 412; if (!staleRejected) throw error; }
  const exists = await client.headObject(object).then(() => true, error => {
    if (error?.statusCode === 404) return false;
    throw error;
  });
  result.conditionalDelete = staleRejected && exists ? 'supported' : 'unsupported';
} catch (error) { failure = error; }
finally {
  try {
    const versions = await client.listObjectVersions({ Bucket: bucket, Region: region, Prefix: key, MaxKeys: '1000' });
    const items = [...(versions.Versions || []), ...(versions.DeleteMarkers || [])].filter(item => item.Key === key);
    if (versions.IsTruncated === 'true') throw new Error('Probe version list unexpectedly truncated');
    if (result.versioning === 'Enabled' || result.versioning === 'Suspended') {
      for (const item of items) {
        if (!item.VersionId || item.VersionId === 'null') throw new Error('Null COS object version requires manual probe cleanup');
        await client.deleteObject({ ...object, VersionId: item.VersionId });
      }
      const after = await client.listObjectVersions({ Bucket: bucket, Region: region, Prefix: key, MaxKeys: '1000' });
      if ([...(after.Versions || []), ...(after.DeleteMarkers || [])].some(item => item.Key === key))
        throw new Error('Probe versions remain after cleanup');
    } else {
      await client.deleteObject(object);
      const remains = await client.headObject(object).then(() => true, error => {
        if (error?.statusCode === 404) return false;
        throw error;
      });
      if (remains) throw new Error('Probe object remains after cleanup');
      const after = await client.listObjectVersions({ Bucket: bucket, Region: region, Prefix: key, MaxKeys: '1000' });
      if ([...(after.Versions || []), ...(after.DeleteMarkers || [])].some(item => item.Key === key))
        throw new Error('Probe versions remain after cleanup');
    }
    result.cleanup = 'verified';
  } catch (error) {
    result.cleanup = `failed:${error?.code || error?.statusCode || 'unknown'}`;
    failure ||= error;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (failure || result.conditionalPut !== 'supported' || result.conditionalDelete !== 'supported' ||
    result.rangeRead !== 'supported' || result.cleanup !== 'verified')
  process.exitCode = 1;
