import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Where published Work Map files go (ARCHITECTURE §6: the private `workmaps` bucket). */
export interface ArtifactStore {
  /** Writes (or overwrites) one file at `path` inside the bucket. */
  put(path: string, body: string, contentType: string): Promise<void>;
}

export function supabaseArtifacts(db: SupabaseClient, bucket = 'workmaps'): ArtifactStore {
  return {
    async put(path, body, contentType) {
      const { error } = await db.storage.from(bucket).upload(path, body, { contentType, upsert: true });
      if (error) throw new Error(`upload ${bucket}/${path}: ${error.message}`);
    },
  };
}

/** In-memory files for tests and dev:mock; `files` maps path → {body, contentType}. */
export function memoryArtifacts(): ArtifactStore & { files: Map<string, { body: string; contentType: string }> } {
  const files = new Map<string, { body: string; contentType: string }>();
  return {
    files,
    async put(path, body, contentType) {
      files.set(path, { body, contentType });
    },
  };
}

/** Files on disk under `root`, for dev:mock (open AGENT_RULES.md to see what tutor and voice get). */
export function fileArtifacts(root: string): ArtifactStore {
  return {
    async put(path, body) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
    },
  };
}
