export interface EmbeddingProvider {
  /** Provider and model identifier stored with the index so mismatched indexes can be detected. */
  readonly id: string;
  readonly dimensions: number;
  /** Embeds chunks for storage. Implementations batch internally. */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Embeds a search query (some providers use a different input type for queries). */
  embedQuery(text: string): Promise<number[]>;
}

export class EmbeddingError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, baseDelayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt === attempts - 1) break;
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError instanceof Error ? lastError : new EmbeddingError('Embedding request failed', lastError);
}
