import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Per-project index manifest stored as JSON under DATA_DIR/index. It records which file
 * versions are in Qdrant so re-runs only touch changed files, and which embedding model built
 * the index so a provider change triggers a full rebuild instead of mixing vector spaces.
 */
export const ManifestSchema = z.object({
  projectId: z.string(),
  repository: z.string(),
  repoPath: z.string(),
  revision: z.string(),
  embeddingId: z.string(),
  dimensions: z.number().int().positive(),
  collection: z.string(),
  files: z.record(
    z.string(),
    z.object({
      hash: z.string(),
      chunkCount: z.number().int().nonnegative(),
      chunkIds: z.array(z.string()),
    }),
  ),
  lastRun: z
    .object({
      startedAt: z.string(),
      finishedAt: z.string(),
      filesIndexed: z.number(),
      filesUnchanged: z.number(),
      filesRemoved: z.number(),
      filesSkipped: z.number(),
      chunksUpserted: z.number(),
      status: z.enum(['completed', 'failed']),
      error: z.string().optional(),
    })
    .optional(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export function manifestPath(dataDir: string, projectId: string): string {
  const safe = projectId.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dataDir, 'index', `${safe}.json`);
}

export async function readManifest(dataDir: string, projectId: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(dataDir, projectId), 'utf8');
    return ManifestSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeManifest(dataDir: string, manifest: Manifest): Promise<void> {
  const file = manifestPath(dataDir, manifest.projectId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export async function listManifests(dataDir: string): Promise<Manifest[]> {
  const dir = path.join(dataDir, 'index');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const manifests: Manifest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), 'utf8');
      manifests.push(ManifestSchema.parse(JSON.parse(raw)));
    } catch {
      // ignore unreadable manifests
    }
  }
  return manifests;
}
