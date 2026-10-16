import { createHash } from 'node:crypto';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Answer, InvestigationStatus, MeetingState, TranscriptSegment } from '@copilot/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Database } from '../db/index.js';
import { meetingStates } from '../db/schema.js';
import type { EventHub } from '../events/hub.js';
import type { Logger } from '../logger.js';
import { anthropic, models, withTimeout } from '../llm/client.js';
import { MEMORY_SYSTEM } from './prompts.js';

const StateUpdateSchema = z.object({
  currentTopic: z.string(),
  rollingSummary: z.string(),
  decisions: z.array(z.object({ text: z.string(), status: z.enum(['confirmed', 'proposed']) })),
  openQuestions: z.array(z.string()),
  actionItems: z.array(z.object({ text: z.string(), owner: z.string().nullable(), status: z.enum(['open', 'done']) })),
});

function idFor(text: string): string {
  return createHash('sha1').update(text.trim().toLowerCase()).digest('hex').slice(0, 10);
}

export function emptyState(meetingId: string): MeetingState {
  return {
    meetingId,
    version: 0,
    currentTopic: '',
    rollingSummary: '',
    decisions: [],
    openQuestions: [],
    actionItems: [],
    investigations: [],
    evidence: [],
    lastSegmentSequence: 0,
    updatedAt: new Date().toISOString(),
  };
}

export interface MemoryDeps {
  db: Database;
  hub: EventHub;
  logger: Logger;
}

/**
 * Keeps the structured meeting state. Transcript lines are folded in incrementally (batched
 * every N final segments or after a max wait), never by re-summarising the whole meeting.
 */
