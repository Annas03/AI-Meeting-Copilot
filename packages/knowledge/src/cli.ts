#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadRootEnv } from './env.js';
import { Knowledge } from './knowledge.js';

const USAGE = `Usage:
  index    --project <id> --path <repo dir> [--repository <name>] [--full] [--exclude <gitignore pattern>]...
  search   --project <id> --query "<text>" [--limit 8] [--type source_code|documentation|schema|config]
  projects

Environment (root .env): QDRANT_URL, QDRANT_API_KEY, QDRANT_COLLECTION, EMBEDDINGS_PROVIDER (voyage|fake), VOYAGE_API_KEY, EMBEDDING_MODEL, DATA_DIR`;

async function main(): Promise<void> {
  loadRootEnv();
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  const knowledge = Knowledge.fromEnv();

  if (command === 'index') {
    const { values } = parseArgs({
      args: rest,
      options: {
        project: { type: 'string' },
        path: { type: 'string' },
        repository: { type: 'string' },
        full: { type: 'boolean', default: false },
        exclude: { type: 'string', multiple: true },
      },
    });
    if (!values.project || !values.path) {
      console.error('index requires --project and --path\n');
      console.error(USAGE);
      process.exit(1);
    }
    // npm runs workspace scripts inside the package folder; INIT_CWD is where the user typed the command.
    const repoPath = path.resolve(process.env.INIT_CWD ?? process.cwd(), values.path);
    const repository = values.repository ?? path.basename(repoPath);
    const health = await knowledge.health();
    if (!health.qdrant) {
      console.error(`Qdrant is not reachable at ${process.env.QDRANT_URL ?? 'http://127.0.0.1:6333'}. Start it with: npm run qdrant`);
      process.exit(2);
    }
    console.log(`Indexing ${repoPath} as project "${values.project}" (repository ${repository}) with ${health.embeddings}`);
    let lastPhase = '';
    const result = await knowledge.index({
      projectId: values.project,
      repository,
      repoPath,
      full: values.full,
      exclude: values.exclude,
      onProgress: (p) => {
        if (p.phase !== lastPhase || p.phase === 'embed' || p.phase === 'done' || p.phase === 'discover') {
          const counter = p.done !== undefined && p.total !== undefined ? ` [${p.done}/${p.total}]` : '';
          console.log(`[${p.phase}]${counter} ${p.message}`);
          lastPhase = p.phase;
        }
      },
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'search') {
    const { values } = parseArgs({
      args: rest,
      options: {
        project: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'string', default: '8' },
        type: { type: 'string', multiple: true },
      },
    });
    if (!values.project || !values.query) {
      console.error('search requires --project and --query\n');
      console.error(USAGE);
      process.exit(1);
    }
    const started = Date.now();
    const hits = await knowledge.search({
      projectId: values.project,
      query: values.query,
      limit: Number(values.limit),
      contentTypes: values.type as never,
    });
    console.log(`${hits.length} hits in ${Date.now() - started} ms\n`);
    for (const [i, hit] of hits.entries()) {
      console.log(`${i + 1}. ${hit.filePath}:${hit.startLine}-${hit.endLine}  score=${hit.score.toFixed(3)}  ${hit.contentType}${hit.symbol ? `  (${hit.symbol})` : ''}`);
      const preview = hit.text.split('\n').slice(0, 4).join('\n   ');
      console.log(`   ${preview}\n`);
    }
    return;
  }

  if (command === 'projects') {
    const manifests = await knowledge.projects();
    if (manifests.length === 0) {
      console.log('No indexed projects. Run: npm run index -- --project <id> --path <repo>');
      return;
    }
    for (const m of manifests) {
      const files = Object.keys(m.files).length;
      const chunks = Object.values(m.files).reduce((acc, f) => acc + f.chunkCount, 0);
      console.log(`${m.projectId}  ${m.repository}  ${files} files  ${chunks} chunks  rev ${m.revision.slice(0, 10)}  ${m.embeddingId}  last run ${m.lastRun?.status ?? 'n/a'} ${m.lastRun?.finishedAt ?? ''}`);
    }
    return;
  }

  console.error(`Unknown command "${command}"\n`);
  console.error(USAGE);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
