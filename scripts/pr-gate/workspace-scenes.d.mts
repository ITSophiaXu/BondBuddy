import type { Buffer } from 'node:buffer';

export interface WorkspaceSceneManifest {
  schema: 'workspace-scene-artifacts-v1';
  producer: 'synthetic workspace design scenes';
  generation_id: string;
  pid: number;
  created_at: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
}

export function workspaceSceneArtifacts(sourceRoot?: string): {
  publish(json: string, css: string, directory?: string): Promise<WorkspaceSceneManifest>;
  read(name: string): Promise<Buffer>;
};
