import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverFiles, looksBinary, looksLikeSecret } from './discover.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'copilot-discover-'));
  await mkdir(path.join(dir, 'src', 'auth'), { recursive: true });
  await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(dir, 'dist'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'auth', 'authorization.ts'), 'export const a = 1;\n');
  await writeFile(path.join(dir, 'src', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(dir, 'README.md'), '# Hi\n');
  await writeFile(path.join(dir, '.env'), 'SECRET=1\n');
  await writeFile(path.join(dir, '.env.example'), 'SECRET=\n');
  await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  await writeFile(path.join(dir, 'dist', 'bundle.js'), 'x\n');
  await writeFile(path.join(dir, 'package-lock.json'), '{}\n');
  await writeFile(path.join(dir, 'empty.ts'), '');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('discoverFiles outside git', () => {
  it('keeps indexable text files and excludes dependencies, builds, secrets, media and lockfiles', async () => {
    const result = await discoverFiles({ repoPath: dir });
    const rels = result.files.map((f) => f.relPath);
    expect(result.isGit).toBe(false);
    expect(result.revision).toBe('working-tree');
    expect(rels).toEqual(['.env.example', 'README.md', 'src/auth/authorization.ts']);
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.relPath, s.reason]));
    expect(reasons['.env']).toBe('excluded by pattern');
    expect(reasons['src/logo.png']).toBe('excluded by pattern');
    expect(reasons['dist/bundle.js']).toBe('excluded by pattern');
    expect(reasons['package-lock.json']).toBe('excluded by pattern');
    expect(reasons['empty.ts']).toBe('empty');
    expect(rels.some((r) => r.startsWith('node_modules'))).toBe(false);
  });

  it('honours extra excludes and size limits', async () => {
    const result = await discoverFiles({ repoPath: dir, exclude: ['README.md'], maxFileBytes: 10 });
    const rels = result.files.map((f) => f.relPath);
    expect(rels).toEqual(['.env.example']);
    expect(result.skipped.find((s) => s.relPath === 'src/auth/authorization.ts')?.reason).toMatch(/larger than/);
  });

  it('honours a root .gitignore even when the folder is not a git checkout', async () => {
    await mkdir(path.join(dir, 'generated'), { recursive: true });
    await writeFile(path.join(dir, 'generated', 'big.ts'), 'export const g = 1;\n');
    await writeFile(path.join(dir, '.gitignore'), 'generated/\n');
    const result = await discoverFiles({ repoPath: dir });
    expect(result.files.map((f) => f.relPath)).not.toContain('generated/big.ts');
    expect(result.skipped.find((s) => s.relPath === 'generated/big.ts')?.reason).toBe('excluded by pattern');
  });

  it('rejects a path that is not a directory', async () => {
    await expect(discoverFiles({ repoPath: path.join(dir, 'README.md') })).rejects.toThrow(/not a directory/);
  });
});

describe('secret and binary sniffing', () => {
  it('flags private keys and provider tokens', () => {
    expect(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----\nabc')).toBe(true);
    expect(looksLikeSecret('const key = "AKIAABCDEFGHIJKLMNOP";')).toBe(true);
    expect(looksLikeSecret('ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(looksLikeSecret('export const apiUrl = process.env.NEXT_PUBLIC_API_URL;')).toBe(false);
  });

  it('detects NUL bytes as binary', () => {
    expect(looksBinary(new Uint8Array([0x41, 0x00, 0x42]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode('plain text'))).toBe(false);
  });
});
