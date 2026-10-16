import Anthropic from '@anthropic-ai/sdk';
import type { SearchHit } from '@copilot/knowledge';
import type { Answer, Assessment, EvidenceRef, MeetingState, TranscriptSegment } from '@copilot/shared';
import { config } from '../config.js';
import type { Logger } from '../logger.js';
import { models, requireAnthropic } from '../llm/client.js';
import { ANSWER_SYSTEM } from './prompts.js';

export interface AnswerContext {
  meetingTitle: string;
  projectId: string;
  repository?: string;
  state?: MeetingState;
  recentTranscript: TranscriptSegment[];
}

export interface StreamAnswerInput {
  investigationId: string;
  meetingId: string;
  question: string;
  hits: SearchHit[];
  context: AnswerContext;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
  logger: Logger;
  /** Latency already spent before this call (detection + retrieval), merged into the answer. */
  latency: { detectionMs?: number; retrievalMs?: number };
}

const MAX_CHUNK_CHARS = 2500;
let fallbacksSupported = config.ANSWER_FALLBACKS === 'on';

export function buildEvidence(hits: SearchHit[]): EvidenceRef[] {
  return hits.map((hit, i) => ({
    ref: `E${i + 1}`,
    repository: hit.repository,
    filePath: hit.filePath,
    startLine: hit.startLine,
    endLine: hit.endLine,
    contentType: hit.contentType,
    ...(hit.language ? { language: hit.language } : {}),
    ...(hit.symbol ? { symbol: hit.symbol } : {}),
    score: hit.score,
    cited: false,
    excerpt: hit.text.length > 600 ? `${hit.text.slice(0, 600)}\n…` : hit.text,
  }));
}

export function buildUserPrompt(question: string, hits: SearchHit[], context: AnswerContext, insufficient: boolean): string {
  const state = context.state;
  const transcript = context.recentTranscript
    .slice(-6)
    .map((s) => `${s.speakerName ?? s.speakerId}: ${s.text}`)
    .join('\n');
  const evidence = hits
    .map((hit, i) => {
      const text = hit.text.length > MAX_CHUNK_CHARS ? `${hit.text.slice(0, MAX_CHUNK_CHARS)}\n… (truncated)` : hit.text;
      return `[E${i + 1}] ${hit.filePath}:${hit.startLine}-${hit.endLine}${hit.symbol ? ` (${hit.symbol})` : ''} [${hit.contentType}, score ${hit.score.toFixed(2)}]\n\`\`\`${hit.language ?? ''}\n${text}\n\`\`\``;
    })
    .join('\n\n');

  const parts = [
    `Project: ${context.projectId}${context.repository ? ` (repository ${context.repository})` : ''}`,
    `Meeting: ${context.meetingTitle}`,
    state?.currentTopic ? `Current topic: ${state.currentTopic}` : null,
    state?.rollingSummary ? `Discussion so far: ${state.rollingSummary}` : null,
    transcript ? `Recent transcript:\n${transcript}` : null,
    `Question: ${question}`,
    insufficient
      ? `Evidence: retrieval found ${hits.length === 0 ? 'nothing relevant' : 'only weakly related chunks'} in the index. Say that the evidence is insufficient, give a preliminary assessment, and list what must be verified.`
      : `Evidence (${hits.length} chunks):\n\n${evidence}`,
    insufficient && hits.length > 0 ? `Weak evidence for reference:\n\n${evidence}` : null,
  ].filter(Boolean);
  return parts.join('\n\n');
}

export function parseAssessment(markdown: string): Assessment {
  const match = /\*\*Assessment:\*\*\s*([^\n]+)/i.exec(markdown);
  const label = (match?.[1] ?? '').toLowerCase();
  if (label.includes('likely feasible')) return 'likely_feasible';
  if (label.includes('unsupported')) return 'unsupported';
  if (label.includes('not a codebase') || label.includes('not applicable')) return 'not_applicable';
  return 'uncertain';
}

export function citedRefs(markdown: string): Set<string> {
  const refs = new Set<string>();
  for (const match of markdown.matchAll(/\[E(\d+)\]/g)) refs.add(`E${match[1]}`);
  return refs;
}

interface StreamResult {
  text: string;
  model: string;
  stopReason: string | null;
  firstTokenMs?: number;
}

async function runStream(input: StreamAnswerInput, userPrompt: string, useFallbacks: boolean): Promise<StreamResult> {
  const client = requireAnthropic();
  const started = Date.now();
  let firstTokenMs: number | undefined;
  let text = '';
  const onText = (delta: string) => {
    if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
    text += delta;
    input.onDelta(delta);
  };
  const base = {
    model: models.answer,
    max_tokens: 2048,
    system: [{ type: 'text' as const, text: ANSWER_SYSTEM, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user' as const, content: userPrompt }],
    output_config: { effort: config.ANSWER_EFFORT },
  };
  const requestOptions = input.signal ? { signal: input.signal } : {};

  if (useFallbacks) {
    const stream = client.beta.messages.stream(
      { ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as Parameters<typeof client.beta.messages.stream>[0],
      requestOptions,
    );
    stream.on('text', onText);
    const final = await stream.finalMessage();
    return { text, model: final.model, stopReason: final.stop_reason, firstTokenMs };
  }
  const stream = client.messages.stream(base, requestOptions);
  stream.on('text', onText);
  const final = await stream.finalMessage();
  return { text, model: final.model, stopReason: final.stop_reason, firstTokenMs };
}

/** Streams an evidence-backed answer and returns the structured result when the model finishes. */
export async function streamAnswer(input: StreamAnswerInput): Promise<Answer> {
  const started = Date.now();
  const strongHits = input.hits.filter((h) => h.score >= config.RETRIEVAL_MIN_SCORE);
  const insufficient = strongHits.length === 0;
  const userPrompt = buildUserPrompt(input.question, input.hits, input.context, insufficient);

  let result: StreamResult;
  try {
    result = await runStream(input, userPrompt, fallbacksSupported);
  } catch (err) {
    if (fallbacksSupported && err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(err.message)) {
      input.logger.warn({ err: err.message }, 'server-side fallbacks rejected by the API; retrying without them');
      fallbacksSupported = false;
      result = await runStream(input, userPrompt, false);
    } else {
      throw err;
    }
  }

  let markdown = result.text.trim();
  if (result.stopReason === 'refusal') {
    markdown = `**Assessment:** Uncertain\n**Summary:** The model declined to answer this question. Please rephrase or ask a developer to look directly.`;
    input.onDelta(markdown);
  } else if (result.stopReason === 'max_tokens') {
    markdown += '\n\n_(answer truncated)_';
  }

  const cited = citedRefs(markdown);
  const evidence = buildEvidence(input.hits).map((e) => ({ ...e, cited: cited.has(e.ref) }));
  const totalMs = Date.now() - started;
  return {
    investigationId: input.investigationId,
    meetingId: input.meetingId,
    question: input.question,
    assessment: parseAssessment(markdown),
    markdown,
    evidence,
    insufficientEvidence: insufficient,
    model: result.model,
    latency: {
      ...input.latency,
      ...(result.firstTokenMs !== undefined ? { firstTokenMs: result.firstTokenMs } : {}),
      totalMs: (input.latency.detectionMs ?? 0) + (input.latency.retrievalMs ?? 0) + totalMs,
    },
    createdAt: new Date().toISOString(),
  };
}
