import { randomBytes } from 'node:crypto';
import type { Knowledge } from '@copilot/knowledge';
import type { AgentStatus, JoinMeetingResponse, MeetingSummary, Participant, TranscriptSegment } from '@copilot/shared';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import type { AnswerContext } from '../copilot/answerer.js';
import type { BriefingService } from '../copilot/briefing.js';
import type { QuestionDetector } from '../copilot/detector.js';
import type { InvestigationManager } from '../copilot/investigations.js';
import type { MeetingMemory } from '../copilot/memory.js';
import type { Database } from '../db/index.js';
import { meetings, participants, transcriptSegments } from '../db/schema.js';
import type { EventHub } from '../events/hub.js';
import { createParticipantToken, roomNameFor } from '../livekit/tokens.js';
import type { Logger } from '../logger.js';

export interface Session {
  token: string;
  meetingId: string;
  identity: string;
  name: string;
}

export interface MeetingServiceDeps {
  db: Database;
  hub: EventHub;
  knowledge: Knowledge;
  memory: MeetingMemory;
  briefings: BriefingService;
  detector: QuestionDetector;
  investigations: InvestigationManager;
  logger: Logger;
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

const RECENT_CONTEXT = 12;

export class MeetingService {
  private readonly sessions = new Map<string, Session>();
  private readonly sequences = new Map<string, number>();
  private readonly recentSegments = new Map<string, TranscriptSegment[]>();
  private readonly repositoryNames = new Map<string, string | undefined>();

  constructor(private readonly deps: MeetingServiceDeps) {}

  async createMeeting(input: { title: string; projectId?: string }): Promise<MeetingSummary> {
    const id = nanoid(10);
    const row = {
      id,
      title: input.title,
      projectId: input.projectId ?? config.DEFAULT_PROJECT_ID,
      roomName: roomNameFor(id),
      status: 'live' as const,
      createdAt: new Date().toISOString(),
    };
    await this.deps.db.insert(meetings).values(row);
    this.deps.hub.emit(id, 'meeting.started', { title: input.title });
    this.deps.logger.info({ meetingId: id, projectId: row.projectId }, 'meeting created');
    return this.toSummary({ ...row, endedAt: null });
  }

  async getMeeting(meetingId: string): Promise<MeetingSummary> {
    const rows = await this.deps.db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError(`Meeting ${meetingId} not found`);
    return this.toSummary(row);
  }

  async getMeetingByRoom(roomName: string): Promise<MeetingSummary | null> {
    const rows = await this.deps.db.select().from(meetings).where(eq(meetings.roomName, roomName)).limit(1);
    return rows[0] ? this.toSummary(rows[0]) : null;
  }

  /**
   * Registers a participant and mints their LiveKit token. Without LiveKit credentials the join
   * still succeeds in text-only mode (empty livekitUrl/token) so the copilot panel can be used
   * with typed questions and the dev transcript injector.
   */
  async join(meetingId: string, name: string): Promise<JoinMeetingResponse> {
    const meeting = await this.getMeeting(meetingId);
    const identity = `${slug(name)}-${nanoid(6)}`;
    const sessionToken = randomBytes(24).toString('hex');
    const participant: Participant = { identity, name, isAgent: false };

    await this.deps.db.insert(participants).values({ identity, meetingId, name, isAgent: false, sessionToken, joinedAt: new Date().toISOString() });
    this.sessions.set(sessionToken, { token: sessionToken, meetingId, identity, name });

    const livekitToken = config.livekitConfigured ? await createParticipantToken({ roomName: meeting.roomName, identity, name }) : '';
    this.deps.hub.emit(meetingId, 'participant.joined', { participant });

    const state = await this.deps.memory.getState(meetingId);
    const briefingPending = state.version > 0;
    if (briefingPending) this.deps.briefings.deliverTo(meetingId, identity);

    this.deps.logger.info({ meetingId, identity, textOnly: !config.livekitConfigured }, 'participant joined');
    return { meeting, participant, livekitUrl: config.livekitConfigured ? config.LIVEKIT_URL! : '', livekitToken, sessionToken, briefingPending };
  }

  async participantLeft(meetingId: string, identity: string, name?: string): Promise<void> {
    await this.deps.db
      .update(participants)
      .set({ leftAt: new Date().toISOString() })
      .where(and(eq(participants.identity, identity), eq(participants.meetingId, meetingId), isNull(participants.leftAt)));
    this.deps.hub.emit(meetingId, 'participant.left', { participant: { identity, name: name ?? identity, isAgent: false } });
  }

