import { createConnection, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Value } from '@sinclair/typebox/value';
import { ExecutionNodeContextSchema, type ExecutionNodeContext } from '@bondbuddy/contracts';

export interface ExecutionTransportHealth {
  refresh(): Promise<void>;
  ready(): boolean;
  close(): void;
}
export type ExecutionTransportProtocol = {
  TRANSPORT_REFRESH_VERSION: string;
  TRANSPORT_ADMISSION_MARGIN_MS: number;
  validateTransportRefreshResponse(
    request: unknown,
    response: unknown,
    now: number,
  ): { admissionAllowed: boolean; expiresAt: number | null };
};
const failed = () => new Error('EXECUTION_TRANSPORT_REFRESH_FAILED');
// Match the database's thirty-second readiness freshness. A slow refresh may
// reuse a receipt, but can never extend that receipt's original lifetime.
const MAX_RECEIPT_AGE_MS = 30000;

/** The private protocol/response validator is supplied by the transport module.
 * Only non-secret context is sent; certificate and credential bytes never enter
 * this process or its model invocation. */
export function createExecutionTransportClient({
  socketPath,
  context,
  serviceId,
  protocol,
  timeoutMs = 20000,
  now = Date.now,
  monotonicNow = () => performance.now(),
}: {
  socketPath: string;
  context: ExecutionNodeContext;
  serviceId: string;
  protocol: ExecutionTransportProtocol;
  timeoutMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
}): ExecutionTransportHealth {
  if (
    !isAbsolute(socketPath) ||
    !Value.Check(ExecutionNodeContextSchema, context) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(serviceId) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 20000 ||
    typeof protocol.TRANSPORT_REFRESH_VERSION !== 'string' ||
    typeof protocol.validateTransportRefreshResponse !== 'function' ||
    !Number.isSafeInteger(protocol.TRANSPORT_ADMISSION_MARGIN_MS) ||
    protocol.TRANSPORT_ADMISSION_MARGIN_MS < 1
  )
    throw Error('EXECUTION_TRANSPORT_CONFIG_INVALID');
  const request = {
    version: protocol.TRANSPORT_REFRESH_VERSION,
    context: JSON.parse(JSON.stringify(context)),
    service_id: serviceId,
  };
  const bytes = Buffer.from(JSON.stringify(request) + '\n');
  if (bytes.length > 4096) throw Error('EXECUTION_TRANSPORT_CONFIG_INVALID');
  type Clock = { wall: number; mono: number };
  const clock = (): Clock | null => {
    try {
      const wall = now(),
        mono = monotonicNow();
      return Number.isSafeInteger(wall) && Number.isFinite(mono) && mono >= 0
        ? { wall, mono }
        : null;
    } catch {
      return null;
    }
  };
  let closed = false,
    flight: Promise<void> | null = null,
    active: Socket | null = null,
    activeDeadline: number | null = null;
  let decision: {
    expiresAt: number;
    deadline: number;
    wallHighWater: number;
    monoHighWater: number;
  } | null = null;
  const ready = () => {
    if (closed || !decision) return false;
    const at = clock();
    if (
      !at ||
      at.wall < decision.wallHighWater ||
      at.mono < decision.monoHighWater ||
      at.mono >= decision.deadline ||
      (activeDeadline !== null && at.mono >= activeDeadline) ||
      at.wall + protocol.TRANSPORT_ADMISSION_MARGIN_MS >= decision.expiresAt
    ) {
      // Irreversible for this receipt. A wall-clock rollback must never make a
      // previously expired decision valid again, even during a pending refresh.
      decision = null;
      return false;
    }
    decision.wallHighWater = at.wall;
    decision.monoHighWater = at.mono;
    return true;
  };
  const exchange = (start: Clock) =>
    new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(socketPath);
      active = socket;
      activeDeadline = start.mono + timeoutMs;
      const chunks: Buffer[] = [];
      let length = 0,
        settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (active === socket) {
          active = null;
          activeDeadline = null;
        }
        socket.destroy();
        if (!error) {
          const at = clock();
          if (
            !at ||
            at.wall < start.wall ||
            at.mono < start.mono ||
            at.mono - start.mono >= timeoutMs
          )
            error = failed();
        }
        if (error) {
          decision = null;
          reject(failed());
        } else resolve(value);
      };
      // Absolute request deadline, not an inactivity timeout that a trickling
      // response could extend. The existing runtime heartbeat never awaits it.
      const timer = setTimeout(() => finish(failed()), timeoutMs);
      socket.once('connect', () => socket.write(bytes));
      socket.on('data', (chunk) => {
        length += chunk.length;
        if (length > 4096) finish(failed());
        else chunks.push(chunk);
      });
      socket.once('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!text.endsWith('\n')) throw failed();
          finish(undefined, JSON.parse(text.slice(0, -1)));
        } catch {
          finish(failed());
        }
      });
      socket.once('error', () => finish(failed()));
      socket.once('close', () => {
        if (!settled) finish(failed());
      });
    });
  return {
    refresh() {
      if (closed) return Promise.resolve();
      if (flight) return flight;
      // Occupy before any socket/validator await, so independent callers share
      // exactly one request and cannot race a blocked response against a success.
      const work = Promise.resolve().then(async () => {
        try {
          ready();
          const start = clock();
          if (!start) throw failed();
          const response = await exchange(start),
            at = clock();
          if (
            !at ||
            at.wall < start.wall ||
            at.mono < start.mono ||
            at.mono - start.mono >= timeoutMs
          )
            throw failed();
          const validated = protocol.validateTransportRefreshResponse(
            request,
            response,
            Math.max(at.wall, start.wall + Math.ceil(at.mono - start.mono)),
          );
          if (closed) return;
          if (
            !validated.admissionAllowed ||
            validated.expiresAt === null ||
            !Number.isSafeInteger(validated.expiresAt)
          ) {
            decision = null;
            return;
          }
          const deadline =
            start.mono +
            Math.min(
              MAX_RECEIPT_AGE_MS,
              validated.expiresAt - start.wall - protocol.TRANSPORT_ADMISSION_MARGIN_MS,
            );
          decision =
            deadline > at.mono
              ? {
                  expiresAt: validated.expiresAt,
                  deadline,
                  wallHighWater: at.wall,
                  monoHighWater: at.mono,
                }
              : null;
        } catch {
          decision = null;
          throw failed();
        }
      });
      flight = work;
      void work
        .finally(() => {
          if (flight === work) flight = null;
        })
        .catch(() => {});
      return work;
    },
    ready,
    close() {
      closed = true;
      decision = null;
      active?.destroy(failed());
    },
  };
}

/** Legacy processes have no enrollment or transport socket. Managed entrypoints
 * must configure the exact private socket; missing material fails at startup. */
export async function executionTransportFromEnv(
  enrollment: { context: ExecutionNodeContext; service_id: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecutionTransportHealth | undefined> {
  const socketPath = env.BB_EXECUTION_TRANSPORT_SOCKET;
  if (!enrollment) {
    if (socketPath) throw Error('EXECUTION_TRANSPORT_ENROLLMENT_REQUIRED');
    return;
  }
  if (socketPath !== '/run/bondbuddy/service/transport.sock')
    throw Error('EXECUTION_TRANSPORT_SOCKET_REQUIRED');
  const moduleUrl = new URL(
    '../../../deploy/tencent-elasticity/transport-renewal.mjs',
    import.meta.url,
  ).href;
  let protocol: ExecutionTransportProtocol;
  try {
    protocol = (await import(moduleUrl)) as ExecutionTransportProtocol;
  } catch {
    throw Error('EXECUTION_TRANSPORT_PROTOCOL_UNAVAILABLE');
  }
  return createExecutionTransportClient({
    socketPath,
    context: enrollment.context,
    serviceId: enrollment.service_id,
    protocol,
  });
}
