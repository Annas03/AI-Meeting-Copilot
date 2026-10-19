import type { Logger } from '../../logger.js';
import {
  BotProviderError,
  type CreateBotInput,
  type MeetingBotProvider,
  type ProviderEvent,
  type WebhookInput,
  type WebhookVerdict,
} from '../provider.js';
import { parseRecallWebhook } from './mappers.js';
import { verifyRecallWebhook } from './webhook.js';

export interface RecallClientOptions {
  apiKey: string;
  /** Regional base URL, e.g. https://us-east-1.recall.ai */
  baseUrl: string;
  /** Svix signing secret for webhooks; unset disables verification. */
  webhookSecret?: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Recall.ai Meeting Bot API: https://docs.recall.ai (bot create / leave / retrieve + real-time transcript webhooks). */
export class RecallBotProvider implements MeetingBotProvider {
  readonly name: string = 'recall';
  private readonly options: Required<Pick<RecallClientOptions, 'apiKey' | 'baseUrl' | 'timeoutMs'>> & RecallClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RecallClientOptions) {
    this.options = { timeoutMs: 15_000, ...options, baseUrl: options.baseUrl.replace(/\/$/, '') };
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createBot(input: CreateBotInput): Promise<{ botId: string }> {
    const body = {
      meeting_url: input.meetingUrl,
      bot_name: input.botName,
      metadata: input.metadata,
      recording_config: {
        // Recall's own streaming transcription; low-latency mode is English only.
        transcript: { provider: { recallai_streaming: { mode: 'prioritize_low_latency', language_code: 'en' } } },
        realtime_endpoints: [{ type: 'webhook', url: input.realtimeEndpointUrl, events: ['transcript.data', 'transcript.partial_data'] }],
      },
    };
    const json = await this.request<{ id: string }>('POST', '/api/v1/bot/', body);
    return { botId: json.id };
  }

  async leaveCall(botId: string): Promise<void> {
    try {
      await this.request('POST', `/api/v1/bot/${encodeURIComponent(botId)}/leave_call/`);
    } catch (err) {
      // 4xx means the bot is already out of the call (or never got in); that is the state we want.
      if (err instanceof BotProviderError && err.status >= 400 && err.status < 500) {
        this.options.logger.info({ botId, status: err.status }, 'bot already left the call');
        return;
      }
      throw err;
    }
  }

  async getBot(botId: string): Promise<{ botId: string; code: string | null }> {
    const json = await this.request<{ id: string; status_changes?: { code: string }[] }>('GET', `/api/v1/bot/${encodeURIComponent(botId)}/`);
    return { botId: json.id, code: json.status_changes?.at(-1)?.code ?? null };
  }

  verifyWebhook(input: WebhookInput): WebhookVerdict {
    return verifyRecallWebhook({ ...input, ...(this.options.webhookSecret ? { secret: this.options.webhookSecret } : {}) });
  }

  parseWebhook(body: string): ProviderEvent[] {
    return parseRecallWebhook(body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Token ${this.options.apiKey}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new BotProviderError(res.status, `Recall.ai ${method} ${path} failed with ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}
