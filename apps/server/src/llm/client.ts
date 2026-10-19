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

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const effortSupport = new Map<string, Promise<Set<Effort>>>();

/**
 * `output_config` fragment requesting `effort`, or nothing when the model rejects it. Models are configurable per
 * task and some (e.g. Claude Haiku 4.5) answer `effort` with a 400, so support is read once per model from the
 * Models API. If the lookup fails, effort is omitted (always valid) and the lookup is retried on the next call.
 */
export async function effortFor(model: string, effort: Effort): Promise<{ effort?: Effort }> {
  const client = anthropic();
  if (!client) return {};
  let levels = effortSupport.get(model);
  if (!levels) {
    levels = client.models.retrieve(model).then((info) => {
      const caps = info.capabilities?.effort;
      const all: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
      return new Set(caps?.supported ? all.filter((level) => caps[level]?.supported) : []);
    });
    effortSupport.set(model, levels);
    levels.catch(() => effortSupport.delete(model));
  }
  const supported = await levels.catch(() => new Set<Effort>());
  return supported.has(effort) ? { effort } : {};
}

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
