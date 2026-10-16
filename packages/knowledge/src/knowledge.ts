import type { ContentType } from './chunker.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './embeddings/index.js';
import { dataDir as resolveDataDir, loadRootEnv } from './env.js';
import { indexRepository, type IndexProgress, type IndexRepositoryResult } from './indexer.js';
import { listManifests, readManifest, type Manifest } from './manifest.js';
import { QdrantChunkStore } from './store/qdrant.js';

export interface SearchHit {
  chunkId: string;
  repository: string;
  filePath: string;
  startLine: number;
  endLine: number;
  contentType: ContentType;
  language: string;
  symbol?: string;
  text: string;
  score: number;
  revision: string;
}

export interface SearchOptions {
  projectId: string;
  query: string;
  limit?: number;
  contentTypes?: ContentType[];
  filePathPrefix?: string;
}

export interface KnowledgeOptions {
  qdrantUrl: string;
  qdrantApiKey?: string;
  collection: string;
  dataDir: string;
  embeddings: EmbeddingProvider;
}

export interface IndexOptions {
  projectId: string;
  repository: string;
  repoPath: string;
  full?: boolean;
  exclude?: string[];
  includeExtensions?: string[];
  onProgress?: (p: IndexProgress) => void;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/** Facade used by the server and the CLI: one Qdrant collection, one embedding provider. */
export class Knowledge {
  readonly store: QdrantChunkStore;
  readonly embeddings: EmbeddingProvider;
  readonly dataDir: string;

  constructor(options: KnowledgeOptions) {
    this.store = new QdrantChunkStore({ url: options.qdrantUrl, apiKey: options.qdrantApiKey, collection: options.collection });
    this.embeddings = options.embeddings;
    this.dataDir = options.dataDir;
  }

  /** Reads QDRANT_* and embedding settings from the environment (loading the root .env first). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Knowledge {
    loadRootEnv();
    return new Knowledge({
      qdrantUrl: env.QDRANT_URL ?? 'http://127.0.0.1:6333',
      qdrantApiKey: env.QDRANT_API_KEY || undefined,
      collection: env.QDRANT_COLLECTION ?? 'code_chunks',
      dataDir: resolveDataDir(),
      embeddings: createEmbeddingProvider(env),
    });
  }

  async health(): Promise<{ qdrant: boolean; embeddings: string }> {
    return { qdrant: await this.store.health(), embeddings: this.embeddings.id };
  }

  async search(options: SearchOptions): Promise<SearchHit[]> {
    const vector = await this.embeddings.embedQuery(options.query);
    const hits = await this.store.search(
      vector,
      { projectId: options.projectId, contentTypes: options.contentTypes, filePathPrefix: options.filePathPrefix },
      options.limit ?? 8,
    );
    return hits.map((h) => ({
      chunkId: h.id,
      repository: h.payload.repository,
      filePath: h.payload.filePath,
      startLine: h.payload.startLine,
      endLine: h.payload.endLine,
      contentType: h.payload.contentType,
      language: h.payload.language,
      ...(h.payload.symbol ? { symbol: h.payload.symbol } : {}),
      text: h.payload.text,
      score: h.score,
      revision: h.payload.revision,
    }));
  }

  async index(options: IndexOptions): Promise<IndexRepositoryResult> {
    return indexRepository({
      ...options,
      dataDir: this.dataDir,
      embeddings: this.embeddings,
      store: this.store,
    });
  }

  async project(projectId: string): Promise<Manifest | null> {
    return readManifest(this.dataDir, projectId);
  }

  async projects(): Promise<Manifest[]> {
    return listManifests(this.dataDir);
  }
}
