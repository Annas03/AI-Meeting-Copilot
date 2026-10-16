import { FakeEmbeddingProvider } from './fake.js';
import { EmbeddingError, type EmbeddingProvider } from './types.js';
import { VoyageEmbeddingProvider } from './voyage.js';

export type { EmbeddingProvider } from './types.js';
export { EmbeddingError } from './types.js';
export { FakeEmbeddingProvider } from './fake.js';
export { VoyageEmbeddingProvider } from './voyage.js';

export interface EmbeddingEnv {
  EMBEDDINGS_PROVIDER?: string;
  VOYAGE_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
}

/** Builds the provider named by EMBEDDINGS_PROVIDER (voyage | fake). */
export function createEmbeddingProvider(env: EmbeddingEnv = process.env): EmbeddingProvider {
  const provider = (env.EMBEDDINGS_PROVIDER ?? 'voyage').toLowerCase();
  const dims = env.EMBEDDING_DIMENSIONS ? Number(env.EMBEDDING_DIMENSIONS) : undefined;
  switch (provider) {
    case 'fake':
      return new FakeEmbeddingProvider(dims ?? 256);
    case 'voyage':
      return new VoyageEmbeddingProvider({
        apiKey: env.VOYAGE_API_KEY ?? '',
        ...(env.EMBEDDING_MODEL ? { model: env.EMBEDDING_MODEL } : {}),
        ...(dims ? { outputDimension: dims } : {}),
      });
    default:
      throw new EmbeddingError(`Unknown EMBEDDINGS_PROVIDER "${provider}" (expected voyage or fake)`);
  }
}
