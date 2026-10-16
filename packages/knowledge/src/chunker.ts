/**
 * Splits a file into retrieval chunks.
 *
 * Code is split at top-level declarations (functions, classes, types, ...), documents at
 * headings, schemas at statements, and everything else into fixed line windows. Small
 * neighbouring segments are merged and oversized segments are windowed with overlap, so
 * every chunk stays within an embedding-friendly size while keeping whole symbols together
 * whenever possible. No native dependencies: boundaries are found with line-anchored regexes.
 */

export type ContentType = 'source_code' | 'documentation' | 'schema' | 'config' | 'other';

export interface Chunk {
  filePath: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  text: string;
  contentType: ContentType;
  language: string;
  /** Declaration name(s) or heading path the chunk covers, when known. */
  symbol?: string;
}

export interface ChunkOptions {
  /** Upper bound on lines per chunk before windowing kicks in. */
  maxLines?: number;
  /** Upper bound on characters per chunk before windowing kicks in. */
  maxChars?: number;
  /** Lines repeated between consecutive windows of an oversized segment. */
  overlapLines?: number;
  /** Segments shorter than this are merged with their neighbours. */
  minLines?: number;
}

const DEFAULTS: Required<ChunkOptions> = {
  maxLines: 120,
  maxChars: 4000,
  overlapLines: 8,
  minLines: 24,
};

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', cs: 'csharp',
  rb: 'ruby', php: 'php', swift: 'swift', scala: 'scala',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown', txt: 'text', rst: 'text', adoc: 'text',
  sql: 'sql', prisma: 'prisma', graphql: 'graphql', gql: 'graphql',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', env: 'dotenv',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
  css: 'css', scss: 'scss', less: 'less', html: 'html', vue: 'vue', svelte: 'svelte', xml: 'xml',
  tf: 'terraform', proto: 'protobuf',
};

const SPECIAL_FILES: Record<string, { language: string; contentType: ContentType }> = {
  dockerfile: { language: 'dockerfile', contentType: 'config' },
  makefile: { language: 'makefile', contentType: 'config' },
  '.env.example': { language: 'dotenv', contentType: 'config' },
  '.env.sample': { language: 'dotenv', contentType: 'config' },
  'claude.md': { language: 'markdown', contentType: 'documentation' },
  'readme': { language: 'markdown', contentType: 'documentation' },
};

const CODE_LANGUAGES = new Set([
  'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'ruby', 'php',
  'swift', 'scala', 'c', 'cpp', 'shell', 'powershell', 'vue', 'svelte', 'css', 'scss', 'less', 'html',
]);
const DOC_LANGUAGES = new Set(['markdown', 'text']);
const SCHEMA_LANGUAGES = new Set(['sql', 'prisma', 'graphql', 'protobuf']);
const CONFIG_LANGUAGES = new Set(['json', 'yaml', 'toml', 'ini', 'dotenv', 'xml', 'terraform', 'dockerfile', 'makefile']);

export function detectLanguage(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  const special = SPECIAL_FILES[name];
  if (special) return special.language;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return EXT_LANGUAGE[ext] ?? 'text';
}

export function detectContentType(filePath: string, language = detectLanguage(filePath)): ContentType {
  const name = basename(filePath).toLowerCase();
  const special = SPECIAL_FILES[name];
  if (special) return special.contentType;
  const lower = filePath.toLowerCase();
  if (/\/(migrations?|schema|db\/schema)\//.test(lower) || /schema\.(ts|js|json)$/.test(lower)) {
    return 'schema';
  }
  if (SCHEMA_LANGUAGES.has(language)) return 'schema';
  if (DOC_LANGUAGES.has(language)) return 'documentation';
  if (CONFIG_LANGUAGES.has(language)) return 'config';
  if (CODE_LANGUAGES.has(language)) return 'source_code';
  return 'other';
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

// ---------------------------------------------------------------------------
// Boundary detection
// ---------------------------------------------------------------------------

const TS_JS_BOUNDARY =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace|module|const|let|var)\b/;

