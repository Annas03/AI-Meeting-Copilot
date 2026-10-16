import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { TranscriptSegment } from '@copilot/shared';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import { anthropic, models, withTimeout } from '../llm/client.js';
import { CLASSIFIER_SYSTEM } from './prompts.js';

const INTERROGATIVE =
  /^(can|could|would|should|will|is|are|do|does|did|how|what|why|where|which|when|who|have|has|any|anyone|might|may|shall|isn't|aren't|doesn't|don't|wouldn't|couldn't|shouldn't)\b/i;

const TECH_HINTS =
  /\b(api|endpoint|schema|database|db|table|migration|auth|permission|role|token|feature|support|integrat\w*|implement\w*|build|add|change|refactor|deploy|config\w*|module|component|service|frontend|backend|query|cache|socket|websocket|webhook|latency|performance|scale|test|bug|error|crash|timeout|version|upgrade|library|package|sdk|repo|code|codebase|function|class|workflow|template|report|dashboard|notification|login|signup|organi[sz]ation|org|user|tenant|multi|i18n|locale|translation|payment|billing|email|sms|push|mobile|ios|android|web|server|client|react|node|typescript|redux|store|state|form|validation|upload|file|image|pdf|export|import|search|filter|sort|pagination|audit|log|logging|metric|monitor|cron|job|queue|event|stream)\b/i;

/** Cheap gate so the classifier is only called for lines that could plausibly be engineering questions. */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  const endsWithQuestionMark = /\?\s*$/.test(trimmed);
  const startsInterrogative = INTERROGATIVE.test(trimmed);
  if (!endsWithQuestionMark && !startsInterrogative) return false;
  if (endsWithQuestionMark) return true;
  return TECH_HINTS.test(trimmed);
}

export const ClassificationSchema = z.object({
  is_engineering_question: z.boolean(),
  category: z.enum(['feature_request', 'feasibility', 'technical', 'other']),
  question: z.string().describe('The question rewritten as a standalone sentence; empty when not a question'),
  confidence: z.number().min(0).max(1),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export interface ClassifyInput {
  candidate: TranscriptSegment;
  recent: TranscriptSegment[];
}

export interface DetectorOptions {
  logger: Logger;
  minConfidence?: number;
  timeoutMs?: number;
}

export class QuestionDetector {
  private readonly minConfidence: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: DetectorOptions) {
    this.minConfidence = options.minConfidence ?? 0.6;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  /**
   * Returns the standalone question to investigate, or null. Runs the heuristic gate first and
   * the fast-model classifier second; without an Anthropic key only the heuristics apply.
   */
  async detect(input: ClassifyInput): Promise<{ question: string; category: Classification['category']; confidence: number } | null> {
    if (!looksLikeQuestion(input.candidate.text)) return null;
    const client = anthropic();
    if (!client) {
      // Degraded mode: trust the heuristics so the pipeline still works without a key for the classifier.
      return { question: input.candidate.text.trim(), category: 'technical', confidence: 0.5 };
    }
    try {
      const recent = input.recent
        .filter((s) => s.segmentId !== input.candidate.segmentId)
        .slice(-8)
        .map((s) => `${s.speakerName ?? s.speakerId}: ${s.text}`)
        .join('\n');
      const user = `Recent transcript (oldest first):\n${recent || '(none)'}\n\nCandidate line (${input.candidate.speakerName ?? input.candidate.speakerId}): "${input.candidate.text.trim()}"`;
      const response = await withTimeout(
        client.messages.parse({
          model: models.classifier,
          max_tokens: 400,
          system: [{ type: 'text', text: CLASSIFIER_SYSTEM, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: user }],
          output_config: { format: zodOutputFormat(ClassificationSchema), effort: 'low' },
        }),
        this.timeoutMs,
        'question classification',
      );
      const parsed = response.parsed_output;
      if (!parsed) return null;
      if (!parsed.is_engineering_question || parsed.category === 'other' || parsed.confidence < this.minConfidence) return null;
      const question = parsed.question.trim() || input.candidate.text.trim();
      return { question, category: parsed.category, confidence: parsed.confidence };
    } catch (err) {
      this.options.logger.warn({ err }, 'question classification failed; falling back to heuristics');
      return /\?\s*$/.test(input.candidate.text) ? { question: input.candidate.text.trim(), category: 'technical', confidence: 0.4 } : null;
    }
  }
}
