import { z } from 'zod';
import { ASSESSMENTS } from './constants.js';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export const ParticipantSchema = z.object({
  /** LiveKit participant identity (stable per join). */
  identity: z.string().min(1),
  /** Display name. */
  name: z.string().min(1),
  /** True for the AI participant. */
  isAgent: z.boolean().default(false),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const TranscriptSegmentSchema = z.object({
  /** Stable id for the utterance; interim and final events for one utterance share it. */
  segmentId: z.string().min(1),
  meetingId: z.string().min(1),
  speakerId: z.string().min(1),
  speakerName: z.string().optional(),
  /** Monotonic per meeting, assigned by the server when a final segment is stored. */
  sequence: z.number().int().nonnegative().optional(),
  text: z.string(),
  final: z.boolean(),
  language: z.string().optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  endedAt: z.string().datetime({ offset: true }).optional(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const AssessmentSchema = z.enum(ASSESSMENTS);
export type Assessment = z.infer<typeof AssessmentSchema>;

export const EvidenceRefSchema = z.object({
  /** Citation label used in the answer text, e.g. "E1". */
  ref: z.string(),
  repository: z.string(),
  filePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  contentType: z.string(),
  language: z.string().optional(),
  symbol: z.string().optional(),
  /** Retrieval similarity score. */
  score: z.number(),
  /** Whether the answer text actually cited this chunk. */
  cited: z.boolean(),
  /** Short excerpt for display. */
  excerpt: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const AnswerLatencySchema = z.object({
  detectionMs: z.number().optional(),
  retrievalMs: z.number().optional(),
  firstTokenMs: z.number().optional(),
  totalMs: z.number().optional(),
});

export const AnswerSchema = z.object({
  investigationId: z.string(),
  meetingId: z.string(),
  question: z.string(),
  assessment: AssessmentSchema,
  /** Full markdown answer following the blueprint structure (assessment, components, risks, evidence, next step). */
  markdown: z.string(),
  evidence: z.array(EvidenceRefSchema),
  /** True when retrieval found nothing relevant and the model was told to say so. */
  insufficientEvidence: z.boolean(),
  model: z.string(),
  latency: AnswerLatencySchema,
  createdAt: z.string().datetime({ offset: true }),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const InvestigationStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
export type InvestigationStatus = z.infer<typeof InvestigationStatusSchema>;

export const InvestigationSummarySchema = z.object({
  investigationId: z.string(),
  question: z.string(),
  status: InvestigationStatusSchema,
  assessment: AssessmentSchema.optional(),
  startedAt: z.string(),
});

export const MeetingStateSchema = z.object({
  meetingId: z.string(),
  /** Incremented on every change; briefings are cached per version. */
  version: z.number().int().nonnegative(),
  currentTopic: z.string(),
  rollingSummary: z.string(),
  decisions: z.array(
    z.object({ id: z.string(), text: z.string(), status: z.enum(['confirmed', 'proposed']) }),
  ),
  openQuestions: z.array(z.object({ id: z.string(), text: z.string() })),
  actionItems: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      owner: z.string().optional(),
      status: z.enum(['open', 'done']),
    }),
  ),
  investigations: z.array(InvestigationSummarySchema),
  /** File references surfaced so far, with why they matter. */
  evidence: z.array(z.object({ filePath: z.string(), note: z.string() })),
  /** Sequence of the last final transcript segment folded into this state. */
  lastSegmentSequence: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type MeetingState = z.infer<typeof MeetingStateSchema>;

export const BriefingSchema = z.object({
  meetingId: z.string(),
  stateVersion: z.number().int().nonnegative(),
  /** Markdown briefing distinguishing confirmed decisions from proposals. */
  markdown: z.string(),
  generatedAt: z.string(),
});
export type Briefing = z.infer<typeof BriefingSchema>;

export const AgentStatusSchema = z.enum(['connecting', 'listening', 'disconnected', 'error']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** Where a meeting's audio comes from: our own LiveKit room, or a Recall.ai bot sitting in an external meeting. */
export const MeetingSourceSchema = z.enum(['livekit', 'recall']);
export type MeetingSource = z.infer<typeof MeetingSourceSchema>;

export const MeetingPlatformSchema = z.enum(['zoom', 'google_meet', 'teams', 'unknown']);
export type MeetingPlatform = z.infer<typeof MeetingPlatformSchema>;

/** Normalised lifecycle of an external meeting bot; provider-specific codes are mapped onto this. */
export const BotStatusSchema = z.enum(['created', 'joining', 'waiting_room', 'in_call', 'recording', 'ended', 'failed']);
export type BotStatus = z.infer<typeof BotStatusSchema>;

// ---------------------------------------------------------------------------
// Application events (custom names; not native LiveKit events)
// ---------------------------------------------------------------------------

const base = z.object({
  eventId: z.string().min(1),
  meetingId: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
});

export const MeetingEventSchema = z.discriminatedUnion('event', [
  base.extend({ event: z.literal('meeting.started'), title: z.string() }),
  base.extend({ event: z.literal('meeting.ended') }),
  base.extend({ event: z.literal('participant.joined'), participant: ParticipantSchema }),
  base.extend({ event: z.literal('participant.left'), participant: ParticipantSchema }),
  base.extend({
    event: z.literal('agent.status'),
    status: AgentStatusSchema,
    detail: z.string().optional(),
    /** Set only for meetings driven by an external meeting bot. */
    botStatus: BotStatusSchema.optional(),
  }),
  base.extend({ event: z.literal('transcript.partial'), segment: TranscriptSegmentSchema }),
  base.extend({ event: z.literal('transcript.final'), segment: TranscriptSegmentSchema }),
  base.extend({
    event: z.literal('analysis.started'),
    investigationId: z.string(),
    question: z.string(),
    triggerSegmentId: z.string().optional(),
    /** Who asked, when known. */
    askedBy: z.string().optional(),
  }),
  base.extend({
    event: z.literal('analysis.delta'),
    investigationId: z.string(),
    /** Incremental markdown text appended to the answer being streamed. */
    text: z.string(),
  }),
  base.extend({ event: z.literal('analysis.completed'), answer: AnswerSchema }),
  base.extend({ event: z.literal('analysis.failed'), investigationId: z.string(), error: z.string() }),
  base.extend({ event: z.literal('meeting.state.updated'), state: MeetingStateSchema }),
  base.extend({
    event: z.literal('meeting.briefing.ready'),
    /** Identity of the participant the briefing was generated for, if any. */
    forParticipant: z.string().optional(),
    briefing: BriefingSchema,
  }),
]);
export type MeetingEvent = z.infer<typeof MeetingEventSchema>;
export type MeetingEventName = MeetingEvent['event'];
export type MeetingEventOf<N extends MeetingEventName> = Extract<MeetingEvent, { event: N }>;

/** Payload shape of the first message the WebSocket server sends after a client connects. */
export const WsHelloSchema = z.object({
  type: z.literal('hello'),
  meetingId: z.string(),
  participant: ParticipantSchema,
  serverTime: z.string(),
});

/** Messages a client may send over the WebSocket. */
export const WsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
]);

/** Everything the WebSocket server sends. */
export const WsServerMessageSchema = z.union([
  WsHelloSchema,
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('event'), payload: MeetingEventSchema }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
