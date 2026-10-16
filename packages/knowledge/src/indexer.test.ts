import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbeddingProvider } from './embeddings/fake.js';
import { chunkPointId, indexRepository } from './indexer.js';
import { manifestPath } from './manifest.js';
import type { ChunkPoint, QdrantChunkStore, ScoredChunk, SearchFilter } from './store/qdrant.js';

/** In-memory stand-in for Qdrant with cosine scoring, enough to test the indexer and search wiring. */
class MemoryStore implements Pick<QdrantChunkStore, 'collection' | 'ensureCollection' | 'upsert' | 'deleteByFile' | 'deleteProject' | 'search' | 'health' | 'countProject'> {
  readonly collection = 'test';
  points = new Map<string, ChunkPoint>();
  dimensions = 0;
  async health() {
    return true;
  }
  async ensureCollection(d: number) {
    this.dimensions = d;
  }
  async upsert(points: ChunkPoint[]) {
    for (const p of points) this.points.set(p.id, p);
  }
  async deleteByFile(projectId: string, filePath: string) {
    for (const [id, p] of this.points) if (p.payload.projectId === projectId && p.payload.filePath === filePath) this.points.delete(id);
  }
  async deleteProject(projectId: string) {
    for (const [id, p] of this.points) if (p.payload.projectId === projectId) this.points.delete(id);
  }
  async countProject(projectId: string) {
    return [...this.points.values()].filter((p) => p.payload.projectId === projectId).length;
  }
  async search(vector: number[], filter: SearchFilter, limit: number): Promise<ScoredChunk[]> {
    const scored = [...this.points.values()]
      .filter((p) => p.payload.projectId === filter.projectId)
      .filter((p) => !filter.contentTypes || filter.contentTypes.includes(p.payload.contentType))
      .map((p) => ({ id: p.id, payload: p.payload, score: p.vector.reduce((acc, v, i) => acc + v * (vector[i] ?? 0), 0) }))
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

let repo: string;
let dataDir: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'copilot-repo-'));
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-data-'));
  await mkdir(path.join(repo, 'src', 'auth'), { recursive: true });
  await writeFile(
    path.join(repo, 'src', 'auth', 'authorization.ts'),
    `export function canAccessOrganization(user: User, orgId: string): boolean {\n  return user.organizations.includes(orgId);\n}\n\nexport function requireRole(role: Role) {\n  return (req, res, next) => next();\n}\n`,
  );
  await writeFile(path.join(repo, 'src', 'billing.ts'), `export function chargeInvoice(invoice: Invoice) {\n  return stripe.charge(invoice.total);\n}\n`);
  await writeFile(path.join(repo, 'README.md'), `# App\n\n## Permissions\n\nUsers belong to organizations and roles gate access.\n`);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('indexRepository', () => {
  it('indexes, searches, and only re-embeds changed files on the next run', async () => {
    const store = new MemoryStore();
    const embeddings = new FakeEmbeddingProvider(128);
    const base = { projectId: 'p1', repository: 'acme/app', repoPath: repo, dataDir, embeddings, store: store as unknown as QdrantChunkStore };

    const first = await indexRepository(base);
    expect(first.filesIndexed).toBe(3);
    expect(first.filesUnchanged).toBe(0);
    expect(first.chunksUpserted).toBeGreaterThanOrEqual(3);
    expect(store.dimensions).toBe(128);

    const manifestRaw = JSON.parse(await readFile(manifestPath(dataDir, 'p1'), 'utf8'));
    expect(Object.keys(manifestRaw.files).sort()).toEqual(['README.md', 'src/auth/authorization.ts', 'src/billing.ts']);
    expect(manifestRaw.embeddingId).toBe(embeddings.id);

    const query = await embeddings.embedQuery('organization permissions access for user');
    const hits = await store.search(query, { projectId: 'p1' }, 3);
    expect(hits[0]!.payload.filePath).toMatch(/authorization\.ts|README\.md/);

    // Change one file, delete another.
    await writeFile(path.join(repo, 'src', 'billing.ts'), `export function chargeInvoice(invoice: Invoice) {\n  return stripe.charge(invoice.total * 2);\n}\n`);
    await rm(path.join(repo, 'README.md'));
    const second = await indexRepository(base);
    expect(second.filesIndexed).toBe(1);
    expect(second.filesUnchanged).toBe(1);
    expect(second.filesRemoved).toBe(1);
    expect([...store.points.values()].some((p) => p.payload.filePath === 'README.md')).toBe(false);
    expect([...store.points.values()].filter((p) => p.payload.filePath === 'src/billing.ts')).toHaveLength(1);
  });

  it('rebuilds from scratch when the embedding provider changes', async () => {
    const store = new MemoryStore();
    const base = { projectId: 'p1', repository: 'acme/app', repoPath: repo, dataDir, store: store as unknown as QdrantChunkStore };
    await indexRepository({ ...base, embeddings: new FakeEmbeddingProvider(64) });
    const warnings: string[] = [];
    const result = await indexRepository({
      ...base,
      embeddings: new FakeEmbeddingProvider(128),
      logger: { info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} },
    });
    expect(result.filesIndexed).toBe(3);
    expect(warnings.join(' ')).toMatch(/rebuilding/);
    expect(store.dimensions).toBe(128);
  });

  it('skips files that look like they contain credentials', async () => {
    await writeFile(path.join(repo, 'src', 'keys.ts'), `export const key = 'AKIAABCDEFGHIJKLMNOP';\n`);
    const store = new MemoryStore();
    const result = await indexRepository({ projectId: 'p1', repository: 'acme/app', repoPath: repo, dataDir, embeddings: new FakeEmbeddingProvider(64), store: store as unknown as QdrantChunkStore, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    expect(result.filesIndexed).toBe(3);
    expect([...store.points.values()].some((p) => p.payload.filePath === 'src/keys.ts')).toBe(false);
  });
});

describe('chunkPointId', () => {
  it('is a stable RFC-4122 shaped UUID', () => {
    const chunk = { filePath: 'a.ts', startLine: 1, endLine: 2, text: 'x', contentType: 'source_code' as const, language: 'typescript' };
    const id = chunkPointId('p', chunk, 'hash');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chunkPointId('p', chunk, 'hash')).toBe(id);
    expect(chunkPointId('p', chunk, 'other')).not.toBe(id);
  });
});
