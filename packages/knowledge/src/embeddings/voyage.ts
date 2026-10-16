import { VoyageAIClient } from 'voyageai';
import { EmbeddingError, withRetry, type EmbeddingProvider } from './types.js';

export interface VoyageOptions {
  apiKey: string;
  model?: string;
  /** voyage-code-4 / voyage-code-3 support 256, 512, 1024 (default) and 2048. */
  outputDimension?: number;
  /** Max texts per request. Voyage accepts up to 1000 but smaller batches keep retries cheap. */
  batchSize?: number;
}

const MODEL_DIMENSIONS: Record<string, number> = {
  'voyage-code-4': 1024,
  'voyage-code-3': 1024,
  'voyage-4-lite': 1024,
  'voyage-3.5': 1024,
  'voyage-3.5-lite': 1024,
  'voyage-3-large': 1024,
  'voyage-code-2': 1536,
};

/** Voyage AI embeddings (Anthropic's recommended embedding partner); voyage-code-4 is tuned for code retrieval. */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly client: VoyageAIClient;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly outputDimension: number | undefined;

  constructor(options: VoyageOptions) {
    if (!options.apiKey) throw new EmbeddingError('VOYAGE_API_KEY is not set');
    this.model = options.model ?? 'voyage-code-4';
    this.outputDimension = options.outputDimension;
    this.dimensions = options.outputDimension ?? MODEL_DIMENSIONS[this.model] ?? 1024;
    this.id = `voyage:${this.model}:${this.dimensions}`;
    this.batchSize = options.batchSize ?? 64;
    this.client = new VoyageAIClient({ apiKey: options.apiKey });
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      out.push(...(await this.embedBatch(batch, 'document')));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text], 'query');
    if (!vector) throw new EmbeddingError('Voyage returned no embedding for the query');
    return vector;
  }

  private async embedBatch(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
    return withRetry(async () => {
      const response = await this.client.embed({
        input: texts,
        model: this.model,
        inputType,
        truncation: true,
        ...(this.outputDimension ? { outputDimension: this.outputDimension } : {}),
      });
      const data = response.data ?? [];
      if (data.length !== texts.length) {
        throw new EmbeddingError(`Voyage returned ${data.length} embeddings for ${texts.length} inputs`);
      }
      return data.map((d, i) => {
        const embedding = d.embedding;
        if (!embedding || embedding.length !== this.dimensions) {
          throw new EmbeddingError(`Voyage embedding ${i} has ${embedding?.length ?? 0} dimensions, expected ${this.dimensions}`);
        }
        return embedding;
      });
    });
  }
}