export class MeetingMemory {
  private readonly cache = new Map<string, MeetingState>();
  private readonly pending = new Map<string, TranscriptSegment[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<string>();
  private readonly rerun = new Set<string>();
  private readonly failures = new Map<string, number>();

  constructor(private readonly deps: MemoryDeps) {}

  async getState(meetingId: string): Promise<MeetingState> {
    const cached = this.cache.get(meetingId);
    if (cached) return cached;
    const rows = await this.deps.db.select().from(meetingStates).where(eq(meetingStates.meetingId, meetingId)).limit(1);
    const state = rows[0]?.state ?? emptyState(meetingId);
    this.cache.set(meetingId, state);
    return state;
  }

  onFinalSegment(meetingId: string, segment: TranscriptSegment): void {
    const queue = this.pending.get(meetingId) ?? [];
    queue.push(segment);
    this.pending.set(meetingId, queue);
    if (queue.length >= config.MEMORY_BATCH_SEGMENTS) {
      this.clearTimer(meetingId);
      void this.runUpdate(meetingId);
      return;
    }
    if (!this.timers.has(meetingId)) {
      this.timers.set(
        meetingId,
        setTimeout(() => {
          this.timers.delete(meetingId);
          void this.runUpdate(meetingId);
        }, config.MEMORY_MAX_WAIT_MS),
      );
    }
  }

  /** Records an investigation (and its cited evidence) in the state without an LLM call. */
  async noteInvestigation(meetingId: string, info: { investigationId: string; question: string; status: InvestigationStatus; startedAt: string; answer?: Answer }): Promise<void> {
    const state = await this.getState(meetingId);
    const investigations = state.investigations.filter((i) => i.investigationId !== info.investigationId);
    investigations.push({
      investigationId: info.investigationId,
      question: info.question,
      status: info.status,
      ...(info.answer ? { assessment: info.answer.assessment } : {}),
      startedAt: info.startedAt,
    });
    const evidence = [...state.evidence];
    for (const ref of info.answer?.evidence.filter((e) => e.cited) ?? []) {
      if (!evidence.some((e) => e.filePath === ref.filePath)) {
        evidence.push({ filePath: ref.filePath, note: `relevant to "${info.question}"` });
      }
    }
    await this.commit({ ...state, investigations: investigations.slice(-20), evidence: evidence.slice(-40) });
  }

  async flush(meetingId: string): Promise<void> {
    this.clearTimer(meetingId);
    await this.runUpdate(meetingId);
  }

  private clearTimer(meetingId: string): void {
    const timer = this.timers.get(meetingId);
    if (timer) clearTimeout(timer);
    this.timers.delete(meetingId);
  }

  private async runUpdate(meetingId: string): Promise<void> {
    if (this.running.has(meetingId)) {
      this.rerun.add(meetingId);
      return;
    }
    const segments = this.pending.get(meetingId) ?? [];
    if (segments.length === 0) return;
    this.pending.set(meetingId, []);
    this.running.add(meetingId);
    try {
      const state = await this.getState(meetingId);
      const update = await this.summarise(state, segments);
      const lastSequence = Math.max(state.lastSegmentSequence, ...segments.map((s) => s.sequence ?? 0));
      await this.commit({ ...state, ...update, lastSegmentSequence: lastSequence });
      this.failures.delete(meetingId);
    } catch (err) {
      const count = (this.failures.get(meetingId) ?? 0) + 1;
      this.failures.set(meetingId, count);
      this.deps.logger.warn({ err, meetingId, attempt: count }, 'meeting memory update failed');
      if (count <= 2) {
        // Put the lines back so the next batch includes them.
        this.pending.set(meetingId, [...segments, ...(this.pending.get(meetingId) ?? [])]);
      }
    } finally {
      this.running.delete(meetingId);
      if (this.rerun.delete(meetingId)) void this.runUpdate(meetingId);
    }
  }

  private async summarise(state: MeetingState, segments: TranscriptSegment[]): Promise<Partial<MeetingState>> {
    const client = anthropic();
    const lines = segments.map((s) => `${s.speakerName ?? s.speakerId}: ${s.text}`).join('\n');
    if (!client) {
      // Degraded mode without an LLM: keep a crude rolling summary so the UI still shows progress.
      const summary = `${state.rollingSummary} ${lines}`.trim().slice(-800);
      return { rollingSummary: summary, currentTopic: state.currentTopic || segments[segments.length - 1]?.text.slice(0, 80) || '' };
    }
    const previous = {
      currentTopic: state.currentTopic,
      rollingSummary: state.rollingSummary,
      decisions: state.decisions.map((d) => ({ text: d.text, status: d.status })),
      openQuestions: state.openQuestions.map((q) => q.text),
      actionItems: state.actionItems.map((a) => ({ text: a.text, owner: a.owner ?? null, status: a.status })),
      investigations: state.investigations.map((i) => `${i.question} -> ${i.assessment ?? i.status}`),
    };
    const response = await withTimeout(
      client.messages.parse({
        model: models.memory,
        max_tokens: 1500,
        system: [{ type: 'text', text: MEMORY_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: `Previous memory (JSON):\n${JSON.stringify(previous, null, 1)}\n\nNew transcript lines (oldest first):\n${lines}\n\nReturn the updated memory.`,
          },
        ],
        output_config: { format: zodOutputFormat(StateUpdateSchema), effort: 'low' },
      }),
      45_000,
      'meeting memory update',
    );
    const update = response.parsed_output;
    if (!update) throw new Error('memory update returned no structured output');
    return {
      currentTopic: update.currentTopic,
      rollingSummary: update.rollingSummary,
      decisions: update.decisions.map((d) => ({ id: idFor(d.text), text: d.text, status: d.status })),
      openQuestions: update.openQuestions.map((q) => ({ id: idFor(q), text: q })),
      actionItems: update.actionItems.map((a) => ({ id: idFor(a.text), text: a.text, ...(a.owner ? { owner: a.owner } : {}), status: a.status })),
    };
  }

  private async commit(next: MeetingState): Promise<void> {
    const state: MeetingState = { ...next, version: next.version + 1, updatedAt: new Date().toISOString() };
    this.cache.set(state.meetingId, state);
    await this.deps.db
      .insert(meetingStates)
      .values({ meetingId: state.meetingId, version: state.version, state, updatedAt: state.updatedAt })
      .onConflictDoUpdate({ target: meetingStates.meetingId, set: { version: state.version, state, updatedAt: state.updatedAt } });
    this.deps.hub.emit(state.meetingId, 'meeting.state.updated', { state });
  }
}
