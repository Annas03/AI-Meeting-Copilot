import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chunkFile, embeddingTextFor, type Chunk } from './chunker.js';
import { discoverFiles, looksBinary, looksLikeSecret, type DiscoverOptions } from './discover.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import { readManifest, writeManifest, type Manifest } from './manifest.js';
import type { ChunkPoint, QdrantChunkStore } from './store/qdrant.js';

export interface IndexProgress {
  phase: 'discover' | 'chunk' | 'embed' | 'store' | 'cleanup' | 'done';
  message: string;
  done?: number;
  total?: number;
}

export interface IndexRepositoryOptions extends Omit<DiscoverOptions, 'repoPath'> {
  projectId: string;
  /** Human readable repository name, e.g. "company/application". */
  repository: string;
  repoPath: string;
  dataDir: string;
  embeddings: EmbeddingProvider;
  store: QdrantChunkStore;
  /** Drop everything previously indexed for the project first. */
  full?: boolean;
  /** Chunks embedded per request. */
  embedBatchSize?: number;
  onProgress?: (progress: IndexProgress) => void;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface IndexRepositoryResult {
  projectId: string;
  revision: string;
  filesIndexed: number;
  filesUnchanged: number;
  filesRemoved: number;
  filesSkipped: number;
  chunksUpserted: number;
  durationMs: number;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Deterministic UUID derived from the chunk identity so re-indexing an unchanged chunk is idempotent. */
export function chunkPointId(projectId: string, chunk: Chunk, textHash: string): string {
  const hex = createHash('sha1').update(`${projectId}\u0000${chunk.filePath}\u0000${chunk.startLine}\u0000${textHash}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function indexRepository(options: IndexRepositoryOptions): Promise<IndexRepositoryResult> {
  const startedAt = new Date();
  const log = options.logger ?? console;
  const progress = options.onProgress ?? (() => {});
  const { projectId, repository, store, embeddings } = options;
  const repoPath = path.resolve(options.repoPath);

  await store.ensureCollection(embeddings.dimensions);

  let manifest = await readManifest(options.dataDir, projectId);
  let full = options.full ?? false;
  if (manifest && (manifest.embeddingId !== embeddings.id || manifest.collection !== store.collection)) {
    log.warn(`Index for "${projectId}" was built with ${manifest.embeddingId} in ${manifest.collection}; rebuilding with ${embeddings.id}.`);
    full = true;
  }
  if (full) {
    progress({ phase: 'cleanup', message: 'Removing previous index for project' });
    await store.deleteProject(projectId);
    manifest = null;
  }
  const previousFiles = manifest?.files ?? {};
  const nextFiles: Manifest['files'] = {};

  progress({ phase: 'discover', message: `Scanning ${repoPath}` });
  const discovered = await discoverFiles({ repoPath, exclude: options.exclude, includeExtensions: options.includeExtensions, maxFileBytes: options.maxFileBytes });
  progress({ phase: 'discover', message: `${discovered.files.length} candidate files, ${discovered.skipped.length} skipped`, total: discovered.files.length });

  let filesIndexed = 0;
  let filesUnchanged = 0;
  let filesSkipped = discovered.skipped.length;
  let chunksUpserted = 0;
  const batchSize = options.embedBatchSize ?? 64;
  const indexedAt = new Date().toISOString();

  type Pending = { chunk: Chunk; textHash: string; id: string };
  let pending: Pending[] = [];
  const pendingByFile = new Map<string, string[]>();

  const flush = async () => {
    if (pending.length === 0) return;
    progress({ phase: 'embed', message: `Embedding ${pending.length} chunks`, done: chunksUpserted, total: undefined });
    const vectors = await embeddings.embedDocuments(pending.map((p) => embeddingTextFor(p.chunk, repository)));
    const points: ChunkPoint[] = pending.map((p, i) => ({
      id: p.id,
      vector: vectors[i]!,
      payload: {
        projectId,
        repository,
        filePath: p.chunk.filePath,
        startLine: p.chunk.startLine,
        endLine: p.chunk.endLine,
        contentType: p.chunk.contentType,
        language: p.chunk.language,
        ...(p.chunk.symbol ? { symbol: p.chunk.symbol } : {}),
        revision: discovered.revision,
        text: p.chunk.text,
        textHash: p.textHash,
        indexedAt,
      },
    }));
    progress({ phase: 'store', message: `Storing ${points.length} chunks` });
    await store.upsert(points);
    chunksUpserted += points.length;
    pending = [];
  };

  try {
    for (const [i, file] of discovered.files.entries()) {
      const buffer = await fs.readFile(file.absPath);
      if (looksBinary(buffer)) {
        filesSkipped++;
        continue;
      }
      const content = buffer.toString('utf8');
      const hash = sha256(content);
      const previous = previousFiles[file.relPath];
      if (previous && previous.hash === hash) {
        nextFiles[file.relPath] = previous;
        filesUnchanged++;
        continue;
      }
      if (looksLikeSecret(content)) {
        log.warn(`Skipping ${file.relPath}: looks like it contains a credential`);
        filesSkipped++;
        continue;
      }
      const chunks = chunkFile(file.relPath, content);
      if (previous) await store.deleteByFile(projectId, file.relPath);
      const ids: string[] = [];
      for (const chunk of chunks) {
        const textHash = sha256(chunk.text);
        const id = chunkPointId(projectId, chunk, textHash);
        ids.push(id);
        pending.push({ chunk, textHash, id });
      }
      pendingByFile.set(file.relPath, ids);
      nextFiles[file.relPath] = { hash, chunkCount: chunks.length, chunkIds: ids };
      filesIndexed++;
      progress({ phase: 'chunk', message: `${file.relPath} -> ${chunks.length} chunks`, done: i + 1, total: discovered.files.length });
      if (pending.length >= batchSize) await flush();
    }
    await flush();

    // Files that disappeared since the last run.
    let filesRemoved = 0;
    progress({ phase: 'cleanup', message: 'Removing chunks of deleted files' });
    for (const relPath of Object.keys(previousFiles)) {
      if (!nextFiles[relPath]) {
        await store.deleteByFile(projectId, relPath);
        filesRemoved++;
      }
    }

    const finishedAt = new Date();
    const result: IndexRepositoryResult = {
      projectId,
      revision: discovered.revision,
      filesIndexed,
      filesUnchanged,
      filesRemoved,
      filesSkipped,
      chunksUpserted,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
    await writeManifest(options.dataDir, {
      projectId,
      repository,
      repoPath,
      revision: discovered.revision,
      embeddingId: embeddings.id,
      dimensions: embeddings.dimensions,
      collection: store.collection,
      files: nextFiles,
      lastRun: {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        filesIndexed,
        filesUnchanged,
        filesRemoved,
        filesSkipped,
        chunksUpserted,
        status: 'completed',
      },
    });
    progress({ phase: 'done', message: `Indexed ${filesIndexed} files (${chunksUpserted} chunks), ${filesUnchanged} unchanged, ${filesRemoved} removed` });
    return result;
  } catch (err) {
    // Persist what we know so the next run can resume; files already upserted keep their hashes.
    await writeManifest(options.dataDir, {
      projectId,
      repository,
      repoPath,
      revision: manifest?.revision ?? discovered.revision,
      embeddingId: embeddings.id,
      dimensions: embeddings.dimensions,
      collection: store.collection,
      files: { ...nextFiles },
      lastRun: {
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        filesIndexed,
        filesUnchanged,
        filesRemoved: 0,
        filesSkipped,
        chunksUpserted,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      },
    }).catch(() => {});
    throw err;
  }
}
