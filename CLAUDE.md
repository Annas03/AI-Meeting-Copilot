# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI engineering meeting copilot (MVP): a LiveKit meeting with an AI participant that transcribes speakers, detects engineering questions, retrieves evidence from a pre-indexed codebase (Qdrant), and streams Claude-written answers with file citations into a side panel. It also keeps structured meeting memory and briefs late joiners. All TypeScript, npm workspaces, Windows-first (no Docker/Python). See [README.md](README.md) for the full setup and the "how a question becomes an answer" walkthrough.

## Commands

Run from the repo root (PowerShell). Node 22+.

```powershell
npm install
npm run typecheck            # tsc --noEmit in every workspace
npm test                     # vitest run in shared, knowledge, server (web/agent have no tests)
npm run qdrant:setup         # one-time: downloads qdrant.exe into tools/qdrant
npm run qdrant               # local Qdrant on :6333 (required for retrieval)
npm run dev:server           # Express + ws on :8787 (tsx watch)
npm run dev:agent            # LiveKit agent worker (needs LIVEKIT_* in .env)
npm run dev:web              # Vite on :5173, proxies /api and /ws to the server
npm run index -- --project myapp --path D:\path\to\repo --repository org/repo
npm run search -- --project myapp --query "where is authorization enforced"
npm run projects -w @copilot/knowledge
node scripts/smoke.mjs       # end-to-end check against a running server, no LiveKit/mic needed
```

Single workspace / single test:

```powershell
npm test -w @copilot/server
npx vitest run src/copilot/detector.test.ts       # run from inside the workspace dir
npx vitest run -t "question deduplication"        # by test name
```

## Configuration

A single `.env` at the repo root is read by every app (server via `loadRootEnv()` from `@copilot/knowledge`; web via Vite `envDir` — only `VITE_*` reach the browser). Server env is validated with zod in [apps/server/src/config.ts](apps/server/src/config.ts); all variables are documented in [.env.example](.env.example).

Everything degrades gracefully without keys, and code should preserve this:
- No LiveKit → text-only meetings (join returns empty `livekitUrl`/token; Ask box + dev transcript injector still work).
- No Anthropic key → heuristic question detection, template briefings, degraded memory (`anthropic()` returns `null`; `requireAnthropic()` throws `LlmUnavailableError`).
- `EMBEDDINGS_PROVIDER=fake` → offline hashed embeddings. Changing embedding provider/model rebuilds the index.

## Architecture

Workspaces: `apps/web` (Vite + React UI), `apps/server` (Express + ws), `apps/agent` (`@livekit/agents` worker), `packages/knowledge` (indexer + semantic search), `packages/shared` (zod schemas). The packages are consumed as TS source directly (`exports` point at `src/index.ts`); there is no build step for dev.

**Data flow.** Agent joins every LiveKit room named `meeting-<meetingId>`, runs one streaming STT session per speaker track, publishes partial captions, and POSTs segments to the server's `/api/internal/*` routes (auth: `x-internal-secret` = `INTERNAL_API_SECRET`). `MeetingService.ingestSegment` ([apps/server/src/meetings/service.ts](apps/server/src/meetings/service.ts)) is the single entry for transcript segments (agent and dev injector): partials are only broadcast; finals are persisted with a per-meeting sequence, broadcast, fed to `MeetingMemory`, and passed to `QuestionDetector` → `InvestigationManager` (dedupe, Qdrant retrieval filtered by project, streamed Claude answer).

**Server wiring** is manual DI in [apps/server/src/index.ts](apps/server/src/index.ts); services receive a `deps` object. Note the intentional circular reference: `InvestigationManager` gets a `getContext` callback that resolves to `MeetingService.getContext`.

**Events.** `EventHub` ([apps/server/src/events/hub.ts](apps/server/src/events/hub.ts)) routes typed events to WebSocket clients per meeting (`/ws?meetingId=&session=`). `emitTo` queues targeted events (e.g. late-joiner briefings) for up to 5 min if the recipient hasn't connected yet. Event names and payload schemas live in [packages/shared/src/events.ts](packages/shared/src/events.ts); REST request/response schemas in `packages/shared/src/api.ts`. Adding or changing an event means updating the shared schema, the server emitter, and the web reducer in [apps/web/src/copilot/state.ts](apps/web/src/copilot/state.ts).

**Auth.** Browser sessions get a random session token on join (`x-session-token` header / `session` WS param). The dev injector `POST /api/dev/meetings/:id/transcript` accepts either header and is disabled when `NODE_ENV=production`.

**Persistence.** Embedded PGlite under `data/pg` with drizzle. There are no migrations: [apps/server/src/db/schema.ts](apps/server/src/db/schema.ts) contains both the drizzle tables and a hand-maintained idempotent `DDL` string executed at boot — schema changes must update both. Tests use `openMemoryDatabase()`.

**Knowledge package.** Indexer pipeline: discover (`git ls-files`, or `.gitignore`-aware walk; skips binaries, lockfiles, secret-looking files) → chunk (top-level declarations for code, headings for docs, statements for SQL, windowed with overlap) → embed (Voyage or fake) → store in Qdrant. Incremental: content hashes are kept in `data/index/<project>.json` manifests; only changed files are re-embedded and removed files' chunks deleted. `Knowledge.fromEnv()` is the server's entry point.

**LLM usage** goes through [apps/server/src/llm/client.ts](apps/server/src/llm/client.ts) (models from `ANSWER_MODEL` / `MEMORY_MODEL` / `CLASSIFIER_MODEL`; wrap provider calls in `withTimeout`). Prompts are in `apps/server/src/copilot/prompts.ts`; transcripts and retrieved code are treated as untrusted input there. Answers cite evidence as `[E1]`, `[E2]`, and weak retrieval (below `RETRIEVAL_MIN_SCORE`) flags an answer as preliminary.

## Conventions

- ESM everywhere, strict TS with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (use `import type`).
- Relative imports use `.js` extensions in server/knowledge/shared, but `.ts` extensions in `apps/agent` (it sets `allowImportingTsExtensions` and runs only via tsx).
- `data/` (PGlite, Qdrant storage, manifests) and `tools/qdrant` are local runtime state, not source.

## Out of scope for the MVP

Automatic code changes/PRs, multi-agent workflows, Teams integration, Redis job queues, the deep-investigation path, and a data retention policy (transcripts persist in `data/` indefinitely).
