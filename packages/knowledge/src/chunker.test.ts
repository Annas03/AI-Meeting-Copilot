import { describe, expect, it } from 'vitest';
import { chunkFile, detectContentType, detectLanguage, embeddingTextFor } from './chunker.js';

const TS_SAMPLE = `import { x } from './x.js';

/**
 * Adds two numbers.
 */
export function add(a: number, b: number): number {
  return a + b;
}

@Injectable()
export class Calculator {
  multiply(a: number, b: number) {
    return a * b;
  }
}

export interface Shape {
  area(): number;
}

const helper = () => 42;
`;

describe('detectLanguage / detectContentType', () => {
  it('maps extensions and special files', () => {
    expect(detectLanguage('src/auth/authorization.ts')).toBe('typescript');
    expect(detectLanguage('docs/adr/0001.md')).toBe('markdown');
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(detectContentType('src/auth/authorization.ts')).toBe('source_code');
    expect(detectContentType('README.md')).toBe('documentation');
    expect(detectContentType('prisma/schema.prisma')).toBe('schema');
    expect(detectContentType('db/migrations/001_init.sql')).toBe('schema');
    expect(detectContentType('package.json')).toBe('config');
    expect(detectContentType('.env.example')).toBe('config');
  });
});

describe('chunkFile for TypeScript', () => {
  it('splits at top-level declarations and keeps doc comments and decorators attached', () => {
    const chunks = chunkFile('src/calc.ts', TS_SAMPLE, { minLines: 1, maxLines: 120 });
    const symbols = chunks.map((c) => c.symbol);
    expect(symbols).toContain('add');
    expect(symbols).toContain('Calculator');
    expect(symbols).toContain('Shape');
    const addChunk = chunks.find((c) => c.symbol === 'add')!;
    expect(addChunk.text.startsWith('/**')).toBe(true);
    const calcChunk = chunks.find((c) => c.symbol === 'Calculator')!;
    expect(calcChunk.text.startsWith('@Injectable()')).toBe(true);
    expect(calcChunk.startLine).toBe(10);
    expect(calcChunk.endLine).toBe(15);
  });

  it('covers every non-blank line exactly once when nothing is windowed', () => {
    const chunks = chunkFile('src/calc.ts', TS_SAMPLE, { minLines: 1 });
    const lines = TS_SAMPLE.split('\n');
    const covered = new Set<number>();
    for (const chunk of chunks) {
      for (let l = chunk.startLine; l <= chunk.endLine; l++) {
        expect(covered.has(l)).toBe(false);
        covered.add(l);
      }
    }
    lines.forEach((line, idx) => {
      if (line.trim() !== '') expect(covered.has(idx + 1)).toBe(true);
    });
  });

  it('merges small neighbouring segments under the default options', () => {
    const chunks = chunkFile('src/calc.ts', TS_SAMPLE);
    expect(chunks.length).toBeLessThan(5);
    expect(chunks.every((c) => c.contentType === 'source_code' && c.language === 'typescript')).toBe(true);
  });

  it('windows oversized segments with overlap and valid line ranges', () => {
    const body = Array.from({ length: 400 }, (_, i) => `  console.log(${i});`).join('\n');
    const big = `export function huge() {\n${body}\n}\n`;
    const chunks = chunkFile('src/huge.ts', big, { maxLines: 100, overlapLines: 10 });
    expect(chunks.length).toBeGreaterThan(3);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const cur = chunks[i]!;
      expect(cur.startLine).toBeLessThanOrEqual(prev.endLine);
      expect(cur.startLine).toBeGreaterThan(prev.startLine);
    }
    expect(chunks[chunks.length - 1]!.endLine).toBe(402);
    for (const chunk of chunks) {
      expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(100);
    }
  });
});

describe('chunkFile for markdown', () => {
  it('splits at headings and records the heading path as the symbol', () => {
    const md = `# Architecture\n\nIntro.\n\n## Auth\n\nToken cookie.\n\n### Refresh\n\nDetails.\n\n\`\`\`md\n# not a heading\n\`\`\`\n\n## Data layer\n\nAxios.\n`;
    const chunks = chunkFile('docs/arch.md', md, { minLines: 1 });
    const symbols = chunks.map((c) => c.symbol);
    expect(symbols).toEqual(['Architecture', 'Architecture > Auth', 'Architecture > Auth > Refresh', 'Architecture > Data layer']);
    expect(chunks.every((c) => c.contentType === 'documentation')).toBe(true);
  });
});

describe('chunkFile for schemas and config', () => {
  it('splits SQL at statements', () => {
    const sql = `CREATE TABLE users (\n  id serial primary key\n);\n\nCREATE TABLE orgs (\n  id serial primary key\n);\n\nCREATE INDEX idx_users ON users(id);\n`;
    const chunks = chunkFile('db/schema.sql', sql, { minLines: 1 });
    expect(chunks.map((c) => c.symbol)).toEqual(['users', 'orgs', 'idx_users']);
  });

  it('falls back to windows for JSON and returns nothing for empty input', () => {
    const json = JSON.stringify({ a: Array.from({ length: 300 }, (_, i) => i) }, null, 2);
    const chunks = chunkFile('config/app.json', json, { maxLines: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.contentType).toBe('config');
    expect(chunkFile('empty.ts', '   \n\n')).toEqual([]);
  });
});

describe('embeddingTextFor', () => {
  it('prefixes repository, file and symbol context', () => {
    const [chunk] = chunkFile('src/a.ts', 'export const a = 1;\n');
    const text = embeddingTextFor(chunk!, 'company/app');
    expect(text.startsWith('repository: company/app\nfile: src/a.ts\nsymbol: a\n\n')).toBe(true);
  });
});
