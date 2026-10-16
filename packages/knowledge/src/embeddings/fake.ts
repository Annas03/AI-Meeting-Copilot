import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './types.js';

/**
 * Deterministic, offline embedding used for tests and for running the pipeline without any
 * API key. It is a hashed bag-of-words: texts that share identifiers end up close together, which
 * is enough to prove retrieval wiring (not retrieval quality).
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;

  constructor(readonly dimensions = 256) {
    this.id = `fake-hash-${dimensions}`;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embed(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  private embed(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenize(text);
    for (const token of tokens) {
      const digest = createHash('sha1').update(token).digest();
      const index = digest.readUInt32BE(0) % this.dimensions;
      const sign = digest[4]! % 2 === 0 ? 1 : -1;
      vector[index]! += sign;
    }
    const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}
