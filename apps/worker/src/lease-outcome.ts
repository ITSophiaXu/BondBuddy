/** These outcomes return the original lease only after its sealed task proof. */
export function needsLeaseRelease(outcome: unknown): boolean {
  return outcome === 'retry' || outcome === 'handoff_pending' || outcome === 'pause_pending';
}
