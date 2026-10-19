import path from 'node:path';
import { loadRootEnv } from '@copilot/knowledge';
import { z } from 'zod';

const repoRoot = loadRootEnv();

/** .env templates leave optional values empty; treat '' as unset so `.url()` / enum checks do not reject them. */
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.string().default('info'),
  WEB_ORIGIN: z.string().optional(),

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

  /** Recall.ai meeting bots (the copilot joins Zoom / Google Meet calls). 'fake' selects the offline provider outside production. */
  RECALL_API_KEY: z.string().optional(),
  RECALL_REGION: z.preprocess(blankToUndefined, z.enum(['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1']).default('us-east-1')),
  /** Svix signing secret (whsec_...) from the Recall dashboard; unset = webhook signatures are not verified. */
  RECALL_WEBHOOK_SECRET: z.string().optional(),
  RECALL_BOT_NAME: z.preprocess(blankToUndefined, z.string().max(100).default('Meeting Copilot')),
  /** Public https base URL of this server, reachable by Recall for webhooks (an ngrok/cloudflared tunnel in dev). */
  PUBLIC_SERVER_URL: z.preprocess(blankToUndefined, z.string().url().optional()),

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
  anthropicConfigured: Boolean(env.ANTHROPIC_API_KEY),
  recallFake: env.RECALL_API_KEY === 'fake' && env.NODE_ENV !== 'production',
  recallConfigured: Boolean(env.RECALL_API_KEY && env.PUBLIC_SERVER_URL) && !(env.RECALL_API_KEY === 'fake' && env.NODE_ENV === 'production'),
  recallBaseUrl: `https://${env.RECALL_REGION}.recall.ai`,
  publicServerUrl: env.PUBLIC_SERVER_URL?.replace(/\/$/, ''),
};

export type Config = typeof config;
