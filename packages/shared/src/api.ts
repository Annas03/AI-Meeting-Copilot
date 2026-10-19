import { z } from 'zod';
import {
  AnswerSchema,
  BotStatusSchema,
  BriefingSchema,
  MeetingPlatformSchema,
  MeetingStateSchema,
  ParticipantSchema,
  TranscriptSegmentSchema,
} from './events.js';

// ---------------------------------------------------------------------------
// Public REST API (web client -> server)
// ---------------------------------------------------------------------------

export const CreateMeetingRequestSchema = z.object({
  title: z.string().min(1).max(200),
  /** Knowledge project (index) this meeting may query. Defaults to the server's DEFAULT_PROJECT_ID. */
  projectId: z.string().min(1).max(100).optional(),
  /** Zoom / Google Meet link the copilot bot joins. */
  meetingUrl: z.string().url().max(2000),
});
export type CreateMeetingRequest = z.infer<typeof CreateMeetingRequestSchema>;

export const MeetingSummarySchema = z.object({
  meetingId: z.string(),
  title: z.string(),
  projectId: z.string(),
  status: z.enum(['scheduled', 'live', 'ended']),
  createdAt: z.string(),
  /** Absent only on meetings created before the bot integration. */
  platform: MeetingPlatformSchema.optional(),
  meetingUrl: z.string().optional(),
  /** Last known lifecycle state of the meeting bot. */
  botStatus: BotStatusSchema.optional(),
});
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

export const JoinMeetingRequestSchema = z.object({
  name: z.string().min(1).max(80),
});
export type JoinMeetingRequest = z.infer<typeof JoinMeetingRequestSchema>;

export const JoinMeetingResponseSchema = z.object({
  meeting: MeetingSummarySchema,
  participant: ParticipantSchema,
  /** Opaque token for REST + WebSocket calls to this server. */
  sessionToken: z.string(),
  /** Whether the late-joiner briefing will be pushed over the WebSocket. */
  briefingPending: z.boolean(),
});
export type JoinMeetingResponse = z.infer<typeof JoinMeetingResponseSchema>;

export const AskRequestSchema = z.object({
  question: z.string().min(3).max(2000),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskResponseSchema = z.object({
  investigationId: z.string(),
  /** True when an equivalent investigation was already in progress and was reused. */
  deduplicated: z.boolean(),
});
export type AskResponse = z.infer<typeof AskResponseSchema>;

export const TranscriptResponseSchema = z.object({
  meetingId: z.string(),
  segments: z.array(TranscriptSegmentSchema),
});

export const StateResponseSchema = z.object({
  state: MeetingStateSchema,
  answers: z.array(AnswerSchema),
});

export const BriefingResponseSchema = z.object({
  briefing: BriefingSchema,
});

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  qdrant: z.enum(['ok', 'unavailable']),
  anthropic: z.enum(['configured', 'missing']),
  /** Whether the server can send meeting bots; meetings cannot be created without it. */
  recall: z.enum(['configured', 'missing']),
  embeddings: z.string(),
});

export const OkResponseSchema = z.object({ ok: z.literal(true) });

/** Dev-only helper used by automated tests to inject transcript lines without audio. */
export const DevTranscriptRequestSchema = z.object({
  speakerName: z.string().min(1).default('Tester'),
  text: z.string().min(1),
});
