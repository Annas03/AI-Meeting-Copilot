# AI Engineering Meeting Copilot (MVP)

An AI participant for your Zoom and Google Meet calls. A Recall.ai meeting bot joins the call and transcribes each speaker; the server detects engineering questions in the live transcript, retrieves evidence from a pre-indexed codebase, and answers in a companion web panel with file references. It keeps structured meeting memory and briefs late joiners. Repository access is read-only.

Everything is TypeScript and runs on Windows without Docker or Python: Recall.ai for the meeting bot and transcription, a local Qdrant binary for vectors, embedded PostgreSQL (PGlite) for state, Voyage AI for embeddings, and Claude for reasoning.

## Architecture

```
 Zoom / Google Meet call  ◀──  Recall.ai bot (visible participant, per-speaker transcription)
                                        │ webhooks: bot status + partial/final transcript
                                        ▼
 browser (apps/web)  ◀──WebSocket──  apps/server (Express + ws)  ◀── REST ──  browser
   companion panel                     /api/recall/webhook ─▶ transcript segments
                                       question detection ─▶ retrieval ─▶ streamed answer ─▶ events
                                       meeting memory, late-joiner briefing
                                         │                       │
                                   PGlite (data/pg)        packages/knowledge ─▶ Qdrant (vectors)
                                                                 ▲
                                                  indexer CLI: discover → chunk → embed → store → sync
```

| Package | Role |
|---|---|
| `apps/web` | Vite + React companion panel: create a meeting from a link, bot status, answers, transcript, memory, briefing |
| `apps/server` | Meetings, event hub, question detector, retrieval, answer streaming, memory, briefings |
| `apps/server/src/bots` | Meeting bots: the Recall.ai provider and the webhook → transcript segment bridge |
| `packages/knowledge` | Repository indexer and semantic search (Qdrant + Voyage, or an offline fake provider) |
| `packages/shared` | Zod schemas for the event protocol and REST API, shared by all apps |

Event names (`transcript.partial`, `transcript.final`, `analysis.started`, `analysis.delta`, `analysis.completed`, `analysis.failed`, `meeting.state.updated`, `meeting.briefing.ready`, `participant.joined/left`, `agent.status`) are defined in [packages/shared/src/events.ts](packages/shared/src/events.ts).

## Prerequisites

- Node.js 22+ (developed on 24) and npm 10+
- git (used by the indexer to list repository files)
- Accounts/keys:
  - **Recall.ai**: `RECALL_API_KEY` (recall.ai, pick a region). Pay-as-you-go pricing is per recording hour plus a transcription fee, with some free hours to start. Meetings cannot be created without it.
  - **Anthropic**: `ANTHROPIC_API_KEY` (console.anthropic.com)
  - **Voyage AI**: `VOYAGE_API_KEY` (dash.voyageai.com) for code embeddings
- A public URL for the server, because Recall delivers webhooks: in dev, `ngrok http 8787` or `cloudflared tunnel --url http://127.0.0.1:8787`.

For development without accounts, `RECALL_API_KEY=fake` simulates the bot (no call is joined; the smoke test replays its webhooks), and the rest degrades to offline hashed embeddings, heuristic question detection and template briefings.

## Setup

```powershell
npm install
copy .env.example .env      # then edit .env and fill in the keys above
npm run qdrant:setup        # downloads qdrant.exe (and the dashboard) into tools/qdrant
```

`.env` lives at the repository root and is read by every app.

## Run

```powershell
npm run qdrant                       # 1. vector database on http://127.0.0.1:6333 (dashboard at /dashboard)
npm run index -- --project myapp --path D:\path\to\repo --repository org/repo   # 2. index a codebase (re-run to sync changes)
ngrok http 8787                      # 3. dev only: put the https URL in .env as PUBLIC_SERVER_URL
npm run dev:server                   # 4. API + WebSocket on http://127.0.0.1:8787
npm run dev:web                      # 5. UI on http://localhost:5173
```

Connect Recall.ai once: with `RECALL_API_KEY`, `RECALL_REGION`, `PUBLIC_SERVER_URL` and (recommended) `RECALL_WEBHOOK_SECRET` set, the server logs its status webhook URL (`<PUBLIC_SERVER_URL>/api/recall/webhook`). Add it in the Recall dashboard and subscribe to the bot status events; transcript events are configured per bot automatically.

Then open http://localhost:5173, paste a Zoom or Google Meet link, enter the project name you indexed (`myapp`) and create the meeting. The bot asks to join: **admit it from the meeting lobby**. Ask a question out loud such as *"Can we add organisation-level permissions?"*. The companion panel shows the bot's status, the transcript, the analysis status, and a streamed answer with cited file references; share the panel link with teammates, and anyone opening it later gets the catch-up briefing. **End & remove bot** pulls the bot out of the call.

Only Zoom and Google Meet links are accepted for now.

Check retrieval directly: `npm run search -- --project myapp --query "where is authorization enforced"`. List indexed projects with `npm run projects -w @copilot/knowledge`.

### Smoke test without a call

Set `RECALL_API_KEY=fake` and `PUBLIC_SERVER_URL=http://127.0.0.1:8787`, start the server and run `node scripts/smoke.mjs`. It creates a meeting from a Google Meet link, opens the WebSocket and replays Recall webhooks through `/api/recall/webhook` (status changes, partial and final transcript events, a duplicate delivery, call end), signed when `RECALL_WEBHOOK_SECRET` is set. It then checks the transcript, the detected question, meeting memory and the meeting end, plus a user-initiated end, the dev injector and link validation.

