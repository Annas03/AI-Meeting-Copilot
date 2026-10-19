#!/usr/bin/env node
/**
 * End-to-end smoke test against a running server, without a real call or bot. Creates a meeting from a
 * Google Meet link, opens the companion WebSocket and replays the Recall.ai webhook lifecycle (status
 * changes, partial + final transcript events, a duplicate delivery, call end), then checks a user-initiated
 * end, the dev transcript injector and link validation. Needs RECALL_API_KEY=fake and
 * PUBLIC_SERVER_URL=http://127.0.0.1:8787 in .env (RECALL_WEBHOOK_SECRET optional: deliveries are
 * Svix-signed when it is set).
 *
 *   node scripts/smoke.mjs                # uses http://127.0.0.1:8787 and project "copilot"
 *   SERVER_URL=... PROJECT_ID=... node scripts/smoke.mjs
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const base = (process.env.SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const projectId = process.env.PROJECT_ID ?? 'copilot';
const SESSION_HEADER = 'x-session-token';
const MEETING_URL = 'https://meet.google.com/abc-defg-hij';
const secret = process.env.RECALL_WEBHOOK_SECRET || readDotEnv('RECALL_WEBHOOK_SECRET');

// Priya has no display name on the platform: the server must label her "Speaker 3".
const SPEAKERS = { Ahsan: { id: 1, name: 'Ahsan' }, Sara: { id: 2, name: 'Sara' }, Priya: { id: 3, name: null } };
const LINES = [
  ['Ahsan', "Let's go through the copilot backlog for this sprint."],
  ['Sara', 'The indexing pipeline is done and the search CLI returns file references.'],
  ['Ahsan', 'We decided to run Qdrant as a local binary instead of Docker.'],
  ['Priya', 'Can we add organization-level permissions to the meeting API?'],
  ['Sara', 'Also, who owns the Recall.ai account setup? Ahsan will add the keys tomorrow.'],
];

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readDotEnv(key) {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') || undefined : undefined;
  } catch {
    return undefined;
  }
}

async function json(path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return body;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      return await json('/api/health');
    } catch {
      await sleep(1000);
    }
  }
  fail(`server not reachable at ${base}`);
}

/** Svix headers for a delivery, or none when no secret is configured (the server then accepts unsigned posts). */
function sign(id, body) {
  if (!secret) return {};
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret);
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
}

async function webhook(payload, id = `msg_${randomUUID()}`) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${base}/api/recall/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...sign(id, body) }, body });
  if (!res.ok) throw new Error(`webhook ${payload.event} -> ${res.status} ${await res.text()}`);
  return id;
}

const botRef = (botId) => ({ id: botId, metadata: {} });
const statusEvent = (botId, code, sub_code = null) => ({
  event: `bot.${code}`,
  data: { data: { code, sub_code, updated_at: new Date().toISOString() }, bot: botRef(botId) },
});
const transcriptEvent = (botId, event, speaker, text) => ({
  event,
  data: {
    data: {
      words: text.split(' ').map((w, i) => ({ text: w, start_timestamp: { relative: i * 0.3 }, end_timestamp: null })),
      participant: { id: speaker.id, name: speaker.name, is_host: false, platform: 'google_meet', extra_data: null },
      ...(event === 'transcript.data' ? { language_code: 'en' } : {}),
    },
    realtime_endpoint: { id: 'rt-1', metadata: {} },
    transcript: { id: 't-1', metadata: {} },
    recording: { id: 'r-1', metadata: {} },
    bot: botRef(botId),
  },
});

const health = await waitForServer();
log('health:', health);
if (health.recall !== 'configured') {
  log('\nRecall.ai is not configured on this server. For an offline run put in .env:\n  RECALL_API_KEY=fake\n  PUBLIC_SERVER_URL=http://127.0.0.1:8787\nthen restart the server.');
  process.exit(0);
}

const meeting = await json('/api/meetings', { method: 'POST', body: JSON.stringify({ title: 'Smoke test', projectId, meetingUrl: MEETING_URL }) });
log('meeting:', meeting.meetingId, meeting.platform, meeting.botStatus);
if (meeting.platform !== 'google_meet' || meeting.botStatus !== 'created') fail('expected a google_meet meeting with botStatus "created"');
// FakeRecallProvider derives the bot id from the meeting id; a real bot id is only known server-side.
const botId = `fake-${meeting.meetingId}`;

