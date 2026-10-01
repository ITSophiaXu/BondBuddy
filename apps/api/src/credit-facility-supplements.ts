import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { CreditFacilitySupplementRequest, CreditFacilitySupplementResponse } from '@bondbuddy/contracts';
import type { CreditFacilitySupplementAmount } from '@bondbuddy/domain/facts';
import { schemas } from '@bondbuddy/contracts';
import {
  appendCreditFacilitySupplement,
  getCreditFacilitySupplementVersion,
  type CreditFacilitySupplementDependencies,
  type CreditFacilitySupplementInput,
  type StoredCreditFacilitySupplement,
} from './credit-facility-supplements-repository.js';
import { missing, Problem } from './data.js';

type RouteSettings = { readonly db: () => Pool; readonly owner: (request: FastifyRequest) => Promise<string> };

function domainAmount(value: CreditFacilitySupplementRequest['amounts']['total']): CreditFacilitySupplementAmount {
  return {
    bank: value.bank,
    asOf: value.as_of,
    currency: value.currency,
    unit: value.unit,
    basis: value.basis,
    scope: value.scope,
    amount: value.amount,
    sourceId: value.source_id,
    statementDate: value.statement_date,
  };
}

function publicAmount(value: CreditFacilitySupplementAmount) {
  return {
    bank: value.bank,
    as_of: value.asOf,
    currency: value.currency,
    unit: value.unit,
    basis: value.basis,
    scope: value.scope,
    amount: value.amount,
    source_id: value.sourceId,
    statement_date: value.statementDate,
  };
}

function response(row: StoredCreditFacilitySupplement): CreditFacilitySupplementResponse {
  return {
    supplement_id: row.supplementId,
    project_id: row.projectId,
    request_id: row.requestId,
    request_hash: row.requestHash,
    version: row.version,
    supersedes: row.supersedes ? { supplement_id: row.supersedes.supplementId, version: row.supersedes.version } : null,
    status: row.result.status,
    eligible_for_manuscript: false,
    amounts: {
      total: publicAmount(row.result.amounts.total),
      used: publicAmount(row.result.amounts.used),
      unused: publicAmount(row.result.amounts.unused),
    },
    reason: row.result.reason ?? null,
    stated_total: row.result.statedTotal ?? null,
    calculated_total: row.result.calculatedTotal ?? null,
    created_at: row.createdAt,
    replayed: row.replayed,
  };
}

function mapRepositoryError(error: unknown): never {
  const code = error instanceof Error ? error.message : '';
  if (code === 'CREDIT_SUPPLEMENT_PROJECT_NOT_FOUND' || code === 'CREDIT_SUPPLEMENT_PREDECESSOR_NOT_FOUND') throw missing();
  if (code === 'CREDIT_SUPPLEMENT_IDEMPOTENCY_MISMATCH') throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Request ID was already used for different content');
  if (code === 'CREDIT_SUPPLEMENT_REVISION_CONFLICT') throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'The predecessor already has a newer revision');
  if (code.startsWith('INVALID_CREDIT_FACILITY_SUPPLEMENT')) throw new Problem(422, 'VALIDATION_FAILED', 'Credit supplement is invalid');
  throw error;
}

function dependencies(pool: Pool): CreditFacilitySupplementDependencies {
  return { pool };
}

export function installCreditFacilitySupplementRoutes(app: FastifyInstance, settings: RouteSettings): void {
  app.post('/api/v1/projects/:project_id/credit-facility-supplements', {
    schema: { body: schemas.CreditFacilitySupplementRequest, response: { 201: schemas.CreditFacilitySupplementResponse, 200: schemas.CreditFacilitySupplementResponse } },
  }, async (request, reply) => {
    const ownerUserId = await settings.owner(request);
    const projectId = (request.params as { project_id: string }).project_id;
    const body = request.body as CreditFacilitySupplementRequest;
    const input: CreditFacilitySupplementInput = {
      total: domainAmount(body.amounts.total),
      used: domainAmount(body.amounts.used),
      unused: domainAmount(body.amounts.unused),
      supersedes: body.supersedes ? { supplementId: body.supersedes.supplement_id, version: body.supersedes.version } : null,
    };
    let stored: StoredCreditFacilitySupplement;
    try {
      stored = await appendCreditFacilitySupplement(dependencies(settings.db()),
        { ownerUserId, projectId, requestId: body.request_id }, input);
    } catch (error) { mapRepositoryError(error); }
    return reply.code(stored.replayed ? 200 : 201).send(response(stored));
  });

  app.get('/api/v1/projects/:project_id/credit-facility-supplements/:supplement_id/versions/:version', {
    schema: { response: { 200: schemas.CreditFacilitySupplementResponse } },
  }, async (request) => {
    const ownerUserId = await settings.owner(request);
    const params = request.params as { project_id: string; supplement_id: string; version: string };
    if (!/^[1-9][0-9]*$/.test(params.version) || !Number.isSafeInteger(Number(params.version))) {
      throw new Problem(422, 'VALIDATION_FAILED', 'Credit supplement version must be a positive integer');
    }
    let stored: StoredCreditFacilitySupplement | null;
    try {
      stored = await getCreditFacilitySupplementVersion(dependencies(settings.db()), {
        ownerUserId, projectId: params.project_id, supplementId: params.supplement_id, version: Number(params.version),
      });
    } catch (error) { mapRepositoryError(error); }
    if (!stored) throw missing();
    return response(stored);
  });
}