  async resolveSession(token: string | undefined): Promise<Session | null> {
    if (!token) return null;
    const cached = this.sessions.get(token);
    if (cached) return cached;
    const rows = await this.deps.db.select().from(participants).where(eq(participants.sessionToken, token)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const session: Session = { token, meetingId: row.meetingId, identity: row.identity, name: row.name };
    this.sessions.set(token, session);
    return session;
  }

  setAgentStatus(meetingId: string, status: AgentStatus, detail?: string): void {
    this.deps.hub.emit(meetingId, 'agent.status', { status, ...(detail ? { detail } : {}) });
  }

  /**
   * Entry point for transcript segments from the agent (or the dev injector). Partials are only
   * broadcast; finals are persisted, broadcast, folded into memory and checked for questions.
   */
  async ingestSegment(segment: TranscriptSegment): Promise<TranscriptSegment> {
    const meetingId = segment.meetingId;
    if (!segment.final) {
      this.deps.hub.emit(meetingId, 'transcript.partial', { segment });
      return segment;
    }
    const text = segment.text.trim();
    if (!text) return segment;
    const sequence = await this.nextSequence(meetingId);
    const stored: TranscriptSegment = { ...segment, text, sequence };
    await this.deps.db
      .insert(transcriptSegments)
      .values({
        segmentId: stored.segmentId,
        meetingId,
        speakerId: stored.speakerId,
        speakerName: stored.speakerName ?? null,
        sequence,
        text,
        language: stored.language ?? null,
        startedAt: stored.startedAt ?? null,
        endedAt: stored.endedAt ?? null,
      })
      .onConflictDoNothing();
    const recent = [...(this.recentSegments.get(meetingId) ?? []), stored].slice(-RECENT_CONTEXT);
    this.recentSegments.set(meetingId, recent);
    this.deps.hub.emit(meetingId, 'transcript.final', { segment: stored });
    this.deps.memory.onFinalSegment(meetingId, stored);
    void this.detectQuestion(stored, recent);
    return stored;
  }

  private async detectQuestion(segment: TranscriptSegment, recent: TranscriptSegment[]): Promise<void> {
    const started = Date.now();
    try {
      const detected = await this.deps.detector.detect({ candidate: segment, recent });
      if (!detected) return;
      const detectionMs = Date.now() - started;
      this.deps.logger.info({ meetingId: segment.meetingId, question: detected.question, confidence: detected.confidence, detectionMs }, 'question detected');
      await this.deps.investigations.start({
        meetingId: segment.meetingId,
        question: detected.question,
        triggerSegmentId: segment.segmentId,
        askedBy: segment.speakerName ?? segment.speakerId,
        detectionMs,
      });
    } catch (err) {
      this.deps.logger.warn({ err }, 'question detection failed');
    }
  }

  async getTranscript(meetingId: string): Promise<TranscriptSegment[]> {
    const rows = await this.deps.db
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.meetingId, meetingId))
      .orderBy(asc(transcriptSegments.sequence));
    return rows.map((r) => ({
      segmentId: r.segmentId,
      meetingId: r.meetingId,
      speakerId: r.speakerId,
      ...(r.speakerName ? { speakerName: r.speakerName } : {}),
      sequence: r.sequence,
      text: r.text,
      final: true,
      ...(r.language ? { language: r.language } : {}),
      ...(r.startedAt ? { startedAt: r.startedAt } : {}),
      ...(r.endedAt ? { endedAt: r.endedAt } : {}),
    }));
  }

  async getContext(meetingId: string): Promise<AnswerContext> {
    const meeting = await this.getMeeting(meetingId);
    const state = await this.deps.memory.getState(meetingId);
    let recent = this.recentSegments.get(meetingId);
    if (!recent) {
      recent = (await this.getTranscript(meetingId)).slice(-RECENT_CONTEXT);
      this.recentSegments.set(meetingId, recent);
    }
    const repository = await this.repositoryFor(meeting.projectId);
    return { meetingTitle: meeting.title, projectId: meeting.projectId, ...(repository ? { repository } : {}), state, recentTranscript: recent };
  }

  async endMeeting(meetingId: string): Promise<void> {
    await this.deps.db.update(meetings).set({ status: 'ended', endedAt: new Date().toISOString() }).where(eq(meetings.id, meetingId));
    await this.deps.memory.flush(meetingId).catch(() => {});
    this.deps.hub.emit(meetingId, 'meeting.ended', {});
  }

  private async repositoryFor(projectId: string): Promise<string | undefined> {
    if (this.repositoryNames.has(projectId)) return this.repositoryNames.get(projectId);
    const manifest = await this.deps.knowledge.project(projectId).catch(() => null);
    this.repositoryNames.set(projectId, manifest?.repository);
    return manifest?.repository;
  }

  private async nextSequence(meetingId: string): Promise<number> {
    let current = this.sequences.get(meetingId);
    if (current === undefined) {
      const rows = await this.deps.db
        .select({ value: max(transcriptSegments.sequence) })
        .from(transcriptSegments)
        .where(eq(transcriptSegments.meetingId, meetingId));
      current = rows[0]?.value ?? 0;
    }
    const next = current + 1;
    this.sequences.set(meetingId, next);
    return next;
  }

  private toSummary(row: typeof meetings.$inferSelect): MeetingSummary {
    return { meetingId: row.id, title: row.title, projectId: row.projectId, roomName: row.roomName, status: row.status, createdAt: row.createdAt };
  }
}

export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return s || 'guest';
}
