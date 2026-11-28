import COS from 'cos-nodejs-sdk-v5';
import { deleteCosObjectPermanently } from './cos-permanent-delete.js';

const backupId = /^(\d{8}T\d{6}Z)-[A-Za-z0-9._-]{1,64}$/;
export type CosBackupRetentionResult = { backups: number; deleted: number; deletedBlobs: number; kept: number; failed: number };

function backupTime(key: string): Date | null {
  const id = key.split('/')[0], m = backupId.exec(id);
  if (!m || !key.includes('/')) return null;
  const t = m[1];
  const at = new Date(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export async function pruneCosOffhostBackups(env: NodeJS.ProcessEnv, retentionDays: number, now = new Date(), injected?: COS): Promise<CosBackupRetentionResult> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('Invalid COS backup retention');
  const id = env.BB_COS_BACKUP_SECRET_ID || env.BB_COS_SECRET_ID;
  const secret = env.BB_COS_BACKUP_SECRET_KEY || env.BB_COS_SECRET_KEY;
  const bucket = env.BB_COS_BACKUP_BUCKET, region = env.BB_COS_BACKUP_REGION || env.BB_COS_REGION;
  if (!id || !secret || !bucket || !region || bucket === env.BB_COS_BUCKET) throw new Error('Separate COS backup bucket and credentials required');
  if (Boolean(env.BB_COS_BACKUP_SECRET_ID) !== Boolean(env.BB_COS_BACKUP_SECRET_KEY)) throw new Error('Incomplete COS backup credential pair');
  if (!/^[a-z0-9][a-z0-9-]*-[0-9]+$/.test(bucket) || !/^[a-z][a-z0-9-]+$/.test(region)) throw new Error('Invalid COS backup bucket or region');
  const client = injected ?? new COS({ SecretId: id, SecretKey: secret });
  await client.headBucket({ Bucket: bucket, Region: region });
  if ((await client.getBucketAcl({ Bucket: bucket, Region: region })).ACL !== 'private') throw new Error('COS backup bucket must be private');
  const versioning = await client.getBucketVersioning({ Bucket: bucket, Region: region });
  const state = versioning.VersioningConfiguration?.Status;
  if (state !== undefined && state !== 'Enabled' && state !== 'Suspended') throw new Error('Unknown COS backup versioning state');
  const groups = new Map<string, { at: Date; keys: Set<string> }>();
  const record = (key: string) => {
    const at = backupTime(key); if (!at) return;
    const name = key.split('/')[0];
    const group = groups.get(name) ?? { at, keys: new Set<string>() };
    group.keys.add(key); groups.set(name, group);
  };
  if (!state) {
    let marker: string | undefined;
    do {
      const page = await client.getBucket({ Bucket: bucket, Region: region, MaxKeys: 1000, ...(marker ? { Marker: marker } : {}) });
      for (const item of page.Contents ?? []) record(item.Key);
      const next = page.IsTruncated === 'true' ? page.NextMarker || page.Contents?.at(-1)?.Key : undefined;
      if (page.IsTruncated === 'true' && (!next || next === marker)) throw new Error('COS backup listing cursor did not advance');
      marker = next;
    } while (marker);
  } else {
    let marker: string | undefined, versionMarker: string | undefined;
    do {
      const page = await client.listObjectVersions({ Bucket: bucket, Region: region, MaxKeys: '1000',
        ...(marker !== undefined ? { Marker: marker } : {}), ...(versionMarker !== undefined ? { VersionIdMarker: versionMarker } : {}) });
      for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) record(item.Key);
      if (page.IsTruncated !== 'true') break;
      if (!page.NextMarker || page.NextMarker === marker && page.NextVersionIdMarker === versionMarker)
        throw new Error('COS backup version cursor did not advance');
      marker = page.NextMarker; versionMarker = page.NextVersionIdMarker;
    } while (true);
  }
  const completed = new Set<string>();
  for (const name of groups.keys()) {
    try { await client.headObject({ Bucket: bucket, Region: region, Key: `${name}/offhost-manifest.json` }); completed.add(name); }
    catch (error) {
      const e = error as { code?: string; statusCode?: number } | null;
      if (e?.code !== 'NoSuchKey' && !(e?.statusCode === 404 && e.code !== 'NoSuchBucket')) throw error;
    }
  }
  const newest = [...groups.entries()].filter(([name]) => completed.has(name))
    .sort((a, b) => b[1].at.getTime() - a[1].at.getTime())[0]?.[0];
  if (!newest) return { backups: groups.size, deleted: 0, deletedBlobs: 0, kept: groups.size, failed: 0 };
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let deleted = 0, deletedBlobs = 0, failed = 0;
  for (const [name, group] of groups) {
    if (name === newest || group.at.getTime() >= cutoff) continue;
    const keys = [...group.keys].sort((a, b) => Number(a.endsWith('/offhost-manifest.json')) - Number(b.endsWith('/offhost-manifest.json')));
    let complete = true;
    for (const key of keys) {
      try { await deleteCosObjectPermanently(client, bucket, region, key); deletedBlobs++; }
      catch { failed++; complete = false; break; }
    }
    if (complete) deleted++;
  }
  return { backups: groups.size, deleted, deletedBlobs, kept: groups.size - deleted, failed };
}
