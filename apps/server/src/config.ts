import path from 'node:path';
import { loadRootEnv } from '@copilot/knowledge';
import { z } from 'zod';

const repoRoot = loadRootEnv();

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.string().default('info'),
  WEB_ORIGIN: z.string().optional(),

  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANSWER_MODEL: z.string().default('claude-opus-5-5'),
  MEMORY_MODEL: z.string().default('claude-opus-5-5'),
  CLASSIFIER_MODEL: z.string().default('claude-haiku-5-5'),
  /** Effort for answer synthesis; low keeps first-token latency near the blueprint target. */
  ANSWER_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  /** Server-side refusal fallback ("default" routing) on the answer path. */
  ANSWER_FALLBACKS: z.enum(['on', 'off']).default('on'),

  RETRIEVAL_LIMIT: z.coerce.number().int().min(1).max(30).default(8),
  /** Hits scoring below this are treated as weak evidence and the answer is flagged preliminary. */
  RETRIEVAL_MIN_SCORE: z.coerce.number().default(0.25),
  /** Final segments folded into meeting memory per update call. */
  MEMORY_BATCH_SEGMENTS: z.coerce.number().int().min(1).default(5),
  MEMORY_MAX_WAIT_MS: z.coerce.number().int().min(1000).default(45_000),

  INTERNAL_API_SECRET: z.string().default('change-me-to-a-long-random-string'),
  DEFAULT_PROJECT_ID: z.string().default('default'),
  DATA_DIR: z.string().default('./data'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  repoRoot,
  dataDir: path.resolve(repoRoot, env.DATA_DIR),
  isProduction: env.NODE_ENV === 'production',
  devRoutes: env.NODE_ENV !== 'production',
  livekitConfigured: Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET),
  anthropicConfigured: Boolean(env.ANTHROPIC_API_KEY),
  internalSecretIsDefault: env.INTERNAL_API_SECRET === 'change-me-to-a-long-random-string',
};

export type Config = typeof config;
