# AI Engineering Meeting Copilot (MVP)

A LiveKit meeting with an AI participant that listens, detects engineering questions, retrieves evidence from a pre-indexed codebase, and answers in a side panel with file references. It keeps structured meeting memory and briefs late joiners. Repository access is read-only. The same copilot can attach to an existing Zoom or Google Meet call through a Recall.ai meeting bot (see [Attach to a Zoom or Google Meet meeting](#attach-to-a-zoom-or-google-meet-meeting)).

Everything is TypeScript and runs on Windows without Docker or Python: LiveKit Cloud for media, a local Qdrant binary for vectors, embedded PostgreSQL (PGlite) for state, Voyage AI for embeddings, and Claude for reasoning.

## Architecture

```
 browser (apps/web)  ──WebRTC──▶  LiveKit Cloud  ◀──WebRTC──  AI participant (apps/agent)
   React + LiveKit components         room                      @livekit/agents, STT per speaker
   AI side panel  ◀──WebSocket──┐                                      │ HTTP (internal secret)
                                │                                      ▼
                        apps/server (Express + ws)  ◀── REST ──  browser
                          question detection ─▶ retrieval ─▶ streamed answer ─▶ events
                          meeting memory, late-joiner briefing
                                │                       │
                          PGlite (data/pg)        packages/knowledge ─▶ Qdrant (vectors)
                                                       ▲
                                        indexer CLI: discover → chunk → embed → store → sync

 Zoom / Google Meet  ◀──  Recall.ai bot  ──webhooks──▶  apps/server /api/recall/webhook ─▶ same pipeline
   (companion panel in the browser, no LiveKit)          bot status + speaker-labelled transcript
```

| Package | Role |
|---|---|
| `apps/web` | Vite + React meeting UI: pre-join, video grid, copilot panel (answers, transcript, memory, briefing) |
| `apps/server` | Meetings, LiveKit tokens, event hub, question detector, retrieval, answer streaming, memory, briefings |
| `apps/agent` | LiveKit agent worker: joins every meeting room, transcribes each speaker, publishes captions, feeds the server |
| `apps/server/src/bots` | Zoom / Google Meet attach: Recall.ai bot provider and the webhook → transcript segment bridge |
| `packages/knowledge` | Repository indexer and semantic search (Qdrant + Voyage, or an offline fake provider) |
| `packages/shared` | Zod schemas for the event protocol and REST API, shared by all apps |

Event names (`transcript.partial`, `transcript.final`, `analysis.started`, `analysis.delta`, `analysis.completed`, `analysis.failed`, `meeting.state.updated`, `meeting.briefing.ready`, `participant.joined/left`, `agent.status`) are defined in [packages/shared/src/events.ts](packages/shared/src/events.ts).

## Prerequisites

- Node.js 22+ (developed on 24) and npm 10+
- git (used by the indexer to list repository files)
- Accounts/keys, all free to start:
  - **LiveKit Cloud** project: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (cloud.livekit.io → project → Settings → Keys). The free tier includes LiveKit Inference credits, which the agent uses for speech-to-text, so no separate STT key is needed.
  - **Anthropic**: `ANTHROPIC_API_KEY` (console.anthropic.com)
  - **Voyage AI**: `VOYAGE_API_KEY` (dash.voyageai.com) for code embeddings

Everything also runs in a degraded **offline mode** without any key: text-only meetings, offline hashed embeddings, heuristic question detection, template briefings. Useful for development and for the smoke test.

## Setup

```powershell
npm install
copy .env.example .env      # then edit .env and fill in the keys above
npm run qdrant:setup        # downloads qdrant.exe (and the dashboard) into tools/qdrant
```

`.env` lives at the repository root and is read by every app. Set `INTERNAL_API_SECRET` to a long random string; the agent uses it to talk to the server.

## Run (four terminals)

```powershell
npm run qdrant                       # 1. vector database on http://127.0.0.1:6333 (dashboard at /dashboard)
npm run index -- --project myapp --path D:\path\to\repo --repository org/repo   # 2. index a codebase (re-run to sync changes)
npm run dev:server                   # 3. API + WebSocket on http://127.0.0.1:8787
npm run dev:agent                    # 4. AI participant worker (needs LIVEKIT_* in .env)
npm run dev:web                      # 5. UI on http://localhost:5173
```

Then open http://localhost:5173, create a meeting with the project name you indexed (`myapp`), share the link with a second browser/person, join with your microphone on, and ask a question such as *"Can we add organisation-level permissions?"*. The copilot panel shows the transcript, the analysis status, and a streamed answer with cited file references. Open the link in a third browser a few minutes in to see the catch-up briefing.

Check retrieval directly: `npm run search -- --project myapp --query "where is authorization enforced"`. List indexed projects with `npm run projects -w @copilot/knowledge`.

### Smoke test without LiveKit or a microphone

With the server running, `node scripts/smoke.mjs` creates a meeting, joins in text-only mode, opens the WebSocket, injects five transcript lines through the dev endpoint and prints the events and answer it receives. In the UI, the same text-only mode appears automatically when LiveKit is not configured, and the **Ask** box always works.

The dev injector is `POST /api/dev/meetings/:id/transcript` with `{ "speakerName": "...", "text": "..." }`, authenticated with either the session token header `x-session-token` or the internal secret header `x-internal-secret`. It is disabled when `NODE_ENV=production`.

### Attach to a Zoom or Google Meet meeting

Most teams meet in Zoom or Google Meet rather than in this app, so the copilot can also join those calls as a **Recall.ai meeting bot**. The bot is a visible participant that streams a speaker-labelled transcript to the server; everything after that (question detection, retrieval, answers, memory, briefings) is the same pipeline, and the web app becomes a companion panel you keep open next to the call.

1. Create a Recall.ai account (recall.ai), pick a region and create an API key. Pay-as-you-go pricing is per recording hour plus a transcription fee, with some free hours to start.
2. Expose the server publicly, because Recall delivers webhooks: in dev run `ngrok http 8787` (or `cloudflared tunnel --url http://127.0.0.1:8787`) and put the https URL in `.env` as `PUBLIC_SERVER_URL`.
3. Set `RECALL_API_KEY`, `RECALL_REGION` and (recommended) `RECALL_WEBHOOK_SECRET`, then restart the server. It logs the status webhook URL (`<PUBLIC_SERVER_URL>/api/recall/webhook`): add it in the Recall dashboard and subscribe to the bot status events. Transcript events are configured per bot automatically.
4. On the home page, paste the Zoom or Meet link into **Zoom / Google Meet link** and create the meeting. The bot knocks; **admit it from the meeting lobby**. The companion panel shows the bot's status, the live transcript and the answers; **End & remove bot** pulls it out of the call.

Only Zoom and Google Meet links are accepted for now. Without `RECALL_API_KEY` and `PUBLIC_SERVER_URL` the link field is hidden and the LiveKit flow is unchanged.

Offline check without a Recall account: set `RECALL_API_KEY=fake` and `PUBLIC_SERVER_URL=http://127.0.0.1:8787`, start the server and run `node scripts/recall-smoke.mjs`. It creates an external meeting and replays Recall webhooks (status changes, partial and final transcript events, a duplicate delivery, call end) through `/api/recall/webhook`, signed when `RECALL_WEBHOOK_SECRET` is set, then checks the transcript, the detected question and the meeting end.

Known limitation: in-flight partial utterances live in server memory, so a restart mid-call drops at most one partial per speaker; bot ids are persisted and webhooks keep flowing afterwards.

## How a question becomes an answer

1. The agent subscribes to every participant's audio track and runs one streaming STT session per speaker (LiveKit Inference `deepgram/nova-3` by default, or the Deepgram plugin with `STT_PROVIDER=deepgram`). Interim results are published as partial captions; the finished utterance is sent once as a final segment.
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
| `STT_PROVIDER` | `livekit` | `livekit` (Inference via Cloud credentials) or `deepgram` (`DEEPGRAM_API_KEY`) |
| `ANSWER_MODEL` / `MEMORY_MODEL` / `CLASSIFIER_MODEL` | Opus 5.5 / Opus 5.5 / Haiku 5.5 | Claude models per task |
| `ANSWER_EFFORT` | `low` | Reasoning effort for answers; raise to `medium` for harder questions |
| `RETRIEVAL_LIMIT` / `RETRIEVAL_MIN_SCORE` | 8 / 0.25 | Chunks per question and the score below which evidence is treated as weak |
| `QDRANT_URL` / `QDRANT_API_KEY` | local | Point at Qdrant Cloud instead of the local binary |
| `RECALL_API_KEY` / `RECALL_REGION` | unset / `us-east-1` | Enable Zoom / Google Meet attach through Recall.ai (`fake` = offline provider) |
| `RECALL_WEBHOOK_SECRET` / `PUBLIC_SERVER_URL` | unset | Svix secret for webhook verification; public base URL Recall posts webhooks to |
| `DATA_DIR` | `./data` | PGlite database, Qdrant storage and index manifests |

## Indexing details

The indexer lists files with `git ls-files` (tracked plus untracked-but-not-ignored) or, outside git, walks the tree honouring the root `.gitignore`. Build output, dependencies, lockfiles, binaries, media and secret-looking files are excluded; files containing credential-like strings are skipped and logged. Code is chunked at top-level declarations, docs at headings, SQL at statements; oversized segments are windowed with overlap. Each chunk carries `projectId`, `repository`, `filePath`, line range, `contentType`, `language`, `symbol` and `revision`. Re-runs compare content hashes from `data/index/<project>.json` and only re-embed changed files, deleting chunks of removed files.

## Verification done so far

- `npm run typecheck` and `npm test` pass (shared, knowledge, server, web, agent).
- Offline: Qdrant binary runs, this repository indexes and searches with correct file references, `scripts/smoke.mjs` passes against the server (transcript, detection, memory, briefing, WebSocket events).
- Live meeting flow (LiveKit Cloud + Claude + Voyage) requires the keys in `.env` and has not been exercised on this machine yet.
- Zoom / Google Meet attach: provider mappers, signature verification and the bot manager are unit-tested, and `scripts/recall-smoke.mjs` passes offline with the fake provider. A real Recall.ai bot has not been exercised yet.

## Not in the MVP (by design)

Automatic code changes, pull requests, multi-agent workflows, Microsoft Teams integration (Teams links are rejected by the bot path), Redis-backed job queues, and the deep-investigation path (Phase 6). Transcripts and answers are retained in `data/` indefinitely; add a retention policy before real use.

## Security notes

LiveKit, Anthropic and Voyage credentials stay on the server and agent. Browser sessions get a random session token on join; WebSocket and REST calls require it. Retrieval is filtered by project in Qdrant before any chunk reaches the model. Transcripts and retrieved code are treated as untrusted input in the prompts. The pre-join page tells participants that AI transcription and analysis are active.
