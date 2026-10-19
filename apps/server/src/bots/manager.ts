import { createHash } from 'node:crypto';
import type { AgentStatus, BotStatus, MeetingSummary, TranscriptSegment } from '@copilot/shared';
import { nanoid } from 'nanoid';
import type { Logger } from '../logger.js';
import type { MeetingService } from '../meetings/service.js';
import {
  platformFromUrl,
  SUPPORTED_PLATFORMS,
  UnsupportedMeetingUrlError,
  type BotStatusChange,
  type BotUtterance,
  type MeetingBotProvider,
  type WebhookInput,
  type WebhookVerdict,
} from './provider.js';

/** Partials for one speaker are forwarded at most this often (finals always pass). */
const PARTIAL_THROTTLE_MS = 300;
/** Webhook delivery ids remembered for retry deduplication. */
const SEEN_DELIVERIES = 2000;

export interface UtteranceSlot {
  segmentId: string;
  startedAt: string;
  lastPartialAt: number;
  lastPartialText: string;
}

/**
 * Pure: one in-flight segmentId per (bot, speaker). Partials reuse the slot's id, a final closes the slot
 * so the speaker's next utterance gets a fresh id.
 */
export function pairUtterance(
  slot: UtteranceSlot | undefined,
  utterance: BotUtterance,
  meetingId: string,
  now: Date,
  newId: () => string = () => `SG_${nanoid(12)}`,
): { segment: TranscriptSegment; nextSlot: UtteranceSlot | null } {
  const iso = now.toISOString();
  const segmentId = slot?.segmentId ?? newId();
  const startedAt = slot?.startedAt ?? iso;
  const segment: TranscriptSegment = {
    segmentId,
    meetingId,
    speakerId: utterance.speakerId,
    ...(utterance.speakerName ? { speakerName: utterance.speakerName } : {}),
    text: utterance.text,
    final: utterance.final,
    ...(utterance.language ? { language: utterance.language } : {}),
    startedAt,
    ...(utterance.final ? { endedAt: iso } : {}),
  };
  const nextSlot = utterance.final ? null : { segmentId, startedAt, lastPartialAt: now.getTime(), lastPartialText: utterance.text };
  return { segment, nextSlot };
}

export interface BotMeetingManagerDeps {
  provider: MeetingBotProvider;
  meetings: Pick<
    MeetingService,
    'createMeeting' | 'getMeeting' | 'getMeetingByBot' | 'getBotId' | 'ingestSegment' | 'setAgentStatus' | 'endMeeting' | 'updateBot'
  >;
  logger: Logger;
  /** Public URL the provider posts real-time transcript events to. */
  realtimeEndpointUrl: string;
  botName: string;
  now?: () => Date;
}

/**
 * Owns the meeting lifecycle: sends a bot into the Zoom / Google Meet call, turns provider webhooks
 * into transcript segments and agent status, and ends the meeting when the bot leaves.
 */
export class BotMeetingManager {
  private readonly meetingByBot = new Map<string, string>();
  private readonly botByMeeting = new Map<string, string>();
  private readonly botStatus = new Map<string, BotStatus>();
  private readonly slots = new Map<string, UtteranceSlot>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly seen = new Set<string>();

  constructor(private readonly deps: BotMeetingManagerDeps) {}

  async createMeeting(input: { title: string; projectId?: string; meetingUrl: string }): Promise<MeetingSummary> {
    const platform = platformFromUrl(input.meetingUrl);
    if (!SUPPORTED_PLATFORMS.includes(platform)) throw new UnsupportedMeetingUrlError();
    const meeting = await this.deps.meetings.createMeeting({
      title: input.title,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      platform,
      meetingUrl: input.meetingUrl,
    });
    let botId: string;
    try {
      ({ botId } = await this.deps.provider.createBot({
        meetingUrl: input.meetingUrl,
        botName: this.deps.botName,
        realtimeEndpointUrl: this.deps.realtimeEndpointUrl,
        metadata: { meetingId: meeting.meetingId },
      }));
    } catch (err) {
      await this.deps.meetings.endMeeting(meeting.meetingId).catch(() => {});
      throw err;
    }
    this.meetingByBot.set(botId, meeting.meetingId);
    this.botByMeeting.set(meeting.meetingId, botId);
    this.botStatus.set(botId, 'created');
    await this.deps.meetings.updateBot(meeting.meetingId, { botId, botStatus: 'created' });
    this.deps.meetings.setAgentStatus(meeting.meetingId, 'connecting', 'The copilot bot is being sent to the meeting', 'created');
    this.deps.logger.info({ meetingId: meeting.meetingId, botId, platform, provider: this.deps.provider.name }, 'meeting bot created');
    return this.deps.meetings.getMeeting(meeting.meetingId);
  }

