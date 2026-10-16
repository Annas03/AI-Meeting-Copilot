import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

export interface AgentEnv {
  LIVEKIT_URL: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  SERVER_URL: string;
  INTERNAL_API_SECRET: string;
  STT_PROVIDER: 'livekit' | 'deepgram';
  STT_MODEL: string;
  STT_LANGUAGE: string;
  DEEPGRAM_API_KEY: string;
  AGENT_NAME: string;
}

/** Loads the repository root .env (found by walking up to the folder holding .env.example). */
export function loadEnv(): AgentEnv {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.env.example');
    if (existsSync(candidate)) {
      const envPath = path.join(dir, '.env');
      if (existsSync(envPath)) loadDotenv({ path: envPath, quiet: true });
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const provider = (process.env.STT_PROVIDER ?? 'livekit').toLowerCase() === 'deepgram' ? 'deepgram' : 'livekit';
  return {
    LIVEKIT_URL: process.env.LIVEKIT_URL ?? '',
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY ?? '',
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET ?? '',
    SERVER_URL: (process.env.SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
    INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET ?? 'change-me-to-a-long-random-string',
    STT_PROVIDER: provider,
    STT_MODEL: process.env.STT_MODEL ?? (provider === 'deepgram' ? 'nova-3' : 'deepgram/nova-3'),
    STT_LANGUAGE: process.env.STT_LANGUAGE ?? 'en',
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY ?? '',
    AGENT_NAME: process.env.LIVEKIT_AGENT_NAME ?? '',
  };
}
