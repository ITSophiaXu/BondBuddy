/** Hide the channel discriminator kept for durable worker/audit processing. */
export function runEventPayloadDto(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const publicPayload = { ...(payload as Record<string, unknown>) };
  delete publicPayload.channel;
  return publicPayload;
}
