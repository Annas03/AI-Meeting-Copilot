import type { Briefing, MeetingState } from '@copilot/shared';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { briefings } from '../db/schema.js';
import type { EventHub } from '../events/hub.js';
import type { Logger } from '../logger.js';
import { anthropic, models, withTimeout } from '../llm/client.js';
import type { MeetingMemory } from './memory.js';
import { BRIEFING_SYSTEM } from './prompts.js';

export interface BriefingDeps {
  db: Database;
  hub: EventHub;
  memory: MeetingMemory;
  logger: Logger;
}

/** Deterministic briefing used when no LLM is configured or the call fails. */
export function templateBriefing(state: MeetingState): string {
  const confirmed = state.decisions.filter((d) => d.status === 'confirmed');
  const proposed = state.decisions.filter((d) => d.status === 'proposed');
  const lines = [
    `**Right now:** ${state.currentTopic || 'the discussion has just started'}`,
    state.rollingSummary ? `\n${state.rollingSummary}` : '',
    `\n**Decided:** ${confirmed.length ? confirmed.map((d) => d.text).join('; ') : 'nothing confirmed yet'}`,
    `\n**Proposed / open:** ${[...proposed.map((d) => `proposal: ${d.text}`), ...state.openQuestions.map((q) => q.text)].join('; ') || 'none'}`,
    `\n**Copilot findings:** ${
      state.investigations.length
        ? state.investigations.map((i) => `${i.question} → ${i.assessment ?? i.status}`).join('; ')
        : 'no investigations yet'
    }`,
    state.actionItems.length ? `\n**Action items:** ${state.actionItems.map((a) => `${a.text}${a.owner ? ` (${a.owner})` : ''}`).join('; ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export class BriefingService {
  private readonly cache = new Map<string, Briefing>();
  private readonly inflight = new Map<string, Promise<Briefing | null>>();

  constructor(private readonly deps: BriefingDeps) {}

  /** Returns the briefing for the current state version, generating it once per version. */
  async getOrGenerate(meetingId: string): Promise<Briefing | null> {
    const state = await this.deps.memory.getState(meetingId);
    if (state.version === 0) return null;
    const cached = this.cache.get(meetingId);
    if (cached && cached.stateVersion === state.version) return cached;
    const key = `${meetingId}:${state.version}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const task = this.generate(state).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /** Generates (or reuses) the briefing and pushes it to one participant. */
  deliverTo(meetingId: string, identity: string): void {
    void this.getOrGenerate(meetingId)
      .then((briefing) => {
        if (briefing) this.deps.hub.emitTo(meetingId, identity, 'meeting.briefing.ready', { forParticipant: identity, briefing });
      })
      .catch((err) => this.deps.logger.warn({ err, meetingId, identity }, 'briefing delivery failed'));
  }

  private async generate(state: MeetingState): Promise<Briefing> {
    const stored = await this.deps.db
      .select()
      .from(briefings)
      .where(and(eq(briefings.meetingId, state.meetingId), eq(briefings.stateVersion, state.version)))
      .limit(1);
    if (stored[0]) {
      const briefing: Briefing = { meetingId: state.meetingId, stateVersion: state.version, markdown: stored[0].markdown, generatedAt: stored[0].generatedAt };
      this.cache.set(state.meetingId, briefing);
      return briefing;
    }

    let markdown: string;
    const client = anthropic();
    if (!client) {
      markdown = templateBriefing(state);
    } else {
      try {
        const response = await withTimeout(
          client.messages.create({
            model: models.memory,
            max_tokens: 600,
            system: [{ type: 'text', text: BRIEFING_SYSTEM, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: `Meeting memory (JSON):\n${JSON.stringify(stripForBriefing(state), null, 1)}` }],
            output_config: { effort: 'low' },
          }),
          30_000,
          'briefing generation',
        );
        const text = response.content
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        markdown = response.stop_reason === 'refusal' || !text ? templateBriefing(state) : text;
      } catch (err) {
        this.deps.logger.warn({ err }, 'briefing generation failed; using template');
        markdown = templateBriefing(state);
      }
    }

    const briefing: Briefing = { meetingId: state.meetingId, stateVersion: state.version, markdown, generatedAt: new Date().toISOString() };
    await this.deps.db
      .insert(briefings)
      .values({ meetingId: briefing.meetingId, stateVersion: briefing.stateVersion, markdown, generatedAt: briefing.generatedAt })
      .onConflictDoNothing();
    this.cache.set(state.meetingId, briefing);
    return briefing;
  }
}

function stripForBriefing(state: MeetingState) {
  return {
    currentTopic: state.currentTopic,
    rollingSummary: state.rollingSummary,
    decisions: state.decisions,
    openQuestions: state.openQuestions.map((q) => q.text),
    actionItems: state.actionItems,
    investigations: state.investigations.map((i) => ({ question: i.question, status: i.status, assessment: i.assessment ?? null })),
    evidence: state.evidence,
  };
}
