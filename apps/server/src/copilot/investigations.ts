import type { Knowledge, SearchHit } from '@copilot/knowledge';
import type { Answer } from '@copilot/shared';
import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import type { Database } from '../db/index.js';
import { investigations } from '../db/schema.js';
import type { EventHub } from '../events/hub.js';
import type { Logger } from '../logger.js';
import { withTimeout } from '../llm/client.js';
import { streamAnswer, type AnswerContext } from './answerer.js';
import type { MeetingMemory } from './memory.js';

export interface InvestigationDeps {
  db: Database;
  hub: EventHub;
  knowledge: Knowledge;
  memory: MeetingMemory;
  logger: Logger;
  getContext: (meetingId: string) => Promise<AnswerContext>;
}

export interface StartInvestigationInput {
  meetingId: string;
  question: string;
  triggerSegmentId?: string;
  askedBy?: string;
  detectionMs?: number;
}

interface ActiveInvestigation {
  investigationId: string;
  question: string;
  tokens: Set<string>;
  startedAt: number;
  status: 'running' | 'completed' | 'failed';
}

const DEDUPE_WINDOW_MS = 10 * 60_000;
const DEDUPE_SIMILARITY = 0.75;
const RETRIEVAL_TIMEOUT_MS = 20_000;
const ANSWER_TIMEOUT_MS = 90_000;
const DELTA_FLUSH_MS = 80;

export function questionTokens(text: string): Set<string> {
  const stop = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'we', 'can', 'could', 'is', 'it', 'do', 'does', 'and', 'or', 'with', 'be', 'our', 'this', 'that', 'are', 'you', 'i']);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !stop.has(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Starts, deduplicates and runs investigations; results stream to the meeting as events. */
export class InvestigationManager {
  private readonly recent = new Map<string, ActiveInvestigation[]>();

  constructor(private readonly deps: InvestigationDeps) {}

  async start(input: StartInvestigationInput): Promise<{ investigationId: string; deduplicated: boolean }> {
    const tokens = questionTokens(input.question);
    const now = Date.now();
    const list = (this.recent.get(input.meetingId) ?? []).filter((i) => now - i.startedAt < DEDUPE_WINDOW_MS);
    const duplicate = list.find((i) => i.status !== 'failed' && jaccard(i.tokens, tokens) >= DEDUPE_SIMILARITY);
    if (duplicate) {
      this.deps.logger.info({ meetingId: input.meetingId, question: input.question, reuse: duplicate.investigationId }, 'reusing investigation');
      this.recent.set(input.meetingId, list);
      return { investigationId: duplicate.investigationId, deduplicated: true };
    }

    const investigationId = nanoid(12);
    const startedAt = new Date().toISOString();
    const active: ActiveInvestigation = { investigationId, question: input.question, tokens, startedAt: now, status: 'running' };
    list.push(active);
    this.recent.set(input.meetingId, list);

    await this.deps.db.insert(investigations).values({
      id: investigationId,
      meetingId: input.meetingId,
      question: input.question,
      status: 'running',
      triggerSegmentId: input.triggerSegmentId ?? null,
      askedBy: input.askedBy ?? null,
      startedAt,
    });
    this.deps.hub.emit(input.meetingId, 'analysis.started', {
      investigationId,
      question: input.question,
      ...(input.triggerSegmentId ? { triggerSegmentId: input.triggerSegmentId } : {}),
      ...(input.askedBy ? { askedBy: input.askedBy } : {}),
    });
    void this.deps.memory.noteInvestigation(input.meetingId, { investigationId, question: input.question, status: 'running', startedAt }).catch(() => {});

    void this.run(input, investigationId, startedAt, active);
    return { investigationId, deduplicated: false };
  }

  async listAnswers(meetingId: string): Promise<Answer[]> {
    const rows = await this.deps.db
      .select({ answer: investigations.answer })
      .from(investigations)
      .where(eq(investigations.meetingId, meetingId))
      .orderBy(desc(investigations.startedAt));
    return rows.map((r) => r.answer).filter((a): a is Answer => Boolean(a));
  }

  private async run(input: StartInvestigationInput, investigationId: string, startedAt: string, active: ActiveInvestigation): Promise<void> {
    const { meetingId, question } = input;
    const log = this.deps.logger.child({ meetingId, investigationId });
    try {
      const context = await this.deps.getContext(meetingId);
      const retrievalStart = Date.now();
      let hits: SearchHit[] = [];
      try {
        hits = await withTimeout(
          this.deps.knowledge.search({ projectId: context.projectId, query: question, limit: config.RETRIEVAL_LIMIT }),
          RETRIEVAL_TIMEOUT_MS,
          'retrieval',
        );
      } catch (err) {
        log.warn({ err }, 'retrieval failed; answering with no evidence');
      }
      const retrievalMs = Date.now() - retrievalStart;
      log.info({ hits: hits.length, retrievalMs, top: hits[0]?.score }, 'retrieval done');

      // Batch streamed deltas so the WebSocket is not flooded token by token.
      let buffer = '';
      let timer: NodeJS.Timeout | null = null;
      const flush = () => {
        if (buffer) {
          this.deps.hub.emit(meetingId, 'analysis.delta', { investigationId, text: buffer });
          buffer = '';
        }
        timer = null;
      };
      const onDelta = (text: string) => {
        buffer += text;
        if (!timer) timer = setTimeout(flush, DELTA_FLUSH_MS);
      };

      const abort = new AbortController();
      const answer = await withTimeout(
        streamAnswer({
          investigationId,
          meetingId,
          question,
          hits,
          context,
          onDelta,
          signal: abort.signal,
          logger: log,
          latency: { ...(input.detectionMs !== undefined ? { detectionMs: input.detectionMs } : {}), retrievalMs },
        }),
        ANSWER_TIMEOUT_MS,
        'answer generation',
        abort,
      );
      if (timer) clearTimeout(timer);
      flush();

      await this.deps.db
        .update(investigations)
        .set({ status: 'completed', answer, completedAt: new Date().toISOString() })
        .where(eq(investigations.id, investigationId));
      active.status = 'completed';
      this.deps.hub.emit(meetingId, 'analysis.completed', { answer });
      await this.deps.memory.noteInvestigation(meetingId, { investigationId, question, status: 'completed', startedAt, answer });
      log.info({ assessment: answer.assessment, totalMs: answer.latency.totalMs, firstTokenMs: answer.latency.firstTokenMs }, 'investigation completed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'investigation failed');
      active.status = 'failed';
      await this.deps.db
        .update(investigations)
        .set({ status: 'failed', error: message, completedAt: new Date().toISOString() })
        .where(eq(investigations.id, investigationId))
        .catch(() => {});
      this.deps.hub.emit(meetingId, 'analysis.failed', { investigationId, error: message });
      await this.deps.memory.noteInvestigation(meetingId, { investigationId, question, status: 'failed', startedAt }).catch(() => {});
    }
  }
}
