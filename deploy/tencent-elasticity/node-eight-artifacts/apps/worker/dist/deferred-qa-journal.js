import { CodexDurableJournal } from './durable-probe-journal.js';
import { recordProviderCallObservation } from '@bondbuddy/api/provider-results';
/** Independent question observations settle before the enclosing job is aggregated. */
export class DeferredQaJournal extends CodexDurableJournal {
    deferredInput;
    constructor(deferredInput) {
        super(deferredInput);
        this.deferredInput = deferredInput;
    }
    async recordObservation(observation, options = {}) {
        await recordProviderCallObservation(this.deferredInput.pool, this.deferredInput.blobs, observation, this.deferredInput.validateResult, { lease: this.deferredInput.lease, source: 'provider', retryable: options.retryable === true, deferRunOutcome: true });
    }
}
