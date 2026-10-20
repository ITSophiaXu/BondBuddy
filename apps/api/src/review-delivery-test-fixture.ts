import type {Pool} from 'pg';
import type {PrivateBlobs} from './data.js';
import {checkpointStage,promoteWordArtifact} from './queue.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';

/** Synthetic bytes, real promotion/evidence; callers still exercise actual settlement. */
export async function syntheticReviewPair(pool:Pool,lease:Parameters<typeof checkpointStage>[1],blobs:PrivateBlobs){
  const run=(await pool.query('SELECT owner_user_id,project_id FROM bb_runs WHERE id=$1',[lease.runId])).rows[0];
  const artifacts:Record<string,Awaited<ReturnType<typeof promoteWordArtifact>>>={};
  for(const kind of ['report','revision','clean']){
    const a=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:`Synthetic review ${kind}`}),blobs,'generated_pair_v1');
    if(a.status!=='available')throw Error('Synthetic Word fixture promotion failed');
    artifacts[kind]=a;
    await pool.query('INSERT INTO bb_review_artifacts(owner_user_id,project_id,run_id,artifact_id,artifact_version,kind,filename) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [run.owner_user_id,run.project_id,lease.runId,a.artifactId,a.artifactVersion,kind,kind+'.docx']);
  }
  await checkpointStage(pool,lease,'word_delivery_pair',{revision_artifact_id:artifacts.revision.artifactId,clean_artifact_id:artifacts.clean.artifactId});
  return artifacts.revision;
}
