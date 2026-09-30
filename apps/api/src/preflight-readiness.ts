/** Readiness diagnostics do not gate a durable run; authorization and pins are checked by the route. */
export function classifyPreflightReadiness(missingInputs: readonly string[], uncertainty: readonly string[],
  _testChannel: boolean) {
  const blockingInputs = missingInputs.filter(reason => reason === 'execution_capability_not_ready');
  const advisoryInputs = missingInputs.filter(reason => reason !== 'execution_capability_not_ready');
  const status = blockingInputs.length ? 'blocked' as const : advisoryInputs.length || uncertainty.length
    ? 'needs_confirmation' as const : 'ready' as const;
  return { status, blockingInputs, advisoryInputs };
}