const join = await json(`/api/meetings/${meeting.meetingId}/join`, { method: 'POST', body: JSON.stringify({ name: 'Smoke Tester' }) });
const session = join.sessionToken;
log('joined as', join.participant.identity);

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?meetingId=${meeting.meetingId}&session=${session}`);
const events = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.type === 'event') events.push(msg.payload);
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', (e) => reject(new Error(`websocket error: ${e.message ?? e}`)));
});

await webhook(statusEvent(botId, 'joining_call'));
await webhook(statusEvent(botId, 'in_waiting_room'));
await webhook(statusEvent(botId, 'in_call_recording'));

let duplicate = null;
for (const [speaker, text] of LINES) {
  const words = text.split(' ');
  await webhook(transcriptEvent(botId, 'transcript.partial_data', SPEAKERS[speaker], words.slice(0, 2).join(' ')));
  await sleep(350); // the server forwards at most one partial per 300 ms per speaker
  await webhook(transcriptEvent(botId, 'transcript.partial_data', SPEAKERS[speaker], words.slice(0, Math.ceil(words.length / 2)).join(' ')));
  const payload = transcriptEvent(botId, 'transcript.data', SPEAKERS[speaker], text);
  const id = await webhook(payload);
  duplicate ??= { id, payload };
}
await webhook(duplicate.payload, duplicate.id); // a retried delivery: same id and body, must be ignored

await webhook(statusEvent(botId, 'call_ended', 'call_ended_by_host'));
await webhook(statusEvent(botId, 'done'));

const want = (name) => events.some((e) => e.event === name);
const deadline = Date.now() + 45_000;
while (Date.now() < deadline) {
  const analysisDone = want('analysis.completed') || want('analysis.failed');
  if (want('meeting.ended') && want('analysis.started') && analysisDone) break;
  await sleep(500);
}

const counts = events.reduce((acc, e) => ((acc[e.event] = (acc[e.event] ?? 0) + 1), acc), {});
log('events received:', counts);
const transcript = await json(`/api/meetings/${meeting.meetingId}/transcript`, { headers: { [SESSION_HEADER]: session } });
log('transcript:', transcript.segments.map((s) => `${s.speakerName}: ${s.text}`));
const completed = events.find((e) => e.event === 'analysis.completed');
const failed = events.find((e) => e.event === 'analysis.failed');
if (completed) log(`answer: ${completed.answer.assessment} (${completed.answer.evidence.filter((e) => e.cited).length} cited chunks)`);
else if (failed) log('analysis failed (expected without ANTHROPIC_API_KEY):', failed.error);
const after = await json(`/api/meetings/${meeting.meetingId}`);
const briefing = await json(`/api/meetings/${meeting.meetingId}/briefing`, { headers: { [SESSION_HEADER]: session } }).catch((e) => ({ error: e.message }));
log('briefing:', briefing.briefing ? `${briefing.briefing.markdown.slice(0, 160)}…` : briefing.error);

const finals = events.filter((e) => e.event === 'transcript.final');
const partialIds = new Set(events.filter((e) => e.event === 'transcript.partial').map((e) => e.segment.segmentId));
const waiting = events.find((e) => e.event === 'agent.status' && e.botStatus === 'waiting_room');
const problems = [];
if (!waiting || !/admit/i.test(waiting.detail ?? '')) problems.push('no agent.status event for the waiting room with an "admit" hint');
if (!events.some((e) => e.event === 'agent.status' && e.status === 'listening' && e.botStatus === 'recording')) problems.push('bot never reported as listening');
if (transcript.segments.length !== LINES.length) problems.push(`expected ${LINES.length} stored segments, got ${transcript.segments.length}`);
if (finals.length !== LINES.length) problems.push(`expected ${LINES.length} transcript.final events (duplicate delivery must be ignored), got ${finals.length}`);
if (!finals.every((e) => partialIds.has(e.segment.segmentId))) problems.push('a final segment did not share its segmentId with its partials');
if (!transcript.segments.some((s) => s.speakerName === 'Speaker 3')) problems.push('anonymous participant was not labelled "Speaker 3"');
if (!want('analysis.started')) problems.push('no analysis.started event (question detection)');
if (!want('meeting.state.updated')) problems.push('no meeting.state.updated event (meeting memory)');
if (events.filter((e) => e.event === 'meeting.ended').length !== 1) problems.push('expected exactly one meeting.ended event');
if (after.status !== 'ended' || after.botStatus !== 'ended') problems.push(`expected status ended / botStatus ended, got ${after.status} / ${after.botStatus}`);

// A user ending the meeting from the companion panel removes the bot and ends the meeting.
const second = await json('/api/meetings', { method: 'POST', body: JSON.stringify({ title: 'Recall smoke (end)', projectId, meetingUrl: 'https://zoom.us/j/123456789' }) });
const join2 = await json(`/api/meetings/${second.meetingId}/join`, { method: 'POST', body: JSON.stringify({ name: 'Smoke Tester' }) });
// The dev injector adds a transcript line to a meeting without a live call (session token auth).
await json(`/api/dev/meetings/${second.meetingId}/transcript`, { method: 'POST', headers: { [SESSION_HEADER]: join2.sessionToken }, body: JSON.stringify({ speakerName: 'Dev', text: 'Injected line.' }) });
const injected = await json(`/api/meetings/${second.meetingId}/transcript`, { headers: { [SESSION_HEADER]: join2.sessionToken } });
if (injected.segments.length !== 1) problems.push(`dev injector: expected 1 stored segment, got ${injected.segments.length}`);
await json(`/api/meetings/${second.meetingId}/end`, { method: 'POST', headers: { [SESSION_HEADER]: join2.sessionToken } });
const after2 = await json(`/api/meetings/${second.meetingId}`);
if (second.platform !== 'zoom' || after2.status !== 'ended' || after2.botStatus !== 'ended') problems.push(`user-initiated end failed: ${second.platform} ${after2.status} / ${after2.botStatus}`);
const rejected = await fetch(`${base}/api/meetings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/x' }) });
if (rejected.status !== 400) problems.push(`Teams link should be rejected with 400, got ${rejected.status}`);
const noLink = await fetch(`${base}/api/meetings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', projectId }) });
if (noLink.status !== 400) problems.push(`a meeting without a link should be rejected with 400, got ${noLink.status}`);

ws.close();
if (problems.length) fail(problems.join('\n      '));
log('\nSMOKE OK');
process.exit(0);
