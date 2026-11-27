import COS from 'cos-nodejs-sdk-v5';
import { azureBlobs, type PrivateBlobs } from './data.js';
import { cosBlobs } from './cos-storage.js';

export type StorageProvider = 'azure' | 'cos';

/** Resolve the application object store without silently falling back to Azure. */
export function storageProviderFromEnv(env: NodeJS.ProcessEnv = process.env): StorageProvider {
  const provider = env.BB_STORAGE_PROVIDER || 'azure';
  if (provider !== 'azure' && provider !== 'cos') throw new Error('BB_STORAGE_PROVIDER must be azure or cos');
  return provider;
}

export function privateBlobsFromEnv(env: NodeJS.ProcessEnv = process.env): PrivateBlobs | null {
  if (storageProviderFromEnv(env) === 'azure') {
    if (!env.AZURE_STORAGE_CONNECTION_STRING) return null;
    return azureBlobs(env.AZURE_STORAGE_CONNECTION_STRING, env.BB_STORAGE_CONTAINER || 'bondbuddy-private');
  }
  const { BB_COS_SECRET_ID: secretId, BB_COS_SECRET_KEY: secretKey, BB_COS_BUCKET: bucket, BB_COS_REGION: region } = env;
  if (!secretId || !secretKey || !bucket || !region)
    throw new Error('COS storage requires BB_COS_SECRET_ID, BB_COS_SECRET_KEY, BB_COS_BUCKET and BB_COS_REGION');
  if (!/^[a-z0-9][a-z0-9-]*-[0-9]+$/.test(bucket) || !/^[a-z][a-z0-9-]+$/.test(region))
    throw new Error('Invalid COS bucket or region');
  if (env.BB_DIRECT_BLOB_UPLOADS === '1')
    throw new Error('COS direct browser upload is not yet supported');
  return cosBlobs(new COS({ SecretId: secretId, SecretKey: secretKey }), bucket, region);
}
