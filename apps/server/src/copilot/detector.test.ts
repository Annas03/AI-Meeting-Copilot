import type { TranscriptSegment } from '@copilot/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger.js';
import { looksLikeQuestion, QuestionDetector } from './detector.js';

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('../llm/client.js', () => ({
  anthropic: () => ({ messages: { parse } }),
  effortFor: async () => ({}),
  models: { classifier: 'test-classifier' },
  withTimeout: <T>(promise: Promise<T>) => promise,
}));

describe('looksLikeQuestion', () => {
  it('accepts feature and feasibility questions', () => {
    expect(looksLikeQuestion('Can we add organization-level permissions?')).toBe(true);
    expect(looksLikeQuestion('How does the login flow handle expired tokens')).toBe(true);
    expect(looksLikeQuestion('Would it be hard to support multiple organizations per user')).toBe(true);
    expect(looksLikeQuestion('is there an endpoint for exporting reports')).toBe(true);
  });

  it('accepts unpunctuated speech-to-text questions, including plural technical terms', () => {
    expect(looksLikeQuestion('can we add organization level permissions')).toBe(true);
    expect(looksLikeQuestion('how are permissions checked')).toBe(true);
    expect(looksLikeQuestion('where do the webhooks get retried')).toBe(true);
  });

  it('rejects short lines, statements and non-technical questions without a question mark', () => {
    expect(looksLikeQuestion('ok sure')).toBe(false);
    expect(looksLikeQuestion('We decided to ship the permissions feature next sprint.')).toBe(false);
    expect(looksLikeQuestion('Did you have a nice weekend with the family')).toBe(false);
    expect(looksLikeQuestion('What?')).toBe(false);
  });

  it('lets any sufficiently long line ending in a question mark through to the classifier', () => {
    expect(looksLikeQuestion('Did you have a nice weekend with the family?')).toBe(true);
  });
});

describe('QuestionDetector', () => {
  const logger = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;
  const candidate = (text: string): TranscriptSegment => ({ segmentId: 's1', meetingId: 'm1', speakerId: 'recall-1', speakerName: 'Priya', text, final: true });
  const classification = (overrides: Record<string, unknown> = {}) => ({
    parsed_output: { is_engineering_question: true, category: 'feature_request', question: 'Can we add organization-level permissions to the app?', confidence: 0.9, ...overrides },
  });

  // Block body: a function returned from beforeEach is run as teardown, and mockReset() returns the mock.
  beforeEach(() => {
    parse.mockReset();
  });

  it('returns the classifier rewrite and omits effort when the model does not support it', async () => {
    parse.mockResolvedValue(classification());
    const result = await new QuestionDetector({ logger }).detect({ candidate: candidate('can we add organization level permissions'), recent: [] });
    expect(result).toEqual({ question: 'Can we add organization-level permissions to the app?', category: 'feature_request', confidence: 0.9 });
    expect(parse.mock.calls[0]![0].output_config).not.toHaveProperty('effort');
  });

  it('drops lines the classifier rejects', async () => {
    parse.mockResolvedValue(classification({ is_engineering_question: false, category: 'other' }));
    expect(await new QuestionDetector({ logger }).detect({ candidate: candidate('can we move the standup to ten tomorrow'), recent: [] })).toBeNull();
  });

  it('falls back to the heuristic gate, without requiring a question mark, when the classifier call fails', async () => {
    parse.mockImplementation(async () => {
      throw new Error('400 This model does not support the effort parameter.');
    });
    const result = await new QuestionDetector({ logger }).detect({ candidate: candidate('can we add organization level permissions'), recent: [] });
    expect(result).toEqual({ question: 'can we add organization level permissions', category: 'technical', confidence: 0.4 });
  });

  it('never calls the classifier for lines that fail the gate', async () => {
    expect(await new QuestionDetector({ logger }).detect({ candidate: candidate('ok sure'), recent: [] })).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });
});
