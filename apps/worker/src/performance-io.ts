import { digest, type PrivateBlobs } from '@bondbuddy/api/data';
import { withPerformanceSpan } from '@bondbuddy/api/performance-trace';

/** Preserve each adapter's receiver and result; only bounded metadata leaves the call. */
export function performanceBlobs(blobs: PrivateBlobs): PrivateBlobs {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(blobs, {
    get(target, key) {
      const original = Reflect.get(target, key, target);
      if (typeof original !== 'function') return original;
      if (methods.has(key)) return methods.get(key);
      if (!['put', 'getIfExistsBounded', 'getIfExists', 'readToFile'].includes(String(key))) {
        const bound = original.bind(target);
        methods.set(key, bound);
        return bound;
      }
      const wrapped = (...args: unknown[]) =>
        withPerformanceSpan(
          key === 'put' ? 'storage.upload' : 'storage.download',
          {
            object_ref: typeof args[0] === 'string' ? digest(args[0]) : null,
            operation: String(key),
            ...(Buffer.isBuffer(args[1]) ? { input_bytes: args[1].length } : {}),
          },
          async (span) => {
            const result = await Reflect.apply(original, target, args);
            if (Buffer.isBuffer(result)) span.annotate({ output_bytes: result.length });
            else if (
              result &&
              typeof result === 'object' &&
              'byteSize' in result &&
              typeof result.byteSize === 'number'
            )
              span.annotate({ output_bytes: result.byteSize });
            return result;
          },
        );
      methods.set(key, wrapped);
      return wrapped;
    },
  });
}

/** A handled unavailable artifact is a failed promotion, even though it did not throw. */
export function withArtifactPromotionPerformance<T extends { status: string }>(
  attributes: Readonly<Record<string, unknown>>,
  promote: () => T | Promise<T>,
): Promise<T> {
  return withPerformanceSpan('artifact.promote', attributes, async (span) => {
    const result = await promote();
    span.end(result.status === 'available' ? 'succeeded' : 'failed', { outcome: result.status });
    return result;
  });
}