  /** Removes the bot from the call (best effort) and ends the meeting. */
  async end(meetingId: string): Promise<void> {
    const botId = this.botByMeeting.get(meetingId) ?? (await this.deps.meetings.getBotId(meetingId));
    if (botId) {
      await this.deps.provider.leaveCall(botId).catch((err) => this.deps.logger.warn({ err, meetingId, botId }, 'failed to remove the bot from the call'));
      this.forget(botId, meetingId);
      await this.deps.meetings.updateBot(meetingId, { botStatus: 'ended' });
      this.deps.meetings.setAgentStatus(meetingId, 'disconnected', 'The copilot bot was removed from the meeting', 'ended');
    }
    await this.deps.meetings.endMeeting(meetingId);
  }

  verifyWebhook(input: WebhookInput): WebhookVerdict {
    return this.deps.provider.verifyWebhook(input);
  }

  /**
   * Runs after the HTTP response has been sent. Deliveries are deduplicated by id (providers retry on
   * any non-2xx) and processed in order per bot so partial/final pairing survives interleaved requests.
   */
  async handleWebhook(body: string, deliveryId?: string): Promise<void> {
    const key = deliveryId ?? createHash('sha256').update(body).digest('hex');
    if (this.seen.has(key)) {
      this.deps.logger.debug({ deliveryId: key }, 'duplicate webhook delivery ignored');
      return;
    }
    this.remember(key);
    for (const event of this.deps.provider.parseWebhook(body)) {
      if (event.kind === 'ignored') {
        this.deps.logger.debug({ event: event.event, botId: event.botId }, 'ignored provider event');
        continue;
      }
      const botId = event.kind === 'utterance' ? event.utterance.botId : event.change.botId;
      await this.enqueue(botId, async () => {
        const meetingId = await this.resolveMeeting(botId);
        if (!meetingId) {
          this.deps.logger.warn({ botId, kind: event.kind }, 'webhook for an unknown bot');
          return;
        }
        if (event.kind === 'utterance') await this.onUtterance(meetingId, event.utterance);
        else await this.onStatus(meetingId, event.change);
      });
    }
  }

  private async onUtterance(meetingId: string, u: BotUtterance): Promise<void> {
    const status = this.botStatus.get(u.botId);
    if (status === 'ended') {
      this.deps.logger.debug({ meetingId, botId: u.botId }, 'utterance after the bot left; dropped');
      return;
    }
    // Transcript data proves the bot is in the call, even when status webhooks are not configured in the dashboard.
    if (status !== 'recording') await this.applyStatus(meetingId, u.botId, 'recording', 'listening', 'The copilot bot is listening');

    const key = `${u.botId}:${u.speakerId}`;
    const slot = this.slots.get(key);
    const now = this.deps.now?.() ?? new Date();
    if (!u.final && slot && (now.getTime() - slot.lastPartialAt < PARTIAL_THROTTLE_MS || slot.lastPartialText === u.text)) return;
    const { segment, nextSlot } = pairUtterance(slot, u, meetingId, now);
    if (nextSlot) this.slots.set(key, nextSlot);
    else this.slots.delete(key);
    await this.deps.meetings.ingestSegment(segment);
  }

  private async onStatus(meetingId: string, change: BotStatusChange): Promise<void> {
    this.deps.logger.info({ meetingId, botId: change.botId, code: change.code, subCode: change.subCode }, 'bot status changed');
    // `done` follows `call_ended` (and both may follow a user-initiated end): keep the more specific detail already shown.
    if (this.botStatus.get(change.botId) === 'ended') return;
    await this.applyStatus(meetingId, change.botId, change.botStatus, change.agentStatus, change.detail);
    if (change.terminal) {
      this.clearSlots(change.botId);
      await this.deps.meetings.endMeeting(meetingId);
    }
  }

  private async applyStatus(meetingId: string, botId: string, botStatus: BotStatus, agentStatus: AgentStatus, detail: string): Promise<void> {
    this.botStatus.set(botId, botStatus);
    await this.deps.meetings.updateBot(meetingId, { botStatus });
    this.deps.meetings.setAgentStatus(meetingId, agentStatus, detail, botStatus);
  }

  private async resolveMeeting(botId: string): Promise<string | null> {
    const cached = this.meetingByBot.get(botId);
    if (cached) return cached;
    // After a restart (or an end()) the maps are empty: rebuild them from the persisted bot id.
    const meeting = await this.deps.meetings.getMeetingByBot(botId);
    if (!meeting) return null;
    this.meetingByBot.set(botId, meeting.meetingId);
    this.botByMeeting.set(meeting.meetingId, botId);
    if (meeting.botStatus) this.botStatus.set(botId, meeting.botStatus);
    return meeting.meetingId;
  }

  private enqueue(botId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(botId) ?? Promise.resolve();
    const next = previous.then(work).catch((err) => this.deps.logger.warn({ err, botId }, 'bot event processing failed'));
    this.queues.set(botId, next);
    void next.finally(() => {
      if (this.queues.get(botId) === next) this.queues.delete(botId);
    });
    return next;
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > SEEN_DELIVERIES) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private clearSlots(botId: string): void {
    for (const key of this.slots.keys()) if (key.startsWith(`${botId}:`)) this.slots.delete(key);
  }

  private forget(botId: string, meetingId: string): void {
    this.clearSlots(botId);
    this.meetingByBot.delete(botId);
    this.botByMeeting.delete(meetingId);
    this.botStatus.delete(botId);
  }
}
