import type { AgentStatus, BotStatus, MeetingPlatform } from '@copilot/shared';

/** Platforms a bot can be sent to today. Teams links parse but are rejected until that path is exercised. */
export const SUPPORTED_PLATFORMS: readonly MeetingPlatform[] = ['zoom', 'google_meet'];

export function platformFromUrl(url: string): MeetingPlatform {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (host === 'zoom.us' || host.endsWith('.zoom.us') || host === 'zoom.com' || host.endsWith('.zoom.com')) return 'zoom';
  if (host === 'meet.google.com') return 'google_meet';
  if (host === 'teams.microsoft.com' || host.endsWith('.teams.microsoft.com') || host === 'teams.live.com') return 'teams';
  return 'unknown';
}

export interface CreateBotInput {
  meetingUrl: string;
  botName: string;
  /** Public URL the provider streams real-time transcript events to. */
  realtimeEndpointUrl: string;
  metadata: Record<string, string>;
}

/** One spoken utterance (partial or final) attributed to a meeting participant. */
export interface BotUtterance {
  botId: string;
  speakerId: string;
  speakerName?: string;
  text: string;
  final: boolean;
  language?: string;
}

export interface BotStatusChange {
  botId: string;
  /** Provider-specific code, kept for logs. */
  code: string;
  subCode?: string;
  botStatus: BotStatus;
  agentStatus: AgentStatus;
  /** Human-readable hint shown in the copilot panel. */
  detail: string;
  /** Nothing else will arrive for this bot. */
  terminal: boolean;
}

export type ProviderEvent =
  | { kind: 'utterance'; utterance: BotUtterance }
  | { kind: 'status'; change: BotStatusChange }
  | { kind: 'ignored'; event: string; botId?: string };

export interface WebhookInput {
  /** Raw request body, exactly as received. */
  body: string;
  headers: { id?: string; timestamp?: string; signature?: string };
  /** Query-string token, for providers that authenticate endpoints through the URL. */
  token?: string;
}

export type WebhookVerdict = { ok: true } | { ok: false; reason: string };

/**
 * A service that puts a bot into an external meeting and streams what it hears back to us.
 * Implementations stay stateless: pairing partial/final utterances into segments is the manager's job.
 */
export interface MeetingBotProvider {
  readonly name: string;
  createBot(input: CreateBotInput): Promise<{ botId: string }>;
  /** Idempotent: a bot that already left resolves normally. */
  leaveCall(botId: string): Promise<void>;
  getBot(botId: string): Promise<{ botId: string; code: string | null }>;
  verifyWebhook(input: WebhookInput): WebhookVerdict;
  parseWebhook(body: string): ProviderEvent[];
}

export class BotProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BotProviderError';
  }
}

export class UnsupportedMeetingUrlError extends Error {
  constructor(message = 'Only Zoom and Google Meet links are supported') {
    super(message);
    this.name = 'UnsupportedMeetingUrlError';
  }
}
