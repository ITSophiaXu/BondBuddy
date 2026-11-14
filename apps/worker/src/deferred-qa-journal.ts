import {CodexDurableJournal} from './durable-probe-journal.js';
import {recordProviderCallObservation,type ProviderCallObservation} from '@bondbuddy/api/provider-results';
/** Independent question observations settle before the enclosing job is aggregated. */
export class DeferredQaJournal extends CodexDurableJournal{
  constructor(private readonly deferredInput:ConstructorParameters<typeof CodexDurableJournal>[0]){super(deferredInput);}
  override async recordObservation(observation:ProviderCallObservation,options:{retryable?:boolean}={}){
    await recordProviderCallObservation(this.deferredInput.pool,this.deferredInput.blobs,observation,this.deferredInput.validateResult,
      {lease:this.deferredInput.lease,source:'provider',retryable:options.retryable===true,deferRunOutcome:true});
  }
}
