// Worker builds emit JavaScript. Keep the test's runtime imports pointed at that build,
// while obtaining the used signatures directly from the corresponding worker source.
declare module '*worker/dist/run-pipeline.js' {
  export const codexModelStage: typeof import('../../worker/src/run-pipeline.js').codexModelStage;
  export const runPipelineOnce: typeof import('../../worker/src/run-pipeline.js').runPipelineOnce;
}
declare module '*worker/dist/codex-adapter.js' {
  export const DEFAULT_DISABLED_FEATURES: typeof import('../../worker/src/codex-adapter.js').DEFAULT_DISABLED_FEATURES;
  export type CodexAdapterConfig = import('../../worker/src/codex-adapter.js').CodexAdapterConfig;
}
