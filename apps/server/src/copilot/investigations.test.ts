import { describe, expect, it } from 'vitest';
import { jaccard, questionTokens } from './investigations.js';

describe('question deduplication', () => {
  it('treats rephrasings of the same question as similar', () => {
    const a = questionTokens('Can we add organization level permissions to the app?');
    const b = questionTokens('Could we add organization-level permissions?');
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(0.75);
  });

  it('keeps different questions apart', () => {
    const a = questionTokens('Can we add organization level permissions?');
    const b = questionTokens('How does the billing webhook retry failed payments?');
    expect(jaccard(a, b)).toBeLessThan(0.3);
  });
});
