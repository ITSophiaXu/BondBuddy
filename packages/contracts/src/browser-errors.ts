import { Type, type Static, type TSchema } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]{1,128}$' });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });

export const BROWSER_ERROR_LIMIT = { bodyBytes: 2048, messageChars: 1536, perUser: 20, windowSeconds: 300 } as const;
export const browserErrorSchemas = {
  BrowserErrorReportRequest: obj({
    error_type: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,63}$' }),
    fingerprint: hash,
    message: Type.Optional(Type.String({ maxLength: BROWSER_ERROR_LIMIT.messageChars })),
    route_id: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_./:#-]{1,128}$' }),
    frontend_version: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]{1,64}$' }),
    project_id: Type.Optional(id), job_id: Type.Optional(id), client_time: utc
  }),
  BrowserErrorReportResponse: obj({ report_id: id, deduplicated: Type.Boolean(), received_at: utc }),
  BrowserErrorReportView: obj({ report_id: id, error_type: Type.String(), fingerprint: hash,
    message: Type.Union([Type.String(), Type.Null()]), route_id: Type.String(), frontend_version: Type.String(),
    project_id: Type.Union([id, Type.Null()]), job_id: Type.Union([id, Type.Null()]),
    client_time: utc, received_at: utc })
} as const;
export type BrowserErrorReportRequest = Static<typeof browserErrorSchemas.BrowserErrorReportRequest>;