const CODE_BOUNDARIES: Record<string, { pattern: RegExp; allowIndent: number }> = {
  typescript: { pattern: TS_JS_BOUNDARY, allowIndent: 0 },
  javascript: { pattern: TS_JS_BOUNDARY, allowIndent: 0 },
  vue: { pattern: TS_JS_BOUNDARY, allowIndent: 0 },
  svelte: { pattern: TS_JS_BOUNDARY, allowIndent: 0 },
  python: { pattern: /^(?:async\s+)?(?:def|class)\b/, allowIndent: 0 },
  go: { pattern: /^(?:func|type|var|const)\b/, allowIndent: 0 },
  rust: { pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|impl|trait|mod|type|const|static)\b/, allowIndent: 0 },
  java: { pattern: /^(?:(?:public|private|protected|static|abstract|final|synchronized|class|interface|enum|record)\b|@)/, allowIndent: 4 },
  kotlin: { pattern: /^(?:(?:public|private|protected|internal|open|abstract|data|sealed|fun|class|object|interface|val|var)\b|@)/, allowIndent: 4 },
  csharp: { pattern: /^(?:(?:public|private|protected|internal|static|abstract|sealed|class|interface|enum|record|struct|namespace)\b|\[)/, allowIndent: 4 },
  ruby: { pattern: /^(?:def|class|module)\b/, allowIndent: 2 },
  php: { pattern: /^(?:(?:abstract\s+|final\s+)?class|interface|trait|function|namespace|enum)\b/, allowIndent: 0 },
  swift: { pattern: /^(?:public\s+|private\s+|internal\s+|open\s+)?(?:final\s+)?(?:func|class|struct|enum|protocol|extension)\b/, allowIndent: 0 },
  scala: { pattern: /^(?:object|class|trait|case class|def|val)\b/, allowIndent: 0 },
  c: { pattern: /^(?:[A-Za-z_][\w\s\*]*\(|struct|typedef|enum|#define)/, allowIndent: 0 },
  cpp: { pattern: /^(?:[A-Za-z_][\w\s\*:<>,]*\(|class|struct|typedef|enum|namespace|template|#define)/, allowIndent: 0 },
  shell: { pattern: /^(?:function\s+\w+|\w+\s*\(\)\s*\{)/, allowIndent: 0 },
  powershell: { pattern: /^(?:function|filter|class|enum)\b/i, allowIndent: 0 },
  css: { pattern: /^[^\s{][^{]*\{\s*$/, allowIndent: 0 },
  scss: { pattern: /^[^\s{][^{]*\{\s*$/, allowIndent: 0 },
  less: { pattern: /^[^\s{][^{]*\{\s*$/, allowIndent: 0 },
  html: { pattern: /^<(?:section|article|header|footer|main|nav|form|table|template|script|style)\b/i, allowIndent: 2 },
};

const SCHEMA_BOUNDARY = /^(?:create|alter|drop|insert|model|enum|type|datasource|generator|input|interface|extend|schema|query|mutation|subscription|message|service)\b/i;

const SYMBOL_PATTERN =
  /(?:function\*?|class|interface|type|enum|namespace|module|const|let|var|def|func|fn|struct|trait|impl|mod|record|object|protocol|extension|message|service|model|datasource|generator|input)\s+([A-Za-z_$][\w$.]*)/i;

const SQL_SYMBOL_PATTERN =
  /^\s*(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:temp(?:orary)?\s+)?(?:table|index|view|materialized\s+view|function|procedure|type|schema|trigger|sequence|extension|policy)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:concurrently\s+)?["`[]?([A-Za-z_][\w.]*)/i;

const ATTACHED_LINE = /^\s*(?:\/\/|\/\*|\*|#(?!!)|@|\[|--|"""|''')/;

function extractSymbol(line: string): string | undefined {
  return SQL_SYMBOL_PATTERN.exec(line)?.[1] ?? SYMBOL_PATTERN.exec(line)?.[1];
}

/**
 * Returns 0-based indices of lines that start a new segment, excluding index 0.
 */
function findCodeBoundaries(lines: string[], language: string): number[] {
  const rule = CODE_BOUNDARIES[language];
  if (!rule) return [];
  const boundaries: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const indent = line.length - line.trimStart().length;
    if (indent > rule.allowIndent || line.trim() === '') continue;
    const candidate = line.trimStart();
    if (!rule.pattern.test(candidate)) continue;
    boundaries.push(pullBackOverAttachedLines(lines, i));
  }
  return dedupeSorted(boundaries);
}

/** Moves a boundary up so that doc comments / decorators stay with the declaration below them. */
function pullBackOverAttachedLines(lines: string[], index: number): number {
  let start = index;
  while (start > 0) {
    const prev = lines[start - 1] ?? '';
    if (prev.trim() === '' || !ATTACHED_LINE.test(prev)) break;
    start--;
  }
  return start;
}

function dedupeSorted(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (v <= 0) continue;
    if (out.length === 0 || out[out.length - 1]! < v) out.push(v);
  }
  return out;
}

interface Segment {
  start: number; // 0-based inclusive
  end: number; // 0-based exclusive
  symbol?: string;
}

function segmentsFromBoundaries(lines: string[], boundaries: number[], symbolAt: (i: number) => string | undefined): Segment[] {
  const starts = [0, ...boundaries];
  const segments: Segment[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s]!;
    const end = s + 1 < starts.length ? starts[s + 1]! : lines.length;
    if (end <= start) continue;
    let symbol: string | undefined;
    for (let i = start; i < Math.min(end, start + 6); i++) {
      symbol = symbolAt(i);
      if (symbol) break;
    }
    segments.push({ start, end, symbol });
  }
  return segments;
}

function markdownSegments(lines: string[]): Segment[] {
  const segments: Segment[] = [];
  const headingStack: { level: number; text: string }[] = [];
  let inFence = false;
  let current: Segment = { start: 0, end: 0 };
  let currentPath: string | undefined;

  const flush = (end: number) => {
    if (end > current.start) segments.push({ start: current.start, end, symbol: currentPath });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading && i > 0) {
      flush(i);
      current = { start: i, end: i };
    }
    if (heading) {
      const level = heading[1]!.length;
      while (headingStack.length && headingStack[headingStack.length - 1]!.level >= level) headingStack.pop();
      headingStack.push({ level, text: heading[2]!.trim() });
      currentPath = headingStack.map((h) => h.text).join(' > ');
    }
  }
  flush(lines.length);
  return segments;
}

// ---------------------------------------------------------------------------
// Merging and windowing
// ---------------------------------------------------------------------------

function charCount(lines: string[], start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) n += (lines[i]?.length ?? 0) + 1;
  return n;
}

function mergeSegments(lines: string[], segments: Segment[], opts: Required<ChunkOptions>): Segment[] {
  const merged: Segment[] = [];
  let current: Segment | null = null;
  const symbols: string[] = [];

  const flush = () => {
    if (!current) return;
    const unique = Array.from(new Set(symbols)).slice(0, 4);
    merged.push({ ...current, symbol: unique.length ? unique.join(', ') : undefined });
    current = null;
    symbols.length = 0;
  };

  for (const seg of segments) {
    if (!current) {
      current = { ...seg };
      if (seg.symbol) symbols.push(seg.symbol);
      continue;
    }
    const combinedLines = seg.end - current.start;
    const combinedChars = charCount(lines, current.start, seg.end);
    const currentLines = current.end - current.start;
    const currentIsSmall = currentLines < opts.minLines;
    const fits = combinedLines <= opts.maxLines && combinedChars <= opts.maxChars;
    if (fits && (currentIsSmall || seg.end - seg.start < opts.minLines)) {
      current.end = seg.end;
      if (seg.symbol) symbols.push(seg.symbol);
    } else {
      flush();
      current = { ...seg };
      if (seg.symbol) symbols.push(seg.symbol);
    }
  }
  flush();
  return merged;
}

function windowSegment(lines: string[], seg: Segment, opts: Required<ChunkOptions>): Segment[] {
  const total = seg.end - seg.start;
  const chars = charCount(lines, seg.start, seg.end);
  if (total <= opts.maxLines && chars <= opts.maxChars) return [seg];

  // Choose a window size that satisfies both limits for this segment.
  const avgChars = Math.max(1, chars / total);
  const linesByChars = Math.max(10, Math.floor(opts.maxChars / avgChars));
  const size = Math.max(10, Math.min(opts.maxLines, linesByChars));
  const step = Math.max(1, size - opts.overlapLines);

  const windows: Segment[] = [];
  for (let start = seg.start; start < seg.end; start += step) {
    const end = Math.min(seg.end, start + size);
    windows.push({ start, end, symbol: seg.symbol });
    if (end === seg.end) break;
  }
  return windows;
}

function toChunk(filePath: string, lines: string[], seg: Segment, language: string, contentType: ContentType): Chunk | null {
  let end = seg.end;
  // Trim trailing blank lines from the text while keeping line numbers honest.
  while (end > seg.start && (lines[end - 1] ?? '').trim() === '') end--;
  if (end <= seg.start) return null;
  const text = lines.slice(seg.start, end).join('\n');
  if (text.trim() === '') return null;
  return {
    filePath,
    startLine: seg.start + 1,
    endLine: end,
    text,
    contentType,
    language,
    ...(seg.symbol ? { symbol: seg.symbol } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function chunkFile(filePath: string, content: string, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const language = detectLanguage(filePath);
  const contentType = detectContentType(filePath, language);
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || content.trim() === '') return [];

  let segments: Segment[];
  if (language === 'markdown') {
    segments = markdownSegments(lines);
  } else if (CODE_BOUNDARIES[language]) {
    const boundaries = findCodeBoundaries(lines, language);
    segments = segmentsFromBoundaries(lines, boundaries, (i) => extractSymbol(lines[i] ?? ''));
  } else if (SCHEMA_LANGUAGES.has(language)) {
    const boundaries: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (SCHEMA_BOUNDARY.test(lines[i] ?? '')) boundaries.push(i);
    }
    segments = segmentsFromBoundaries(lines, boundaries, (i) => extractSymbol(lines[i] ?? ''));
  } else {
    segments = [{ start: 0, end: lines.length }];
  }

  const merged = mergeSegments(lines, segments, opts);
  const windowed = merged.flatMap((seg) => windowSegment(lines, seg, opts));
  const chunks: Chunk[] = [];
  for (const seg of windowed) {
    const chunk = toChunk(filePath, lines, seg, language, contentType);
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

/** Text handed to the embedding model: a short header gives the model file and symbol context. */
export function embeddingTextFor(chunk: Chunk, repository?: string): string {
  const header = [repository ? `repository: ${repository}` : null, `file: ${chunk.filePath}`, chunk.symbol ? `symbol: ${chunk.symbol}` : null]
    .filter(Boolean)
    .join('\n');
  return `${header}\n\n${chunk.text}`;
}
