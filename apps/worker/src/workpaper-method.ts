import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';

export type WorkpaperMethodInput = {
  skill: string;
  helper: string;
  sourceHelper: string;
  tools: Record<string, string>;
  templates: string;
  model: { id: string; provider: string; base: string; version: string; reasoning: string | null };
  progressive?: { groupSkill: string; groupSize: number; groupHelper: string; renderer: string };
};

/** Durable method identity: the legacy shape must not acquire progressive fields. */
export function workpaperMethodHash(input: WorkpaperMethodInput) {
  return inputManifestHash({
    version: input.progressive ? 'workpaper-progressive-method-v3' : 'workpaper-shared-method-v1',
    skill: input.skill,
    ...(input.progressive ?? {}),
    helper: input.helper,
    sourceHelper: input.sourceHelper,
    tools: input.tools,
    templates: input.templates,
    model: input.model,
  });
}