The dev injector is `POST /api/dev/meetings/:id/transcript` with `{ "speakerName": "...", "text": "..." }`, authenticated with the session token header `x-session-token` returned when joining the meeting. It is disabled when `NODE_ENV=production`. The panel's **Ask** box always works too.

Known limitation: in-flight partial utterances live in server memory, so a restart mid-call drops at most one partial per speaker; bot ids are persisted and webhooks keep flowing afterwards.

## How a question becomes an answer

1. The Recall.ai bot transcribes each participant separately (Recall's streaming transcription in low-latency mode, English only) and posts partial and final utterances labelled with the speaker's display name to `/api/recall/webhook`. The server pairs each speaker's partials with their final into one segment; partials are only broadcast as live captions.
2. The server stores final segments (sequence per meeting), broadcasts them, and runs a cheap heuristic gate followed by a fast classifier (`CLASSIFIER_MODEL`, default Claude Haiku 5.5) that rewrites the line as a standalone question.
3. Similar questions in the last ten minutes are deduplicated. Otherwise an investigation starts (`analysis.started`).
4. The question is embedded and searched in Qdrant, filtered to the meeting's project (`RETRIEVAL_LIMIT` chunks).
5. Claude (`ANSWER_MODEL`, default Claude Opus 5.5, `ANSWER_EFFORT=low` for latency) streams a markdown answer with the blueprint structure (assessment, components, risks, evidence, next step), citing chunks as `[E1]`, `[E2]`. Deltas stream to the panel; the final answer records which evidence was cited and the measured latencies. Weak or missing evidence is flagged as preliminary. Server-side refusal fallbacks are enabled by default (`ANSWER_FALLBACKS`).
6. Every five final segments (or 45 s), meeting memory is updated incrementally: current topic, rolling summary, decisions (confirmed vs proposed), open questions, action items, investigations and surfaced evidence. A late joiner receives a briefing generated from that state, cached per state version.

## Configuration

All variables are documented in [.env.example](.env.example). Notable ones:

| Variable | Default | Purpose |
|---|---|---|
| `EMBEDDINGS_PROVIDER` | `voyage` | `voyage` or `fake` (offline). Changing provider or model rebuilds the index |
| `EMBEDDING_MODEL` | `voyage-code-4` | Voyage model (`voyage-code-3` also works) |

| `ANSWER_MODEL` / `MEMORY_MODEL` / `CLASSIFIER_MODEL` | Opus 5.5 / Opus 5.5 / Haiku 5.5 | Claude models per task |
| `ANSWER_EFFORT` | `low` | Reasoning effort for answers; raise to `medium` for harder questions |
| `RETRIEVAL_LIMIT` / `RETRIEVAL_MIN_SCORE` | 8 / 0.25 | Chunks per question and the score below which evidence is treated as weak |
| `QDRANT_URL` / `QDRANT_API_KEY` | local | Point at Qdrant Cloud instead of the local binary |
| `RECALL_API_KEY` / `RECALL_REGION` | unset / `us-east-1` | Recall.ai meeting bots, required to create meetings (`fake` = offline provider) |
| `RECALL_WEBHOOK_SECRET` / `PUBLIC_SERVER_URL` | unset | Svix secret for webhook verification; public base URL Recall posts webhooks to (required) |
| `DATA_DIR` | `./data` | PGlite database, Qdrant storage and index manifests |

## Indexing details

The indexer lists files with `git ls-files` (tracked plus untracked-but-not-ignored) or, outside git, walks the tree honouring the root `.gitignore`. Build output, dependencies, lockfiles, binaries, media and secret-looking files are excluded; files containing credential-like strings are skipped and logged. Code is chunked at top-level declarations, docs at headings, SQL at statements; oversized segments are windowed with overlap. Each chunk carries `projectId`, `repository`, `filePath`, line range, `contentType`, `language`, `symbol` and `revision`. Re-runs compare content hashes from `data/index/<project>.json` and only re-embed changed files, deleting chunks of removed files.

## Verification done so far

- `npm run typecheck` and `npm test` pass (shared, knowledge, server, web).
- Offline: Qdrant binary runs, this repository indexes and searches with correct file references. Provider mappers, webhook signature verification and the bot manager are unit-tested, and `scripts/smoke.mjs` passes against the server with the fake bot provider (transcript, detection, memory, briefing, WebSocket events, meeting end).
- A real Recall.ai bot in a live Zoom / Google Meet call has not been exercised on this machine yet.

## Not in the MVP (by design)

Automatic code changes, pull requests, multi-agent workflows, Microsoft Teams integration (Teams links are rejected by the bot path), Redis-backed job queues, and the deep-investigation path (Phase 6). Transcripts and answers are retained in `data/` indefinitely; add a retention policy before real use.

## Security notes

Recall.ai, Anthropic and Voyage credentials stay on the server. Recall webhooks are verified with the Svix signing secret (or a token in the real-time endpoint URL); without `RECALL_WEBHOOK_SECRET` they are accepted unverified, so always set it when the server is reachable from the internet. Browser sessions get a random session token on join; WebSocket and REST calls require it. Retrieval is filtered by project in Qdrant before any chunk reaches the model. Transcripts and retrieved code are treated as untrusted input in the prompts. Meeting audio is transcribed by Recall.ai, a third party. The bot is a visible participant in the call, and the panel's join page reminds users to tell the other participants that AI transcription and analysis are active.
