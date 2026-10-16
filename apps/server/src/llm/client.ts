import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client: Anthropic | null = null;

export function anthropic(): Anthropic | null {
  if (!config.anthropicConfigured) return null;
  if (!client) {
    client = new Anthropic({
      apiKey: config.ANTHROPIC_API_KEY,
      timeout: 90_000,
      maxRetries: 2,
    });
  }
  return client;
}

export class LlmUnavailableError extends Error {
  constructor() {
    super('Claude is not configured: set ANTHROPIC_API_KEY in the root .env');
    this.name = 'LlmUnavailableError';
  }
}

export function requireAnthropic(): Anthropic {
  const c = anthropic();
  if (!c) throw new LlmUnavailableError();
  return c;
}

export const models = {
  answer: config.ANSWER_MODEL,
  memory: config.MEMORY_MODEL,
  classifier: config.CLASSIFIER_MODEL,
} as const;

/** Rejects after `ms` so no provider call can hang the pipeline indefinitely. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string, abort?: AbortController): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort?.abort();
      reject(new Error(`${label} timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
