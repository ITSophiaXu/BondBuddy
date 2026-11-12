import type { TestInfo } from '@playwright/test';

type EvidenceInfo = Pick<TestInfo, 'status' | 'errors'>;
type Failure = { phase: string; error: unknown };
const describeError = (error: unknown) => error instanceof Error
  ? { message: error.message, stack: error.stack }
  : { message: String(error) };

/** Playwright may still report "passed" while a fixture's own setup/teardown fails. */
export function evidenceLifecycle() {
  let phase = 'setup';
  const failures: Failure[] = [];
  return {
    enter(nextPhase: string) { phase = nextPhase; },
    fail(error: unknown, failedPhase = phase) { failures.push({ phase: failedPhase, error }); },
    state(info: EvidenceInfo, finalized = false) {
      const errors = [
        ...info.errors.map(error => ({ message: error.message, stack: error.stack, phase: 'test' })),
        ...failures.map(failure => ({ ...describeError(failure.error), phase: failure.phase })),
      ];
      const terminalStatus = failures.length || (info.status === 'passed' && errors.length) ? 'failed' : info.status;
      return { status: finalized ? terminalStatus : 'running', phase: finalized ? 'finished' : phase, finalized, errors };
    },
    throwIfFailed() {
      if (failures.length === 1) throw failures[0].error;
      if (failures.length > 1) throw new AggregateError(failures.map(failure => failure.error), 'Evidence setup or finalization failed');
    },
  };
}

/** Call only after all required final observations and teardown checks have completed. */
export async function finalizeEvidence(options: {
  lifecycle: ReturnType<typeof evidenceLifecycle>;
  render(finalized: boolean): string;
  write(text: string): void;
  attach(text: string): Promise<void>;
}) {
  const { lifecycle, render, write, attach } = options;
  lifecycle.enter('finalize');
  try {
    const text = render(true);
    write(text);
    await attach(text);
  } catch (error) {
    lifecycle.fail(error, 'evidence-finalize');
    // Keep a failed authoritative file if attachment fails after the final write.
    // If persistence itself is unavailable, the exception still fails the test.
    try { write(render(true)); } catch (writeError) { lifecycle.fail(writeError, 'evidence-final-write'); }
  }
  lifecycle.throwIfFailed();
}
