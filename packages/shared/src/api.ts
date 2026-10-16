import { z } from 'zod';
import {
  AgentStatusSchema,
  AnswerSchema,
  BriefingSchema,
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
});
export type CreateMeetingRequest = z.infer<typeof CreateMeetingRequestSchema>;

export const MeetingSummarySchema = z.object({
  meetingId: z.string(),
  title: z.string(),
  projectId: z.string(),
  roomName: z.string(),
  status: z.enum(['scheduled', 'live', 'ended']),
  createdAt: z.string(),
});
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

export const JoinMeetingRequestSchema = z.object({
  name: z.string().min(1).max(80),
});
export type JoinMeetingRequest = z.infer<typeof JoinMeetingRequestSchema>;

export const JoinMeetingResponseSchema = z.object({
  meeting: MeetingSummarySchema,
  participant: ParticipantSchema,
  /** LiveKit server URL the browser connects to. */
  livekitUrl: z.string(),
  /** LiveKit access token for this participant. */
  livekitToken: z.string(),
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
  livekit: z.enum(['configured', 'missing']),
  anthropic: z.enum(['configured', 'missing']),
  embeddings: z.string(),
});

// ---------------------------------------------------------------------------
// Internal API (agent -> server, authenticated with INTERNAL_API_SECRET)
// ---------------------------------------------------------------------------

export const InternalTranscriptRequestSchema = z.object({
  segment: TranscriptSegmentSchema,
});
export type InternalTranscriptRequest = z.infer<typeof InternalTranscriptRequestSchema>;

export const InternalAgentStatusRequestSchema = z.object({
  meetingId: z.string(),
  roomName: z.string(),
  status: AgentStatusSchema,
  detail: z.string().optional(),
});
export type InternalAgentStatusRequest = z.infer<typeof InternalAgentStatusRequestSchema>;

/** Dev-only helper used by automated tests to inject transcript lines without audio. */
export const DevTranscriptRequestSchema = z.object({
  speakerName: z.string().min(1).default('Tester'),
  text: z.string().min(1),
});
