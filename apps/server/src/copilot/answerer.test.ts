import { describe, expect, it } from 'vitest';
import { buildEvidence, buildUserPrompt, citedRefs, parseAssessment } from './answerer.js';

const hit = {
  chunkId: '1',
  repository: 'acme/app',
  filePath: 'src/auth/authorization.ts',
  startLine: 10,
  endLine: 40,
  contentType: 'source_code' as const,
  language: 'typescript',
  symbol: 'canAccessOrganization',
  text: 'export function canAccessOrganization() {}',
  score: 0.61,
  revision: 'abc',
};

describe('parseAssessment', () => {
  it('maps the assessment line to the enum', () => {
    expect(parseAssessment('**Assessment:** Likely feasible\n**Summary:** x')).toBe('likely_feasible');
    expect(parseAssessment('**Assessment:** Unsupported by current evidence')).toBe('unsupported');
    expect(parseAssessment('**Assessment:** Not a codebase question')).toBe('not_applicable');
    expect(parseAssessment('**Assessment:** Uncertain')).toBe('uncertain');
    expect(parseAssessment('no header at all')).toBe('uncertain');
  });
});

describe('citedRefs / buildEvidence', () => {
  it('collects citation labels and marks evidence as cited', () => {
    const refs = citedRefs('See [E1] and [E3]; [E1] again.');
    expect([...refs]).toEqual(['E1', 'E3']);
    const evidence = buildEvidence([hit, { ...hit, chunkId: '2' }]).map((e) => ({ ...e, cited: refs.has(e.ref) }));
    expect(evidence.map((e) => e.ref)).toEqual(['E1', 'E2']);
    expect(evidence[0]!.cited).toBe(true);
    expect(evidence[1]!.cited).toBe(false);
    expect(evidence[0]!.symbol).toBe('canAccessOrganization');
  });
});

describe('buildUserPrompt', () => {
  const context = { meetingTitle: 'Sync', projectId: 'default', repository: 'acme/app', recentTranscript: [] };

  it('includes numbered evidence blocks with file references', () => {
    const prompt = buildUserPrompt('Can we add org permissions?', [hit], context, false);
    expect(prompt).toContain('[E1] src/auth/authorization.ts:10-40 (canAccessOrganization)');
    expect(prompt).toContain('Question: Can we add org permissions?');
    expect(prompt).toContain('```typescript');
  });

  it('tells the model when evidence is insufficient', () => {
    const prompt = buildUserPrompt('Can we add org permissions?', [], context, true);
    expect(prompt).toContain('retrieval found nothing relevant');
  });
});
