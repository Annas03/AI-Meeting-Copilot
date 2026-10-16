/**
 * Finds the files of a repository that are worth indexing.
 *
 * Inside a git checkout the file list comes from `git ls-files` (tracked plus untracked files
 * that are not ignored), so .gitignore semantics are respected exactly. Outside git a glob walk
 * is used. Build output, dependencies, binaries, lockfiles, media and secret-looking files are
 * excluded, then an extension allowlist keeps only text we know how to chunk.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import ignore from 'ignore';
import { simpleGit } from 'simple-git';

export interface DiscoveredFile {
  absPath: string;
  /** Path relative to the repository root with forward slashes. */
  relPath: string;
  bytes: number;
}

export interface SkippedFile {
  relPath: string;
  reason: string;
}

export interface DiscoverOptions {
  repoPath: string;
  /** Additional gitignore-style patterns to exclude. */
  exclude?: string[];
  /** Additional file extensions (without dot) to include. */
  includeExtensions?: string[];
  /** Files larger than this are skipped. */
  maxFileBytes?: number;
}

export interface DiscoverResult {
  files: DiscoveredFile[];
  skipped: SkippedFile[];
  revision: string;
  isGit: boolean;
}

export const DEFAULT_EXCLUDES = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  'coverage/',
  'vendor/',
  'target/',
  'bin/',
  'obj/',
  '__pycache__/',
  '.venv/',
  'venv/',
  'storybook-static/',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.bundle.js',
  '*.chunk.js',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'composer.lock',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  '*.tsbuildinfo',
  '*.d.ts.map',
  // secrets
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  'id_rsa*',
  'id_ed25519*',
  '*.kdbx',
  'secrets.*',
  // media and binaries
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg', '*.ico', '*.bmp', '*.tiff', '*.psd',
  '*.mp3', '*.mp4', '*.wav', '*.mov', '*.avi', '*.webm', '*.ogg',
  '*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot',
  '*.zip', '*.gz', '*.tar', '*.rar', '*.7z', '*.jar', '*.war', '*.exe', '*.dll', '*.so', '*.dylib', '*.wasm', '*.bin',
  '*.pdf', '*.doc', '*.docx', '*.xls', '*.xlsx', '*.ppt', '*.pptx', '*.lottie',
  '*.sqlite', '*.db',
  '*.snap',
];

export const DEFAULT_EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'go', 'rs', 'java', 'kt', 'cs', 'rb', 'php', 'swift', 'scala', 'c', 'h', 'cpp', 'hpp', 'cc',
  'md', 'mdx', 'markdown', 'txt', 'rst', 'adoc',
  'sql', 'prisma', 'graphql', 'gql', 'proto',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'tf',
  'sh', 'bash', 'ps1',
  'css', 'scss', 'less', 'html',
];

const SPECIAL_BASENAMES = new Set(['dockerfile', 'makefile', '.env.example', '.env.sample', 'readme', 'license', 'claude.md', 'context.md']);

const DEFAULT_MAX_BYTES = 256 * 1024;

export async function discoverFiles(options: DiscoverOptions): Promise<DiscoverResult> {
  const repoPath = path.resolve(options.repoPath);
  const stat = await fs.stat(repoPath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Repository path is not a directory: ${repoPath}`);

  const extensions = new Set([...DEFAULT_EXTENSIONS, ...(options.includeExtensions ?? [])].map((e) => e.toLowerCase()));
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_BYTES;
  const matcher = ignore().add(DEFAULT_EXCLUDES).add(options.exclude ?? []);

  const git = simpleGit({ baseDir: repoPath });
  let isGit = false;
  try {
    isGit = await git.checkIsRepo();
  } catch {
    isGit = false;
  }

  let candidates: string[];
  let revision = 'working-tree';
  if (isGit) {
    // Tracked files plus untracked files that are not ignored, so .gitignore semantics are exact.
    candidates = await listGitFiles(git);
    try {
      revision = (await git.revparse(['HEAD'])).trim();
    } catch {
      revision = 'no-commits';
    }
  } else {
    // Not a git checkout: walk the tree but still honour a root .gitignore if there is one.
    const rootIgnore = await fs.readFile(path.join(repoPath, '.gitignore'), 'utf8').catch(() => '');
    if (rootIgnore) matcher.add(rootIgnore);
    candidates = await fg('**/*', { cwd: repoPath, onlyFiles: true, dot: true, followSymbolicLinks: false, ignore: ['**/node_modules/**', '**/.git/**'] });
  }

  const files: DiscoveredFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const rel of candidates) {
    const relPath = rel.replace(/\\/g, '/');
    if (matcher.ignores(relPath)) {
      skipped.push({ relPath, reason: 'excluded by pattern' });
      continue;
    }
    const base = path.posix.basename(relPath).toLowerCase();
    const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
    if (!extensions.has(ext) && !SPECIAL_BASENAMES.has(base)) {
      skipped.push({ relPath, reason: 'extension not indexed' });
      continue;
    }
    const absPath = path.join(repoPath, relPath);
    const fileStat = await fs.stat(absPath).catch(() => null);
    if (!fileStat?.isFile()) {
      skipped.push({ relPath, reason: 'missing or not a regular file' });
      continue;
    }
    if (fileStat.size > maxBytes) {
      skipped.push({ relPath, reason: `larger than ${maxBytes} bytes` });
      continue;
    }
    if (fileStat.size === 0) {
      skipped.push({ relPath, reason: 'empty' });
      continue;
    }
    files.push({ absPath, relPath, bytes: fileStat.size });
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { files, skipped, revision, isGit };
}

async function listGitFiles(git: ReturnType<typeof simpleGit>): Promise<string[]> {
  try {
    const raw = await git.raw(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    return raw.split('\0').filter((p) => p.length > 0);
  } catch {
    // Fallback for environments where the -z flag is rejected: newline separated output.
    const raw = await git.raw(['ls-files', '--cached', '--others', '--exclude-standard']);
    return raw.split(/\r?\n/).filter((p) => p.length > 0);
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-|live_|test_)?[A-Za-z0-9]{24,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /(?:api|secret|access)[_-]?(?:key|token)\s*[:=]\s*["'][A-Za-z0-9_\-/+]{24,}["']/i,
];

/** Returns true when the content contains something that looks like a real credential. */
export function looksLikeSecret(content: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(content));
}

/** Cheap binary sniff: a NUL byte in the first 8 KB means we should not treat the file as text. */
export function looksBinary(buffer: Uint8Array): boolean {
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
