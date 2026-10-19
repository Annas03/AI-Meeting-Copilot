import { nanoid } from 'nanoid';
import { RecallBotProvider, type RecallClientOptions } from './client.js';
import type { CreateBotInput } from '../provider.js';

/**
 * Offline stand-in selected with RECALL_API_KEY=fake (never in production): no network calls, but the same
 * webhook verification and parsing, so scripts/smoke.mjs exercises the real ingest path.
 */
export class FakeRecallProvider extends RecallBotProvider {
  override readonly name = 'recall-fake';

  constructor(options: Omit<RecallClientOptions, 'apiKey' | 'baseUrl'>) {
    super({ ...options, apiKey: 'fake', baseUrl: 'http://recall.invalid' });
  }

  /** Derived from the meeting id so scripts/smoke.mjs can address the bot without reading server state. */
  override async createBot(input: CreateBotInput): Promise<{ botId: string }> {
    return { botId: `fake-${input.metadata.meetingId ?? nanoid(8)}` };
  }

  override async leaveCall(): Promise<void> {}

  override async getBot(botId: string): Promise<{ botId: string; code: string | null }> {
    return { botId, code: null };
  }
}
