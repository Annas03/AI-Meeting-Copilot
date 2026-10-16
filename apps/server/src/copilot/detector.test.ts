import { describe, expect, it } from 'vitest';
import { looksLikeQuestion } from './detector.js';

describe('looksLikeQuestion', () => {
  it('accepts feature and feasibility questions', () => {
    expect(looksLikeQuestion('Can we add organization-level permissions?')).toBe(true);
    expect(looksLikeQuestion('How does the login flow handle expired tokens')).toBe(true);
    expect(looksLikeQuestion('Would it be hard to support multiple organizations per user')).toBe(true);
    expect(looksLikeQuestion('is there an endpoint for exporting reports')).toBe(true);
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
