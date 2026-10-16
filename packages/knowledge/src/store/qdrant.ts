import { QdrantClient } from '@qdrant/js-client-rest';
import type { ContentType } from '../chunker.js';

export interface ChunkPayload {
  projectId: string;
  repository: string;
  filePath: string;
  startLine: number;
  endLine: number;
  contentType: ContentType;
  language: string;
  symbol?: string;
  revision: string;
  text: string;
  textHash: string;
  indexedAt: string;
}

export interface ChunkPoint {
  /** UUID; Qdrant only accepts UUIDs or unsigned integers as ids. */
  id: string;
  vector: number[];
  payload: ChunkPayload;
}

export interface SearchFilter {
  projectId: string;
  contentTypes?: ContentType[];
  filePathPrefix?: string;
}

export interface ScoredChunk {
  id: string;
  score: number;
  payload: ChunkPayload;
}

export interface QdrantStoreOptions {
  url: string;
  apiKey?: string;
  collection: string;
}

/** Thin wrapper over the Qdrant REST client for the single `code_chunks` collection. */
export class QdrantChunkStore {
  readonly collection: string;
  private readonly client: QdrantClient;

  constructor(options: QdrantStoreOptions) {
    this.collection = options.collection;
    this.client = new QdrantClient({ url: options.url, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
  }

  async health(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  /** Creates the collection (and payload indexes) if needed and checks the vector size matches. */
  async ensureCollection(dimensions: number): Promise<void> {
    const exists = await this.client.collectionExists(this.collection).then((r) => r.exists).catch(() => false);
    if (!exists) {
      await this.client.createCollection(this.collection, {
        vectors: { size: dimensions, distance: 'Cosine' },
        on_disk_payload: true,
      });
      for (const field of ['projectId', 'filePath', 'contentType', 'repository']) {
        await this.client.createPayloadIndex(this.collection, { field_name: field, field_schema: 'keyword', wait: true });
      }
      return;
    }
    const info = await this.client.getCollection(this.collection);
    const vectors = info.config.params.vectors;
    const size = typeof vectors === 'object' && vectors !== null && 'size' in vectors ? (vectors as { size: number }).size : undefined;
    if (size !== undefined && size !== dimensions) {
      throw new Error(
        `Qdrant collection "${this.collection}" has vector size ${size} but the embedding provider produces ${dimensions}. ` +
          `Use a different QDRANT_COLLECTION or delete the collection.`,
      );
    }
  }

  async upsert(points: ChunkPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.client.upsert(this.collection, {
      wait: true,
      points: points.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload as unknown as Record<string, unknown> })),
    });
  }

  async deleteByFile(projectId: string, filePath: string): Promise<void> {
    await this.client.delete(this.collection, {
      wait: true,
      filter: { must: [{ key: 'projectId', match: { value: projectId } }, { key: 'filePath', match: { value: filePath } }] },
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.client.delete(this.collection, {
      wait: true,
      filter: { must: [{ key: 'projectId', match: { value: projectId } }] },
    });
  }

  async countProject(projectId: string): Promise<number> {
    const result = await this.client.count(this.collection, {
      exact: true,
      filter: { must: [{ key: 'projectId', match: { value: projectId } }] },
    });
    return result.count;
  }

  async search(vector: number[], filter: SearchFilter, limit: number): Promise<ScoredChunk[]> {
    const must: Record<string, unknown>[] = [{ key: 'projectId', match: { value: filter.projectId } }];
    if (filter.contentTypes && filter.contentTypes.length > 0) {
      must.push({ key: 'contentType', match: { any: filter.contentTypes } });
    }
    if (filter.filePathPrefix) {
      must.push({ key: 'filePath', match: { text: filter.filePathPrefix } });
    }
    const result = await this.client.query(this.collection, {
      query: vector,
      filter: { must },
      limit,
      with_payload: true,
      with_vector: false,
    });
    return result.points.map((p) => ({
      id: String(p.id),
      score: p.score,
      payload: p.payload as unknown as ChunkPayload,
    }));
  }
}
