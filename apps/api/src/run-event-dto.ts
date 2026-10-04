import { Value } from '@sinclair/typebox/value';
import { schemas, type RunEvent } from '@bondbuddy/contracts';

/** Public events are a projection, never a copy of worker/audit payloads. */
export function runEventPayloadDto(payload: unknown): RunEvent['payload'] {
  const result: Record<string, unknown> = {};
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return result;
  const source = payload as Record<string, unknown>;
  const properties = schemas.RunEvent.properties.payload.properties;
  for (const [key, schema] of Object.entries(properties)) {
    if (Object.hasOwn(source, key) && Value.Check(schema, source[key])) result[key] = source[key];
  }
  return result;
}
