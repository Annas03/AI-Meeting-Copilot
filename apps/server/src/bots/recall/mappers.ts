/**
 * Pure translation of Recall.ai webhook payloads into provider events. No network, no state, so the
 * mapping is unit-tested against fixed payloads and the smoke script can replay the same shapes.
 */
import type { AgentStatus, BotStatus } from '@copilot/shared';
import { z } from 'zod';
import type { BotStatusChange, BotUtterance, ProviderEvent } from '../provider.js';

const BotRefSchema = z.object({ id: z.string().min(1) }).passthrough();

export const RecallTranscriptEventSchema = z.object({
  event: z.enum(['transcript.data', 'transcript.partial_data']),
  data: z
    .object({
      data: z
        .object({
          words: z.array(z.object({ text: z.string() }).passthrough()),
          participant: z.object({ id: z.union([z.number(), z.string()]), name: z.string().nullish() }).passthrough(),
          language_code: z.string().nullish(),
        })
        .passthrough(),
      bot: BotRefSchema,
    })
    .passthrough(),
});
export type RecallTranscriptEvent = z.infer<typeof RecallTranscriptEventSchema>;

/** Current format: one event per state, e.g. `bot.in_waiting_room`, with the code repeated in data.data. */
const StatusEventSchema = z.object({
  event: z.string().regex(/^bot\./),
  data: z.object({
    data: z.object({ code: z.string().optional(), sub_code: z.string().nullish(), updated_at: z.string().optional() }),
    bot: BotRefSchema,
  }),
});
/** Legacy format: a single `bot.status_change` event carrying a status object. */
const LegacyStatusEventSchema = z.object({
  event: z.literal('bot.status_change'),
  data: z.object({ bot_id: z.string().min(1), status: z.object({ code: z.string(), sub_code: z.string().nullish() }) }),
});
export const RecallBotStatusEventSchema = z.union([LegacyStatusEventSchema, StatusEventSchema]);
export type RecallBotStatusEvent = z.infer<typeof RecallBotStatusEventSchema>;

export function recallTranscriptEventToUtterance(event: RecallTranscriptEvent): BotUtterance | null {
  const text = event.data.data.words
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!text) return null;
  const participant = event.data.data.participant;
  const id = String(participant.id);
  const name = participant.name?.trim();
  return {
    botId: event.data.bot.id,
    speakerId: `recall-${id}`,
    speakerName: name || `Speaker ${id}`,
    text,
    final: event.event === 'transcript.data',
    ...(event.data.data.language_code ? { language: event.data.data.language_code } : {}),
  };
}

interface StatusMapping {
  botStatus: BotStatus;
  agentStatus: AgentStatus;
  detail: string | ((subCode?: string) => string);
  terminal?: boolean;
}

const CALL_ENDED_DETAILS: Record<string, string> = {
  timeout_exceeded_waiting_room: 'The copilot bot was not admitted from the lobby in time',
  bot_kicked_from_call: 'The copilot bot was removed from the meeting by the host',
  bot_received_leave_call: 'The copilot bot left the meeting on request',
  timeout_exceeded_noone_joined: 'Nobody joined the meeting',
  timeout_exceeded_everyone_left: 'Everyone left the meeting',
  call_ended_by_host: 'The host ended the meeting',
};

/** Recall codes are not a closed set; anything not listed here is ignored (logged, no state change). */
const STATUS_MAP: Record<string, StatusMapping> = {
  joining_call: { botStatus: 'joining', agentStatus: 'connecting', detail: 'The copilot bot is joining the meeting' },
  in_waiting_room: { botStatus: 'waiting_room', agentStatus: 'connecting', detail: 'Admit the copilot bot from the meeting lobby to start transcription' },
  in_call_not_recording: { botStatus: 'in_call', agentStatus: 'connecting', detail: 'The copilot bot is in the meeting, waiting for recording to start' },
  recording_permission_allowed: { botStatus: 'in_call', agentStatus: 'connecting', detail: 'Recording permission granted, starting transcription' },
  recording_permission_denied: { botStatus: 'failed', agentStatus: 'error', detail: 'The host denied recording permission' },
  in_call_recording: { botStatus: 'recording', agentStatus: 'listening', detail: 'The copilot bot is listening' },
  call_ended: {
    botStatus: 'ended',
    agentStatus: 'disconnected',
    detail: (sub) => (sub && CALL_ENDED_DETAILS[sub]) ?? 'The meeting ended',
    terminal: true,
  },
  done: { botStatus: 'ended', agentStatus: 'disconnected', detail: 'The copilot bot has left the meeting', terminal: true },
  fatal: { botStatus: 'failed', agentStatus: 'error', detail: (sub) => `The copilot bot failed${sub ? ` (${sub})` : ''}`, terminal: true },
};

export function recallBotEventToStatus(event: RecallBotStatusEvent): BotStatusChange | null {
  const botId = 'bot_id' in event.data ? event.data.bot_id : event.data.bot.id;
  const status = 'status' in event.data ? event.data.status : event.data.data;
  const code = status.code ?? event.event.replace(/^bot\./, '');
  const mapping = STATUS_MAP[code];
  if (!mapping) return null;
  const subCode = status.sub_code ?? undefined;
  return {
    botId,
    code,
    ...(subCode ? { subCode } : {}),
    botStatus: mapping.botStatus,
    agentStatus: mapping.agentStatus,
    detail: typeof mapping.detail === 'function' ? mapping.detail(subCode) : mapping.detail,
    terminal: mapping.terminal ?? false,
  };
}

export function parseRecallWebhook(body: string): ProviderEvent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return [{ kind: 'ignored', event: 'invalid-json' }];
  }
  const envelope = z.object({ event: z.string() }).passthrough().safeParse(raw);
  if (!envelope.success) return [{ kind: 'ignored', event: 'unknown' }];
  const event = envelope.data.event;
  const botId = findBotId(raw);

  if (event.startsWith('transcript.')) {
    const parsed = RecallTranscriptEventSchema.safeParse(raw);
    const utterance = parsed.success ? recallTranscriptEventToUtterance(parsed.data) : null;
    return utterance ? [{ kind: 'utterance', utterance }] : [{ kind: 'ignored', event, ...(botId ? { botId } : {}) }];
  }
  if (event.startsWith('bot.')) {
    const parsed = RecallBotStatusEventSchema.safeParse(raw);
    const change = parsed.success ? recallBotEventToStatus(parsed.data) : null;
    return change ? [{ kind: 'status', change }] : [{ kind: 'ignored', event, ...(botId ? { botId } : {}) }];
  }
  return [{ kind: 'ignored', event, ...(botId ? { botId } : {}) }];
}

function findBotId(raw: unknown): string | undefined {
  const data = (raw as { data?: { bot?: { id?: unknown }; bot_id?: unknown } } | null)?.data;
  const id = data?.bot?.id ?? data?.bot_id;
  return typeof id === 'string' ? id : undefined;
}
