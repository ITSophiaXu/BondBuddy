import type COS from 'cos-nodejs-sdk-v5';

/** Remove every physical version of a key. Callers must serialize application writes first. */
export async function deleteCosObjectPermanently(client: COS, bucket: string, region: string, key: string): Promise<void> {
  const object = { Bucket: bucket, Region: region, Key: key };
  const versioning = await client.getBucketVersioning({ Bucket: bucket, Region: region });
  const state = versioning.VersioningConfiguration?.Status;
  if (state !== undefined && state !== 'Enabled' && state !== 'Suspended')
    throw new Error('Unknown COS bucket versioning state');
  if (!state) {
    await client.deleteObject(object);
  } else {
    // Re-list from the start after every batch: deleting during cursor pagination can skip versions.
    for (let pass = 0; pass < 100; pass++) {
      const page = await client.listObjectVersions({ Bucket: bucket, Region: region, Prefix: key, MaxKeys: '1000' });
      const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].filter(item => item.Key === key);
      if (!versions.length) {
        if (page.IsTruncated === 'true') throw new Error('COS object version listing is ambiguous');
        break;
      }
      for (const version of versions) {
        if (version.VersionId === undefined || version.VersionId === '') throw new Error('COS object version ID unavailable');
        // Installed SDK runtime forwards VersionId to the request query; its declaration omits this field.
        await client.deleteObject({ ...object, VersionId: version.VersionId } as Parameters<typeof client.deleteObject>[0]);
      }
      if (pass === 99) throw new Error('COS object version cleanup exceeded limit');
    }
  }
  try { await client.headObject(object); }
  catch (error) {
    const e = error as { code?: string; statusCode?: number } | null;
    if (e?.code === 'NoSuchKey' || e?.statusCode === 404 && e.code !== 'NoSuchBucket') return;
    throw error;
  }
  throw new Error('COS object still exists after deletion');
}
