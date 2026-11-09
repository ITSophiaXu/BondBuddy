import type { PoolClient } from 'pg';
import { Problem, readBlobToFile, type BlobDigest, type PrivateBlobs } from './data.js';

type StoredMaterial = { owner_user_id: string; project_id: string; id: string; version: number; object_key: string; sha256: string; byte_size: string | number };

/** Only call after the full read matched this immutable material's declared bytes. */
export async function recordUploadIntegrity(client: PoolClient, material: StoredMaterial, verified: BlobDigest) {
  if (verified.sha256 !== material.sha256.trim() || verified.byteSize !== Number(material.byte_size))
    throw new Problem(503,'DATA_UNAVAILABLE','Saved material integrity differs');
  if (!verified.etag) return; // Legacy/test adapters must retain the full-read path.
  await client.query(`INSERT INTO bb_upload_integrity_receipts
    (owner_user_id,project_id,material_id,material_version,object_key,sha256,byte_size,object_etag)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [material.owner_user_id,material.project_id,material.id,material.version,material.object_key,verified.sha256,verified.byteSize,verified.etag]);
}

export async function verifyStoredUpload(client: PoolClient, blobs: PrivateBlobs, material: StoredMaterial, replay = false) {
  if (replay && blobs.headVersion) {
    const receipt = await client.query(`SELECT object_etag FROM bb_upload_integrity_receipts
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
        AND object_key=$5 AND sha256=$6 AND byte_size=$7`,
      [material.owner_user_id,material.project_id,material.id,material.version,material.object_key,material.sha256.trim(),material.byte_size]);
    if (receipt.rowCount) {
      const current = await blobs.headVersion(material.object_key);
      if (!current) throw new Problem(503,'DATA_UNAVAILABLE','Saved material is temporarily unavailable');
      if (current.byteSize === Number(material.byte_size) && receipt.rows.some(row => row.object_etag === current.etag)) return;
    }
  }
  // First deduplication, legacy receipts and changed versions always verify the full body.
  const verified = await readBlobToFile(blobs, material.object_key, null, Number(material.byte_size))
    .catch(error => { if (error instanceof Problem) return null; throw error; });
  if (!verified || verified.byteSize !== Number(material.byte_size) || verified.sha256 !== material.sha256.trim())
    throw new Problem(503,'DATA_UNAVAILABLE','Saved material is temporarily unavailable');
  await recordUploadIntegrity(client, material, verified);
}
