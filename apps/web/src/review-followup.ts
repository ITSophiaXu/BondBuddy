import type { ReviewArtifact } from '@bondbuddy/contracts';
import './schema-formats';

/** A reading reference, never a structured finding ID or an execution authorization. */
export type ReviewFollowupSource = {
  runId: string;
  version?: number;
  title: string;
  details: string[];
  sourceFilename?: string;
  clean?: ReviewArtifact;
};

export function reviewFollowupText(source: ReviewFollowupSource) {
  return [`来源：复核成果${source.version ? ` V${source.version}` : ''}${source.sourceFilename ? `（所复核文件：${source.sourceFilename}）` : ''}`,
    `关注事项：${source.title}`, ...source.details.filter(Boolean), '请结合本轮材料重新核对，材料不足的部分继续说明限制。']
    .map(text => text.replace(/\s+/g, ' ').trim()).join('；');
}
